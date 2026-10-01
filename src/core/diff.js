// 三维差异引擎：结构（含移动/复制识别）、文本、样式，各自带可定位锚点。
// 输入两棵不可变树快照（base/target），输出可序列化 Patch（审批对象就是它）。
import { hashValue, canonicalJson } from './hash.js'
import { pathOf } from './tree.js'

function parentIndex(tree) {
  const parent = new Map()
  const index = new Map()
  for (const [id, node] of tree.nodes) {
    node.children.forEach((cid, i) => {
      parent.set(cid, id)
      index.set(cid, i)
    })
  }
  return { parent, index }
}

function loc(tree, id, pa) {
  const parentId = pa.parent.get(id) ?? null
  return {
    id,
    parentId,
    index: parentId ? pa.index.get(id) : -1,
    path: pathOf(tree, id),
  }
}

// 子树规模与"非平凡"判定：无操作日志佐证时，避免把雷同空段误判为复制。
function subtreeWeight(tree, id) {
  const n = tree.nodes.get(id)
  let nodes = 1
  let textLen = (n.text || '').length
  for (const c of n.children) {
    const sub = subtreeWeight(tree, c)
    nodes += sub.nodes
    textLen += sub.textLen
  }
  return { nodes, textLen }
}

function nontrivial(tree, id) {
  const w = subtreeWeight(tree, id)
  return w.nodes >= 2 || w.textLen >= 8
}

// ---- 文本 LCS（多行按行、单行按词；返回可定位 hunk）----
function tokenize(text) {
  if (text.includes('\n')) {
    const lines = text.split('\n')
    return lines.map((ln, i) => (i === lines.length - 1 ? ln : `${ln}\n`))
  }
  return text.match(/\s+|[^\s]+/g) || []
}

function lcsTable(a, b) {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1))
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  return dp
}

// 返回段序列 segments: [{type:'eq'|'del'|'ins', text}]，以及行内锚点 from/to
export function tokenDiff(oldText, newText) {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  const dp = lcsTable(a, b)
  const segments = []
  let i = 0
  let j = 0
  const push = (type, text) => {
    const last = segments[segments.length - 1]
    if (last && last.type === type) last.text += text
    else segments.push({ type, text })
  }
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('eq', a[i]); i += 1; j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', a[i]); i += 1
    } else {
      push('ins', b[j]); j += 1
    }
  }
  while (i < a.length) { push('del', a[i]); i += 1 }
  while (j < b.length) { push('ins', b[j]); j += 1 }
  return segments
}

function mapKeys(obj) {
  return obj && typeof obj === 'object' ? obj : {}
}

function diffAttrs(before, after) {
  const changes = []
  const keys = new Set([...Object.keys(mapKeys(before)), ...Object.keys(mapKeys(after))])
  for (const k of [...keys].sort()) {
    const v1 = before ? before[k] : undefined
    const v2 = after ? after[k] : undefined
    if (canonicalJson(v1) !== canonicalJson(v2)) {
      changes.push({ key: k, before: v1 ?? null, after: v2 ?? null })
    }
  }
  return changes
}

function diffMarks(before, after) {
  // 行内格式区间整体比较（按 from/to/type 对齐）
  const key = (m) => `${m.from}:${m.to}:${m.type}`
  const a = new Map((before || []).map((m) => [key(m), m]))
  const b = new Map((after || []).map((m) => [key(m), m]))
  const changes = []
  for (const [k, m] of a) {
    if (!b.has(k)) changes.push({ type: 'range-removed', range: { from: m.from, to: m.to }, mark: m.type, before: m.attrs ?? null, after: null })
    else if (canonicalJson(m.attrs) !== canonicalJson(b.get(k).attrs)) {
      changes.push({ type: 'range-restyled', range: { from: m.from, to: m.to }, mark: m.type, before: m.attrs ?? null, after: b.get(k).attrs ?? null })
    }
  }
  for (const [k, m] of b) {
    if (!a.has(k)) changes.push({ type: 'range-added', range: { from: m.from, to: m.to }, mark: m.type, before: null, after: m.attrs ?? null })
  }
  return changes
}

/**
 * @param {object} opts.provenance 操作日志佐证： Map<newNodeId, sourceNodeId>（COPY 产生）
 * @returns 序列化补丁
 */
export function diffTrees(base, target, opts = {}) {
  const provenance = opts.provenance || new Map()
  const pa = parentIndex(base)
  const pb = parentIndex(target)
  const ops = []

  const baseIds = new Set(base.nodes.keys())
  const targetIds = new Set(target.nodes.keys())

  // 目标侧新增节点 -> 内容指纹表（用于无佐证时的复制识别）
  const fingerprintBase = new Map()
  for (const id of baseIds) {
    const n = base.nodes.get(id)
    fingerprintBase.set(`${n.type}:${canonicalJson(serializeContent(base, id))}`, id)
  }

  const structureOps = []
  for (const id of targetIds) {
    if (!baseIds.has(id)) {
      const node = target.nodes.get(id)
      const fpKey = `${node.type}:${canonicalJson(serializeContent(target, id))}`
      const proven = provenance.get(id)
      const guessed = fingerprintBase.get(fpKey)
      let candidate = null
      if (proven && baseIds.has(proven)) {
        // 日志溯源权威：即使复制后又改写（指纹已变），仍标记为 copy。
        candidate = proven
      } else if (!provenance.size && guessed && targetIds.has(guessed)) {
        // 无日志佐证（只有快照的外部文稿）才退化到内容指纹启发式，
        // 且要求源节点在目标树依然存在——否则那是"删除旧节点后另建同内容新节点"。
        candidate = guessed
      }
      if (candidate && (proven || nontrivial(target, id))) {
        structureOps.push({ kind: 'copy', id, fromId: candidate, ...loc(target, id, pb) })
      } else {
        structureOps.push({ kind: 'insert', id, ...loc(target, id, pb) })
      }
    }
  }
  for (const id of baseIds) {
    if (!targetIds.has(id)) {
      // 若该节点恰好是某 copy 的来源（来源仍存在则不会到这里），删除照常报告
      structureOps.push({ kind: 'delete', id, ...loc(base, id, pa) })
    }
  }
  // 移动/重排识别：
  //  - 父节点改变 => 一定是 move（跨章节移动）。
  //  - 父节点不变但相对顺序变化 => 用 LCS 找"未移动"子序列，只有脱离序列的节点才算 reorder(move)，
  //    避免一次插入/删除导致兄弟节点 index 级联变化而误报。
  const movedIds = new Set()
  for (const id of targetIds) {
    if (!baseIds.has(id)) continue
    const fromParent = pa.parent.get(id) ?? null
    const toParent = pb.parent.get(id) ?? null
    if (fromParent !== toParent) movedIds.add(id)
  }
  const parents = new Set()
  for (const pid of pa.parent.values()) parents.add(pid)
  for (const pid of pb.parent.values()) parents.add(pid)
  for (const pid of parents) {
    const oldSeq = (base.nodes.get(pid)?.children || []).filter((cid) => targetIds.has(cid))
    const newSeq = (target.nodes.get(pid)?.children || []).filter((cid) => baseIds.has(cid))
    const dp = lcsTable(oldSeq, newSeq)
    const keep = new Set()
    let i = 0
    let j = 0
    while (i < oldSeq.length && j < newSeq.length) {
      if (oldSeq[i] === newSeq[j]) { keep.add(oldSeq[i]); i += 1; j += 1 }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1
      else j += 1
    }
    for (const cid of newSeq) {
      if (!keep.has(cid)) movedIds.add(cid)
    }
  }
  for (const id of movedIds) {
    structureOps.push({
      kind: 'move',
      id,
      from: loc(base, id, pa),
      to: loc(target, id, pb),
    })
  }

  const textOps = []
  const styleOps = []
  for (const id of targetIds) {
    const b = target.nodes.get(id)
    // 复制产生的新 id 在基准树中不存在；若有日志溯源，则以源节点作为旧内容基线，
    // 这样"复制后改写/改样式"能在 copy 之外再报告 text/style（定位到新节点自身）。
    const sourceForCopy = !baseIds.has(id) ? provenance.get(id) : null
    const a = baseIds.has(id) ? base.nodes.get(id) : (sourceForCopy && base.nodes.get(sourceForCopy))
    if (!a) continue
    if ((a.text || '') !== (b.text || '')) {
      textOps.push({
        kind: 'text',
        id,
        copiedFrom: sourceForCopy || null,
        anchor: loc(target, id, pb),
        segments: tokenDiff(a.text || '', b.text || ''),
      })
    }
    const attrChanges = diffAttrs(a.attrs, b.attrs)
    const markChanges = diffMarks(a.marks, b.marks)
    if (attrChanges.length || markChanges.length) {
      styleOps.push({
        kind: 'style',
        id,
        copiedFrom: sourceForCopy || null,
        anchor: loc(target, id, pb),
        attrChanges,
        markChanges,
      })
    }
  }

  // 结构优先排序：move > delete > insert/copy，保证回放顺序稳定
  const rank = { move: 0, delete: 1, copy: 2, insert: 3 }
  structureOps.sort((x, y) => rank[x.kind] - rank[y.kind] || x.id.localeCompare(y.id))
  ops.push(...structureOps, ...textOps, ...styleOps)

  const patch = {
    format: 'catalpa.patch/v1',
    baseSnapshot: base.snapshotId || null,
    targetSnapshot: target.snapshotId || null,
    dimensions: {
      structure: structureOps.length,
      text: textOps.length,
      style: styleOps.length,
    },
    ops,
  }
  patch.checksum = checksumOf(patch)
  return patch
}

export function checksumOf(patch) {
  const { checksum, ...rest } = patch
  return hashValue(rest)
}

function serializeContent(tree, id) {
  const n = tree.nodes.get(id)
  return {
    type: n.type,
    text: n.text ?? '',
    marks: (n.marks || []).map((m) => ({ from: m.from, to: m.to, type: m.type, attrs: m.attrs ?? {} })),
    attrs: n.attrs ?? {},
    children: n.children.map((c) => serializeContent(tree, c)),
  }
}
