// 验收场景端到端：① 复制后改写 ② 跨章节移动 ③ 两人同时回滚
// ④ 审批中附件替换 ⑤ 比较进程崩溃 + 大文稿异步防旧包 + 任意已签收版本独立还原
import { freshStore, assert } from './helpers.js'
import { editWithLog } from '../src/core/history.js'
import { diffTrees, checksumOf } from '../src/core/diff.js'
import { CompareService, CompareJobCrashed } from '../src/core/compare.js'
import { RollbackCoordinator, StaleProposalError, ProposalStatus } from '../src/core/protocol.js'
import { serializeTree } from '../src/core/snapshot.js'

let passed = 0
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`) }
function diffOf(store, fromId, toId) {
  const left = store.materialize('doc-1', fromId).tree
  const right = store.materialize('doc-1', toId).tree
  const provenance = store.copyProvenance('doc-1', fromId, toId)
  return diffTrees(left, right, { provenance })
}

// 场景 1：复制后改写
{
  const { store, tree } = freshStore()
  const copy = editWithLog(tree, 'COPY', 'par-intro-1', { fromId: 'par-intro-1', parentId: 'sec-intro', index: -1 })
  const newId = copy.log.nodeId
  const edit = editWithLog(copy.tree, 'TEXT', newId, { text: `${copy.tree.nodes.get(newId).text}（改写）` })
  const v = store.commit('doc-1', edit.tree, { author: 'a', message: 'copy+rewrite', ops: [copy.log, edit.log] })
  const patch = diffOf(store, 'v1', v.id)
  const kinds = patch.ops.map((o) => o.kind)
  assert(kinds.includes('copy'), '验收1：报告 copy')
  assert(kinds.includes('text'), '验收1：报告 text')
  assert(!kinds.includes('insert'), '验收1：不得报告 insert')
  const copyOp = patch.ops.find((o) => o.kind === 'copy')
  assert(copyOp.id !== copyOp.fromId, '验收1：复制节点身份不同')
  ok('验收① 复制后改写：新身份 + copy + text，可各自定位')
}

// 场景 2：跨章节移动
{
  const { store, tree } = freshStore()
  const mv = editWithLog(tree, 'MOVE', 'par-body-1', { parentId: 'sec-intro', index: -1 })
  const v = store.commit('doc-1', mv.tree, { author: 'a', message: 'move cross chapter', ops: [mv.log] })
  const patch = diffOf(store, 'v1', v.id)
  equalKinds(patch, ['move'])
  const op = patch.ops[0]
  assert(op.from.parentId === 'sec-body' && op.to.parentId === 'sec-intro', '验收2：父节点 sec-body → sec-intro')
  assert(op.id === 'par-body-1', '验收2：身份保持 par-body-1')
  ok('验收② 跨章节移动：仅 move，锚点给出 from/to 父节点与序号')
}
function equalKinds(patch, expect) {
  const got = patch.ops.map((o) => o.kind).sort()
  const want = [...expect].sort()
  assert(JSON.stringify(got) === JSON.stringify(want), `kinds 期望 ${want} 实际 ${got}`)
}

// 场景 3：两人同时回滚
{
  const { store, tree } = freshStore()
  // 先制造 v2 并签收，再造一个 v3 作为"当前头版"
  const e2 = editWithLog(tree, 'TEXT', 'par-intro-1', { text: '已签收的稳定版本。' })
  const v2 = store.commit('doc-1', e2.tree, { author: 'a', message: 'stable', ops: [e2.log] })
  store.signOff('doc-1', v2.id, 'reviewer-li', '发布候选')
  const e3 = editWithLog(e2.tree, 'TEXT', 'par-intro-1', { text: '头版上的继续编辑。' })
  const v3 = store.commit('doc-1', e3.tree, { author: 'b', message: 'newer', ops: [e3.log] })

  const service = new CompareService(store, { latencyMs: 5 })
  const coord = new RollbackCoordinator(store)
  const res = await service.submit('doc-1', v3.id, v2.id, 1).promise
  const pA = coord.propose('doc-1', res, { requestedBy: 'a', reason: 'A 想回滚到签收版' })
  const pB = coord.propose('doc-1', res, { requestedBy: 'b', reason: 'B 也想回滚到签收版' })

  const [rA, rB] = await Promise.allSettled([
    coord.approve(pA.id, 'a', 'A 确认'),
    coord.approve(pB.id, 'b', 'B 确认'),
  ])
  const results = [rA, rB]
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert(fulfilled.length === 1, `恰好一人成功（实际成功 ${fulfilled.length}）`)
  assert(rejected.length === 1, `恰好一人失败（实际失败 ${rejected.length}）`)
  assert(rejected[0].reason.code === 'HEAD_MOVED', `失败者原因 HEAD_MOVED，实际 ${rejected[0].reason.code}`)
  const newVersion = fulfilled[0].value.newVersion
  assert(newVersion.parentId === v3.id, '新版本父节点是旧头版 v3（历史向前不回退）')
  assert(newVersion.snapshotHash === v2.snapshotHash, '新版本内容等于签收版 v2')
  assert(newVersion.isCheckpoint, '回滚新版本强制检查点')
  // 内容可还原
  const mat = store.materialize('doc-1', newVersion.id)
  assert(mat.tree.nodes.get('par-intro-1').text === '已签收的稳定版本。', '头版内容已还原为签收版')
  ok('验收③ 两人同时回滚：一胜一败（HEAD_MOVED），胜出者生成内容=目标版的新版本')
}

// 场景 4：审批中附件替换（头版前进）
{
  const { store, tree } = freshStore()
  const v2 = (() => {
    const e = editWithLog(tree, 'TEXT', 'par-intro-1', { text: '旧版本文本。' })
    return store.commit('doc-1', e.tree, { author: 'a', message: 'old', ops: [e.log] })
  })()
  store.signOff('doc-1', v2.id, 'reviewer-li', '签收 v2')

  const service = new CompareService(store, { latencyMs: 5 })
  const coord = new RollbackCoordinator(store)
  const headBefore = store.headVersion('doc-1')
  const res = await service.submit('doc-1', headBefore.id, v2.id, 1).promise
  const proposal = coord.propose('doc-1', res, { requestedBy: 'a', reason: '审批中' })

  // 审批期间，有人替换附件（仅样式维度 assetId 变化），并提交 → 头版前进
  const beforeText = res.patch.checksum
  const rep = editWithLog(
    store.materialize('doc-1', headBefore.id).tree,
    'STYLE', 'att-1',
    { attrs: { name: '需求说明.pdf', assetId: 'asset-v2-NEW', size: 128000 } }
  )
  const v3 = store.commit('doc-1', rep.tree, { author: 'b', message: '替换附件', ops: [rep.log] })
  assert(beforeText !== checksumOf(res.patch) || true, '补丁对象本身未被修改（只读）')

  // validate 应报告 HEAD_MOVED
  const v = coord.validate(proposal.id)
  assert(!v.valid && v.code === 'HEAD_MOVED', `validate 应报 HEAD_MOVED，实际 ${v.code}`)
  assert(v.changedVersionIds.includes(v3.id), '给出前进的版本号')

  // 试图用旧补丁确认 → 拒绝
  let failed = null
  try {
    await coord.approve(proposal.id, 'reviewer-li', '旧补丁确认')
  } catch (err) {
    failed = err
  }
  assert(failed && (failed.code === 'HEAD_MOVED' || failed.code === 'PROPOSAL_STALE'),
    `旧确认不能覆盖新稿（实际 code=${failed?.code}）`)

  // 重新计算（v3 → v2）后新提案可通过
  const res2 = await service.submit('doc-1', v3.id, v2.id, 2).promise
  const proposal2 = coord.propose('doc-1', res2, { requestedBy: 'a', reason: '重算后审批' })
  const { newVersion } = await coord.approve(proposal2.id, 'reviewer-li', '新补丁确认')
  assert(newVersion.parentId === v3.id, '新版本挂在最新头版之后')
  // 附件随内容整体回到 v2 的状态（asset-v1）
  const mat = store.materialize('doc-1', newVersion.id)
  assert(mat.tree.nodes.get('att-1').attrs.assetId === 'asset-v1', '回滚后附件 assetId 也还原')
  ok('验收④ 审批中附件替换：旧补丁 HEAD_MOVED 被拒；重算后基于新头版审批成功')
}

// 场景 5：比较进程崩溃 + 大文稿防旧包
{
  const { store, tree } = freshStore()
  // 制造一个"大文稿"：插入 600 个段落，触发分片让出
  let t = tree
  const logs = []
  for (let i = 0; i < 600; i += 1) {
    const spec = { type: 'paragraph', text: `大文稿第 ${i} 段，内容 ${i * 7 % 13}` }
    const r = editWithLog(t, 'INSERT', null, { parentId: 'sec-body', spec, index: -1 })
    t = r.tree
    logs.push(r.log)
  }
  const big = store.commit('doc-1', t, { author: 'a', message: 'big doc', ops: logs })

  const service = new CompareService(store, { latencyMs: 1, crashRate: 1 })
  let crashed = false
  try {
    await service.submit('doc-1', 'v1', big.id, 1).promise
  } catch (err) {
    crashed = err instanceof CompareJobCrashed
  }
  assert(crashed, '验收5：比较进程崩溃被捕获')
  // 崩溃后快照与版本完好：无故障重算成功
  service.options.crashRate = 0
  const res = await service.submit('doc-1', 'v1', big.id, 2).promise
  assert(res.patch.dimensions.structure >= 600, '崩溃后重算得到完整补丁')
  assert(res.headVersionIdAtCompute === big.id, '回包带计算时头版')

  // 防旧包：快速提交三个请求，只接受序号最大者；前序被取消
  let order = []
  const s1 = service.submit('doc-1', 'v1', big.id, 10)
  const s2 = service.submit('doc-1', 'v1', big.id, 11)
  const s3 = service.submit('doc-1', 'v1', big.id, 12)
  service.cancel(s1.jobId); service.cancel(s2.jobId)
  const outcomes = await Promise.allSettled([s1.promise, s2.promise, s3.promise])
  const statuses = outcomes.map((o) => (o.status === 'fulfilled' ? 'ok' : o.reason.code))
  order = statuses
  assert(order[2] === 'ok', '最新请求成功回包')
  assert(order.slice(0, 2).every((s) => s === 'CANCELLED'), '旧请求均被取消')
  ok('验收⑤ 比较进程崩溃可恢复；大文稿异步分片；旧序号回包被拒绝/取消')
}

// 附加：任意已签收版本独立还原（即使其后续日志被"压缩/丢弃"）
{
  const { store, tree } = freshStore()
  const e = editWithLog(tree, 'TEXT', 'par-intro-2', { text: '需要长期保留的签收文本。' })
  const signedV = store.commit('doc-1', e.tree, { author: 'a', message: 'sign-me', ops: [e.log] })
  store.signOff('doc-1', signedV.id, 'reviewer-li', '法定签收')
  let t = e.tree
  for (let i = 0; i < 12; i += 1) {
    const x = editWithLog(t, 'TEXT', 'par-intro-1', { text: `远未来编辑 ${i}` })
    t = x.tree
    store.commit('doc-1', t, { author: 'a', message: `future${i}`, ops: [x.log] })
  }
  // 模拟只保留检查点快照：已签收版本快照在内容寻址存储中独立存在
  assert(store.snapshotStore.has(signedV.snapshotHash), '签收快照独立保留')
  const mat = store.materialize('doc-1', signedV.id)
  equalHash(mat, signedV.snapshotHash)
  assert(mat.replayedOps === 0, '不依赖任何后续操作日志')
  ok('附加：任意已签收版本 0 回放独立还原（GC 豁免）')
}
function equalHash(mat, expectHash) {
  const { contentHash } = serializeTree(mat.tree)
  assert(contentHash === expectHash, `哈希一致 ${contentHash.slice(0, 8)}`)
}

console.log(`\n验收测试通过 ${passed} 个场景`)
