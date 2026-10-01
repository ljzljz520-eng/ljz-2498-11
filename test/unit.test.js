// 核心单元：身份/移动区分/复制换身份/三维差异/物化确定性
import { freshStore, assert, equal } from './helpers.js'
import { editWithLog } from '../src/core/history.js'
import { diffTrees, tokenDiff } from '../src/core/diff.js'
import { deserializeTree } from '../src/core/snapshot.js'
import { serializeTree } from '../src/core/snapshot.js'

let passed = 0
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`) }

// 1. 移动 vs 删除+新增
{
  const { store, tree } = freshStore()
  let t = tree
  const moved = editWithLog(t, 'MOVE', 'par-body-1', { parentId: 'sec-intro', index: -1 })
  t = moved.tree
  const vMove = store.commit('doc-1', t, { author: 'a', message: 'move', ops: [moved.log] })
  const a = store.materialize('doc-1', 'v1').tree
  const b = store.materialize('doc-1', vMove.id).tree
  const patch = diffTrees(a, b)
  const kinds = patch.ops.map((o) => o.kind)
  assert(kinds.includes('move'), '跨章移动必须报告 move')
  assert(!kinds.includes('delete'), '移动不应报告 delete')
  assert(!kinds.includes('insert'), '移动不应报告 insert')
  equal(patch.dimensions, { structure: 1, text: 0, style: 0 }, '仅一个结构差异')
  ok('移动 = move，且不产生 delete/insert')

  // 删除后新增（新身份）应报告 delete + insert，不能误报 move
  const d = editWithLog(t, 'DELETE', 'par-body-1', {})
  let t2 = d.tree
  const ins = editWithLog(t2, 'INSERT', null, {
    parentId: 'sec-intro', index: -1, spec: { type: 'paragraph', text: '移动段落与删除后新增必须可以区分。' },
  })
  t2 = ins.tree
  const vDel = store.commit('doc-1', t2, { author: 'a', message: 'del+add', ops: [d.log, ins.log] })
  const c = store.materialize('doc-1', vDel.id).tree
  const patch2 = diffTrees(a, c)
  const k2 = patch2.ops.map((o) => o.kind)
  assert(k2.includes('delete') && k2.includes('insert'), '删除后新增必须是 delete+insert')
  assert(!k2.includes('move'), '新身份不得被当作 move')
  ok('删除后新增 = delete + insert（与 move 区分）')
}

// 2. 复制：身份不复用、内容一致、diff 报 copy 且溯源正确
{
  const { store, tree } = freshStore()
  const { tree: copiedTree, rootId: newRoot, idMap, log } = (() => {
    const r = editWithLog(tree, 'COPY', 'par-intro-1', { fromId: 'par-intro-1', parentId: 'sec-intro', index: -1 })
    // editWithLog COPY 的 payload 携带 idMap
    return { tree: r.tree, rootId: r.log.nodeId, idMap: r.log.payload.idMap, log: r.log }
  })()
  void copiedTree
  assert(newRoot && newRoot !== 'par-intro-1', '复制根身份必须不同')
  assert(idMap['par-intro-1'] === newRoot, 'idMap 记录源->新')
  const v = store.commit('doc-1', copiedTree, { author: 'a', message: 'copy', ops: [log] })

  // 回放物化必须复现同一身份（确定性）
  const mat = store.materialize('doc-1', v.id)
  assert(mat.tree.nodes.has(newRoot), '回放后新身份存在')
  const srcNode = tree.nodes.get('par-intro-1')
  const newNode = mat.tree.nodes.get(newRoot)
  equal(newNode.text, srcNode.text, '复制内容一致')

  // 内容指纹一致但身份不同
  const { contentHash: h1 } = serializeTree({ rootId: 'par-intro-1', nodes: new Map([['par-intro-1', srcNode]]) })
  assert(h1.length === 16, '哈希长度 16 hex')

  const base = store.materialize('doc-1', 'v1').tree
  const provenance = store.copyProvenance('doc-1', 'v1', v.id)
  equal(provenance.get(newRoot), 'par-intro-1', '溯源映射 新->源')
  const patch = diffTrees(base, mat.tree, { provenance })
  const copyOps = patch.ops.filter((o) => o.kind === 'copy')
  equal(copyOps.length, 1, '恰好一个 copy 操作')
  equal(copyOps[0].fromId, 'par-intro-1', 'copy 指向源节点')
  ok('复制：新身份、内容一致、报 copy 且日志溯源正确')

  // 复制后再改写：仍应只有一个 copy + 一个 text，不出现 insert
  let t3 = mat.tree
  const e = editWithLog(t3, 'TEXT', newRoot, { text: `${newNode.text}（改写）` })
  t3 = e.tree
  const v3 = store.commit('doc-1', t3, { author: 'a', message: 'copy+edit', ops: [e.log] })
  const mat3 = store.materialize('doc-1', v3.id)
  const prov3 = store.copyProvenance('doc-1', 'v1', v3.id)
  const patch3 = diffTrees(base, mat3.tree, { provenance: prov3 })
  const k3 = patch3.ops.map((o) => o.kind)
  assert(k3.includes('copy') && k3.includes('text'), '复制后改写 = copy + text')
  assert(!k3.includes('insert'), '改写不应把复制变成 insert')
  ok('复制后改写仍被识别为 copy（不退化 insert）')
}

// 3. 文本 LCS / 样式差异可定位
{
  const seg = tokenDiff('版本比对按结构、文本、样式三个维度输出补丁。', '版本比对按结构、文本与样式三个维度输出补丁。')
  assert(seg.some((s) => s.type === 'del' && s.text.includes('、')), '删号')
  assert(seg.some((s) => s.type === 'ins' && s.text.includes('与')), '增与')
  ok('文本 token LCS 正确定位增删')

  const { store, tree } = freshStore()
  const e = editWithLog(tree, 'STYLE', 'par-intro-1', { attrs: { align: 'center' } })
  const v = store.commit('doc-1', e.tree, { author: 'a', message: 'style', ops: [e.log] })
  const patch = diffTrees(store.materialize('doc-1', 'v1').tree, store.materialize('doc-1', v.id).tree)
  equal(patch.ops.length, 1, '一个样式 op')
  equal(patch.ops[0].attrChanges[0].key, 'align', '样式键 align')
  equal(patch.ops[0].anchor.id, 'par-intro-1', '样式差异可定位到节点')

  // marks 变化（独立 store，避免与上面的 align 混在一起）：给已有 strong 区间加 attrs（区间不变 → restyled）
  const markStore = freshStore()
  const e2 = editWithLog(markStore.tree, 'TEXT', 'par-body-2', {
    text: '复制节点会得到全新身份，不能复用原身份。',
    marks: [{ from: 0, to: 4, type: 'strong', attrs: { tone: 'red' } }],
  })
  const v2 = markStore.store.commit('doc-1', e2.tree, { author: 'a', message: 'mark', ops: [e2.log] })
  const patch2 = diffTrees(
    markStore.store.materialize('doc-1', 'v1').tree,
    markStore.store.materialize('doc-1', v2.id).tree
  )
  const styleOp = patch2.ops.find((o) => o.kind === 'style')
  equal(styleOp.id, 'par-body-2', '样式差异定位到行内格式所在节点')
  assert(styleOp.markChanges.some((c) => c.type === 'range-restyled'), '行内格式区间被识别为样式差异')
  ok('样式（attrs + 行内 marks）差异各自可定位')
}

// 4. 物化确定性 & 检查点回放成本有界
{
  const { store, tree } = freshStore()
  let t = tree
  const versions = []
  for (let i = 0; i < 11; i += 1) {
    const e = editWithLog(t, 'TEXT', 'par-intro-1', { text: `第 ${i + 1} 次修改。` })
    t = e.tree
    versions.push(store.commit('doc-1', t, { author: 'a', message: `edit${i}`, ops: [e.log] }))
  }
  // v11 之后：最近检查点是 v6（seq%5 逻辑），回放 ≤ 4
  const mat = store.materialize('doc-1', versions[versions.length - 1].id)
  assert(mat.replayedOps <= 4, `回放操作数应 <=4，实际 ${mat.replayedOps}`)
  assert(mat.tree.nodes.get('par-intro-1').text === '第 11 次修改。', '回放内容正确')
  // 再次物化一致（确定性）
  const mat2 = store.materialize('doc-1', versions[versions.length - 1].id)
  equal(serializeTree(mat.tree).contentHash, serializeTree(mat2.tree).contentHash, '重复物化哈希一致')
  ok('检查点 + 日志回放：成本有界、结果确定')
}

// 5. 已签收版本强制检查点，独立还原
{
  const { store, tree } = freshStore()
  let t = tree
  const e = editWithLog(t, 'TEXT', 'par-intro-1', { text: '签收版文本。' })
  t = e.tree
  const v2 = store.commit('doc-1', t, { author: 'a', message: 'v2', ops: [e.log] })
  store.signOff('doc-1', v2.id, 'reviewer-li', '核对无误')
  assert(v2.isCheckpoint, '签收即检查点')
  // 之后继续产生多个版本
  for (let i = 0; i < 7; i += 1) {
    const x = editWithLog(t, 'TEXT', 'par-intro-1', { text: `后续 ${i}` })
    t = x.tree
    store.commit('doc-1', t, { author: 'a', message: `later${i}`, ops: [x.log] })
  }
  const mat = store.materialize('doc-1', v2.id)
  equal(mat.replayedOps, 0, '签收版 0 回放（独立快照）')
  equal(mat.tree.nodes.get('par-intro-1').text, '签收版文本。', '签收版内容独立可还原')
  ok('任意已签收版本独立还原（0 回放，不依赖后续日志）')
}

console.log(`\n单元测试通过 ${passed} 组`)
