/**
 * 补丁引擎：比较两棵【已冻结】文稿树，产出按段落定位的 hunk 列表。
 *
 * 判定原则（身份 vs 内容分离）：
 *   1. 同 id 同时存在于两版           -> modify / move（绝不可能是“删除后新增”）
 *   2. id 仅在旧版                    -> delete
 *   3. id 仅在新版：
 *        a. 内容 hash 命中旧版某节点   -> insert(copy)         复制，身份全新
 *        b. 高相似文本命中旧版节点      -> insert(copy+改写)
 *        c. 其余                      -> insert(新增)
 *   4. move 的判定 = 同 id 但所属章节变化，或同章幸存节点相对次序变化
 *
 * 每个 hunk 必须且只能归属一类：text（文本）/ style（样式）/ structure（结构），
 * 三者各自携带 nodeId + path，前端可分别高亮、分别定位。
 */
import { contentHash } from './tree'

export function hashString(str) {
  let h1 = 0x9e3779b9
  let h2 = 0x9e3779b9
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/* ---------------- 行内文本 diff（LCS，按词/字分词） ---------------- */

function tokenize(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)].map((s) => s.segment)
  }
  return Array.from(text)
}

export function lineDiff(a, b) {
  const A = tokenize(a || '')
  const B = tokenize(b || '')
  const n = A.length
  const m = B.length
  // LCS DP
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const tokens = []
  let i = 0
  let j = 0
  const push = (t, text) => {
    const last = tokens[tokens.length - 1]
    if (last && last.t === t) last.text += text
    else tokens.push({ t, text })
  }
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push('eq', A[i]); i++; j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', A[i]); i++
    } else {
      push('ins', B[j]); j++
    }
  }
  while (i < n) { push('del', A[i]); i++ }
  while (j < m) { push('ins', B[j]); j++ }
  return tokens.filter((x) => x.text)
}

function similarity(a, b) {
  if (!a || !b) return 0
  // 段落级 LCS（字符），按平均长度归一（Sørensen 风格），对“复制后追加/改写”友好
  const n = Math.min(a.length, 200)
  const m = Math.min(b.length, 200)
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  return (dp[0][0] * 2) / (n + m)
}

/* ---------------- 树扫描 ---------------- */

function flatten(root) {
  // 章节信息 + 文档序扁平块
  const sections = new Map() // sectionId -> {node, path, rank}
  const blocks = []
  root.children.forEach((sec, si) => {
    if (sec.kind !== 'section') return
    sections.set(sec.id, { node: sec, path: [si], rank: si })
    sec.children.forEach((node, bi) => {
      blocks.push({ node, sectionId: sec.id, index: bi, path: [si, bi] })
    })
  })
  return { sections, blocks }
}

function textOf(node) {
  if (node.kind === 'p') return node.text
  if (node.kind === 'attachment') return node.name
  return node.title || ''
}

function summarize(node) {
  if (node.kind === 'attachment') return `📎 ${node.name} @${node.blobHash.slice(0, 8)}`
  const t = textOf(node)
  return t.length > 40 ? `${t.slice(0, 40)}…` : t
}

function markDiff(a = [], b = []) {
  const A = new Set(a)
  const B = new Set(b)
  return { removed: a.filter((x) => !B.has(x)), added: b.filter((x) => !A.has(x)) }
}

let seq = 0
function hunk(base) {
  return { id: `h${(seq += 1)}_${Date.now().toString(36).slice(-4)}`, ...base }
}

/**
 * 主入口
 * @returns {{hunks: Array[], counts: {text:number,style:number,structure:number}}}
 */
export function diffTrees(oldRoot, newRoot) {
  const oldF = flatten(oldRoot)
  const newF = flatten(newRoot)
  const oldMap = new Map(oldF.blocks.map((b) => [b.node.id, b]))
  const newMap = new Map(newF.blocks.map((b) => [b.node.id, b]))
  const oldSecMap = oldF.sections
  const newSecMap = newF.sections
  const hunks = []

  const usedSources = new Set()

  /* ---------- 章节：增 / 删 / 改标题 / 改样式 / 调序 ---------- */
  const commonSecIds = [...oldSecMap.keys()].filter((id) => newSecMap.has(id))
  commonSecIds.forEach((id, rankNow) => {
    const o = oldSecMap.get(id)
    const nw = newSecMap.get(id)
    if (o.rank !== rankNow) {
      hunks.push(hunk({
        type: 'structure', op: 'move', nodeId: id, blockKind: 'section',
        sectionId: id, oldPath: o.path, newPath: nw.path,
        oldParentId: null, newParentId: null,
        oldSummary: summarize(o.node), newSummary: summarize(nw.node),
      }))
    }
    if ((o.node.title || '') !== (nw.node.title || '')) {
      hunks.push(hunk({
        type: 'text', op: 'modify', nodeId: id, blockKind: 'section-title',
        sectionId: id, oldPath: o.path, newPath: nw.path,
        tokens: lineDiff(o.node.title, nw.node.title),
        oldSummary: o.node.title, newSummary: nw.node.title,
      }))
    }
    const md = markDiff(o.node.marks, nw.node.marks)
    if (md.added.length || md.removed.length) {
      hunks.push(hunk({
        type: 'style', op: 'modify', nodeId: id, blockKind: 'section',
        sectionId: id, oldPath: o.path, newPath: nw.path,
        removedMarks: md.removed, addedMarks: md.added,
      }))
    }
  })
  ;[...oldSecMap.keys()].filter((id) => !newSecMap.has(id)).forEach((id) => {
    const o = oldSecMap.get(id)
    hunks.push(hunk({
      type: 'structure', op: 'section-delete', nodeId: id, blockKind: 'section',
      sectionId: id, oldPath: o.path, newPath: null,
      oldSummary: summarize(o.node), newSummary: null,
    }))
  })
  ;[...newSecMap.keys()].filter((id) => !oldSecMap.has(id)).forEach((id) => {
    const nw = newSecMap.get(id)
    hunks.push(hunk({
      type: 'structure', op: 'section-add', nodeId: id, blockKind: 'section',
      sectionId: id, oldPath: null, newPath: nw.path,
      oldSummary: null, newSummary: summarize(nw.node),
    }))
  })

  /* ---------- 块：同 id 的修改 / 移动 ---------- */
  // 各章内“幸存块”的相对次序，用于区分 move 与插入导致的下标平移
  const oldOrder = new Map() // sectionId -> [nodeId]
  const newOrder = new Map()
  oldF.blocks.forEach((b) => {
    if (newMap.has(b.node.id)) {
      if (!oldOrder.has(b.sectionId)) oldOrder.set(b.sectionId, [])
      oldOrder.get(b.sectionId).push(b.node.id)
    }
  })
  newF.blocks.forEach((b) => {
    if (oldMap.has(b.node.id)) {
      if (!newOrder.has(b.sectionId)) newOrder.set(b.sectionId, [])
      newOrder.get(b.sectionId).push(b.node.id)
    }
  })

  for (const [id, nb] of newMap) {
    const ob = oldMap.get(id)
    if (!ob) continue // 新增类，稍后处理
    const movedChapter = ob.sectionId !== nb.sectionId
    const oldRank = (oldOrder.get(ob.sectionId) || []).indexOf(id)
    const newRank = (newOrder.get(nb.sectionId) || []).indexOf(id)
    const reordered = !movedChapter && oldRank !== newRank
    if (movedChapter || reordered) {
      hunks.push(hunk({
        type: 'structure', op: 'move', nodeId: id, blockKind: ob.node.kind,
        sectionId: nb.sectionId,
        oldPath: ob.path, newPath: nb.path,
        oldParentId: ob.sectionId, newParentId: nb.sectionId,
        oldSummary: summarize(ob.node), newSummary: summarize(nb.node),
      }))
    }

    // 附件：blob 变化是【结构/资源】差异，名称变化是文本差异
    if (ob.node.kind === 'attachment') {
      if (ob.node.blobHash !== nb.node.blobHash || ob.node.size !== nb.node.size) {
        hunks.push(hunk({
          type: 'structure', op: 'attachment-replaced', nodeId: id, blockKind: 'attachment',
          sectionId: nb.sectionId, oldPath: ob.path, newPath: nb.path,
          oldSummary: summarize(ob.node), newSummary: summarize(nb.node),
        }))
      }
      if (ob.node.name !== nb.node.name) {
        hunks.push(hunk({
          type: 'text', op: 'modify', nodeId: id, blockKind: 'attachment-name',
          sectionId: nb.sectionId, oldPath: ob.path, newPath: nb.path,
          tokens: lineDiff(ob.node.name, nb.node.name),
        }))
      }
    } else if (ob.node.kind === 'p') {
      if ((ob.node.text || '') !== (nb.node.text || '')) {
        hunks.push(hunk({
          type: 'text', op: 'modify', nodeId: id, blockKind: 'p',
          sectionId: nb.sectionId, oldPath: ob.path, newPath: nb.path,
          tokens: lineDiff(ob.node.text, nb.node.text),
        }))
      }
    }

    const md = markDiff(ob.node.marks, nb.node.marks)
    if (md.added.length || md.removed.length) {
      hunks.push(hunk({
        type: 'style', op: 'modify', nodeId: id, blockKind: ob.node.kind,
        sectionId: nb.sectionId, oldPath: ob.path, newPath: nb.path,
        removedMarks: md.removed, addedMarks: md.added,
      }))
    }
  }

  /* ---------- 删除 ---------- */
  for (const [id, ob] of oldMap) {
    if (newMap.has(id)) continue
    hunks.push(hunk({
      type: 'structure', op: 'delete', nodeId: id, blockKind: ob.node.kind,
      sectionId: ob.sectionId, oldPath: ob.path, newPath: null,
      oldSummary: summarize(ob.node), newSummary: null,
    }))
  }

  /* ---------- 新增 / 复制 / 复制后改写 ---------- */
  for (const [id, nb] of newMap) {
    if (oldMap.has(id)) continue
    const newHash = contentHash(nb.node)
    let source = null
    let copied = false
    for (const ob of oldF.blocks) {
      if (usedSources.has(ob.node.id)) continue
      if (contentHash(ob.node) === newHash) { source = ob; copied = true; break
      }
    }
    let tokens = null
    if (!source && nb.node.kind !== 'attachment') {
      let best = null
      let bestScore = 0
      for (const ob of oldF.blocks) {
        if (ob.node.kind !== nb.node.kind || usedSources.has(ob.node.id)) continue
        const score = similarity(textOf(ob.node), textOf(nb.node))
        if (score > bestScore) { bestScore = score; best = ob }
      }
      if (best && bestScore >= 0.6) {
        source = best
        copied = true
        tokens = lineDiff(textOf(best.node), textOf(nb.node))
      }
    }
    if (source) usedSources.add(source.node.id)
    hunks.push(hunk({
      type: 'structure', op: 'insert', nodeId: id, blockKind: nb.node.kind,
      sectionId: nb.sectionId, oldPath: null, newPath: nb.path,
      oldSummary: null, newSummary: summarize(nb.node),
      copied,
      likeCopyOf: source ? source.node.id : null,
      ...(tokens ? { tokens } : {}),
    }))
  }

  // 文档顺序排序（按新路径优先，缺失则旧路径）
  const keyOf = (h) => {
    const p = h.newPath || h.oldPath || []
    return p.join('.')
  }
  hunks.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1))

  const counts = { text: 0, style: 0, structure: 0 }
  hunks.forEach((h) => { counts[h.type] += 1 })
  return { hunks, counts }
}

/** 补丁整体 hash：审批人确认的就是这个字节序列，服务端重算校验防篡改 */
export function patchHash(patch) {
  const canon = {
    fromRootHash: patch.fromRootHash,
    toRootHash: patch.toRootHash,
    hunks: patch.hunks.map((h) => ({
      type: h.type, op: h.op, nodeId: h.nodeId,
      oldPath: h.oldPath, newPath: h.newPath,
      tokens: (h.tokens || []).map((t) => `${t.t}:${t.text}`).join('|'),
      removedMarks: h.removedMarks || [], addedMarks: h.addedMarks || [],
      copied: !!h.copied, likeCopyOf: h.likeCopyOf || null,
      oldSummary: h.oldSummary || '', newSummary: h.newSummary || '',
    })),
  }
  return hashString(JSON.stringify(canon))
}

export function buildPatch(oldRoot, newRoot, fromVersionId, toVersionId) {
  const { hunks, counts } = diffTrees(oldRoot, newRoot)
  const patch = {
    fromVersionId,
    toVersionId,
    fromRootHash: contentHash(oldRoot),
    toRootHash: contentHash(newRoot),
    hunks,
    counts,
    createdAt: Date.now(),
  }
  patch.patchHash = patchHash(patch)
  return patch
}

export function pathLabel(h) {
  const p = h.newPath || h.oldPath
  if (!p) return ''
  return p.map((x, i) => (i === 0 ? `第${x + 1}章` : `§${x + 1}`)).join(' / ')
}
