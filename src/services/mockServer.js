/**
 * 内存版「文稿版本服务 + 比对服务」演示实现。
 *
 * 每个方法的调用边界等价于一次 HTTP/RPC 请求；
 * 带 ★ 的方法等价于一个 PG 事务（行级锁 + 乐观并发），真实 SQL 见 server/schema.sql。
 * 浏览器里没有真正的并发线程，用 await 让出事件循环来制造交错。
 */
import {
  rootHash, cloneTree, deepFreeze, totalBlocks, makeP, makeSection,
} from '../versioning/tree'
import { buildPatch, hashString } from '../versioning/diff'

const LATENCY = 260

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------- 种子文稿 ------------------------- */

function seed() {
  const v1Root = deepFreeze({
    kind: 'root',
    id: 'root',
    children: [
      makeSection('第一章 总则', [
        makeP('本规范规定文稿台版本管理的基本要求。', 'p_intro'),
        makeP('所有正式版本必须经过签收方可用于发布。', 'p_sign'),
      ], 's_1'),
      makeSection('第二章 编辑约定', [
        makeP('段落是最小定位单元，样式与文本分离存储。', 'p_para'),
        makeP('移动段落不得被识别为删除后新增。', 'p_move_rule'),
        makeP('复制节点必须获得全新身份。', 'p_copy_rule'),
        { kind: 'attachment', id: 'att_form', name: '表单模板.docx', blobHash: 'b1f1e9a0c2', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 18204, marks: [] },
      ], 's_2'),
    ],
  })

  // v2：跨章节移动 p_move_rule 到第一章；复制 p_copy_rule 并改写；
  //     文本修改 p_intro；给 p_sign 加 bold；替换章节标题
  const v2 = cloneTree(v1Root)
  const ch1 = v2.children[0]
  const ch2 = v2.children[1]
  const moveNode = ch2.children.find((x) => x.id === 'p_move_rule')
  ch2.children = ch2.children.filter((x) => x.id !== 'p_move_rule')
  ch1.children.push(moveNode)
  // 复制 => 新身份（用 copyWithNewIdentity 语义，这里手工保证新 id）
  const copied = structuredClone(ch2.children.find((x) => x.id === 'p_copy_rule'))
  copied.id = 'p_copy_rewrite'
  copied.text = '复制节点必须获得全新身份，复制后允许独立改写。'
  ch2.children.push(copied)
  ch1.children[0].text = '本规范规定文稿台版本管理、比对与回滚的基本要求。'
  ch1.children.find((x) => x.id === 'p_sign').marks = ['bold']
  ch2.title = '第二章 编辑与差异约定'
  const v2Root = deepFreeze(v2)

  return { v1Root, v2Root }
}

/* ------------------------- 服务状态 ------------------------- */

class ManuscriptService {
  constructor() {
    this.reset()
  }

  reset() {
    const { v1Root, v2Root } = seed()
    this.docId = 'doc_demo'
    this.versions = [
      { id: 'v1', number: 1, kind: 'commit', root: v1Root, rootHash: rootHash(v1Root),
        message: '初始稿', author: '作者A', parentId: null, createdAt: Date.now() - 1000 * 60 * 60 * 26 },
      { id: 'v2', number: 2, kind: 'commit', root: v2Root, rootHash: rootHash(v2Root),
        message: '结构调整：跨章移动、复制改写、文本与样式修订', author: '作者A', parentId: 'v1',
        createdAt: Date.now() - 1000 * 60 * 60 * 2 },
    ]
    this.headId = 'v2'
    this.signoffs = [
      { id: 'so1', versionId: 'v1', by: '总编', reason: '基线版本，内容完整，签收归档。', at: Date.now() - 1000 * 60 * 60 * 20 },
    ]
    this.rollbacks = [] // 回滚工单（审批单）
    this.jobs = new Map()
    this.crashNext = false
    this.opSeq = 0
    this.oplog = []
    this.checkpoints = []

    this.versions.forEach((v) => {
      this.#appendLog('checkpoint', v.author, { versionId: v.id, rootHash: v.rootHash })
      this.checkpoints.push({ versionId: v.id, rootHash: v.rootHash, opSeq: this.opSeq })
    })
  }

  #appendLog(op, actor, detail) {
    this.opSeq += 1
    const prev = this.oplog[this.oplog.length - 1]
    const checksum = hashString(`${prev ? prev.checksum : 'GENESIS'}:${this.opSeq}:${JSON.stringify(detail)}`)
    this.oplog.push({ seq: this.opSeq, ts: Date.now(), actor, op, detail, checksum })
  }

  #version(id) {
    const v = this.versions.find((x) => x.id === id)
    if (!v) { const e = new Error('版本不存在'); e.code = 'NO_VERSION'; throw e }
    return v
  }

  /* ================= 读接口 ================= */

  async listVersions() {
    await wait(LATENCY / 2)
    return this.versions.map((v) => this.#summary(v))
  }

  /** 比较服务读取：返回冻结快照，调用方无法改写 */
  async getSnapshot(versionId) {
    await wait(LATENCY / 3)
    return this.#version(versionId).root
  }

  async getDraftBase() {
    await wait(100)
    return this.#version(this.headId).root
  }

  async oplogView() {
    return this.oplog.map((x) => ({ ...x }))
  }

  /**
   * 恢复成本诊断：
   * 方案A 整树快照 -> 任意版本 0 次重放（内容寻址对象可去重共享）；
   * 方案B 纯操作日志 -> 需从 v1 顺序重放；
   * 这里两者都维护：检查点指向快照，日志用于审计与增量订阅。
   */
  recoveryInfo(versionId) {
    const v = this.#version(versionId)
    const cp = [...this.checkpoints].reverse().find((c) => c.versionId === versionId)
    return {
      strategy: 'snapshot(checkpoint) + oplog',
      replayOps: cp ? 0 : this.opSeq,
      snapshotBlocks: totalBlocks(v.root),
      rootHash: v.rootHash,
      note: cp ? '命中检查点：直接装载不可变树快照，零重放' : '无检查点：需从最近检查点重放操作日志',
    }
  }

  /* ================= ★ 提交新版本 ================= */

  /**
   * ★ 事务：INSERT version + 推进 head。
   * head 一旦推进，所有 baseHeadId 过期的待审批回滚立即作废（superseded）；
   * 即便前端漏看作废状态，approve 时仍有乐观锁二次拦截。
   */
  async commitDraft({ root, message, author }) {
    await wait(LATENCY)
    const frozen = deepFreeze(cloneTree(root))
    const rh = rootHash(frozen)
    if (this.versions.some((v) => v.rootHash === rh)) {
      const e = new Error('内容与现有版本完全相同，已拒绝创建冗余版本'); e.code = 'DUP_VERSION'; throw e
    }
    const parentId = this.headId
    const number = this.versions.length + 1
    const id = `v${number}_${Math.random().toString(36).slice(2, 6)}`
    const version = {
      id, number, kind: 'commit', root: frozen, rootHash: rh,
      message: message || '（无提交说明）', author: author || '匿名',
      parentId, createdAt: Date.now(),
    }
    this.versions.push(version)
    this.headId = id
    this.#appendLog('commit', author, { versionId: id, parentId, rootHash: rh })
    this.checkpoints.push({ versionId: id, rootHash: rh, opSeq: this.opSeq })

    const stale = this.rollbacks.filter((r) => r.state === 'pending' && r.baseHeadId !== id)
    stale.forEach((r) => {
      r.state = 'superseded'
      r.supersedeReason = '审批期间产生新版本，补丁基线已过期，需重新发起'
      r.closedAt = Date.now()
      this.#appendLog('rollback-superseded', 'system', { rollbackId: r.id, newHead: id })
    })
    return { version: this.#summary(version), superseded: stale.map((r) => r.id) }
  }

  /* ================= 签收 ================= */

  async signoff(versionId, { by, reason }) {
    await wait(LATENCY / 2)
    this.#version(versionId)
    if (!reason || !reason.trim()) {
      const e = new Error('签收必须填写理由'); e.code = 'BAD_REASON'; throw e
    }
    const so = { id: `so_${Math.random().toString(36).slice(2, 7)}`, versionId, by: by || '审批人', reason: reason.trim(), at: Date.now() }
    this.signoffs.push(so)
    this.#appendLog('signoff', so.by, { versionId, reason: so.reason })
    return so
  }

  /* ================= ★ 发起回滚 ================= */

  /**
   * ★ 事务：
   *  - 目标版本必须已签收（任意已签收版本都可独立还原，不依赖它之后的版本）；
   *  - 此刻【冻结】补丁 = head -> target，记录 baseHeadId 与 patchHash；
   *  - 审批人看到/批准的是这一份确定的补丁，而非“回滚到某版本”的模糊意图。
   */
  async createRollback({ targetVersionId, requestedBy, reason }) {
    await wait(LATENCY)
    const target = this.#version(targetVersionId)
    const signed = this.signoffs.some((s) => s.versionId === targetVersionId)
    if (!signed) { const e = new Error('只能回滚到已签收版本'); e.code = 'NOT_SIGNED'; throw e }
    if (targetVersionId === this.headId) { const e = new Error('目标版本即当前头版'); e.code = 'ALREADY_HEAD'; throw e }

    const head = this.#version(this.headId)
    const patch = buildPatch(head.root, target.root, head.id, target.id)
    const id = `rb_${Math.random().toString(36).slice(2, 7)}`
    const rb = {
      id,
      state: 'pending',
      baseHeadId: head.id,
      baseHeadHash: head.rootHash,
      targetVersionId: target.id,
      targetRootHash: target.rootHash,
      patchHash: patch.patchHash,
      patch,
      requestedBy: requestedBy || '编辑',
      reason: (reason || '').trim(),
      createdAt: Date.now(),
      history: [{ at: Date.now(), by: requestedBy || '编辑', action: 'create', detail: `基线 ${head.id} → 目标 ${target.id}` }],
    }
    this.rollbacks.push(rb)
    this.#appendLog('rollback-create', rb.requestedBy, { rollbackId: id, base: head.id, target: target.id, patchHash: patch.patchHash })
    return { rollback: this.#rbSummary(rb), patch }
  }

  async listRollbacks() {
    await wait(80)
    return this.rollbacks.map((r) => this.#rbSummary(r))
  }

  async getRollback(id) {
    await wait(80)
    const r = this.rollbacks.find((x) => x.id === id)
    if (!r) throw Object.assign(new Error('工单不存在'), { code: 'NO_ROLLBACK' })
    return { rollback: this.#rbSummary(r), patch: r.patch }
  }

  /* ================= ★ 审批通过（并发协议核心） ================= */

  /**
   * ★★ 事务，等价 SQL：
   *   SELECT ... FROM rollback WHERE id=$1 FOR UPDATE;
   *   SELECT head_id FROM manuscript WHERE id=$1 FOR UPDATE;
   *   校验链任何一环失败 => ROLLBACK，绝不允许旧确认覆盖新稿。
   *
   * 校验：
   *   1. 工单仍 pending（rejected/approved/superseded 不可重复审批）
   *   2. baseHeadId == 当前 head —— 乐观锁：审批期间有人编辑就 409
   *   3. 客户端回传 expectedPatchHash，与创建时冻结的 patchHash 一致（防篡改/防看错单）
   *   4. 服务端【重新计算】 head->target 补丁 hash，仍与冻结值一致
   *   5. 目标 rootHash 与签收记录指向的不可变快照一致
   * 通过 => 以目标快照创建【新版本】vN+1（kind=rollback），head 推进；
   *         原版本 v1..vN 原样保留，回滚本身也是一次可签收的提交。
   */
  async approveRollback(id, { approver, expectedPatchHash }) {
    await wait(LATENCY * 1.4) // 长一点，方便演示两人同时点通过
    const rb = this.rollbacks.find((x) => x.id === id)
    if (!rb) throw Object.assign(new Error('工单不存在'), { code: 'NO_ROLLBACK' })
    const fail = (code, msg, extra) => {
      this.#appendLog('rollback-reject-attempt', approver || '审批人', { rollbackId: id, code })
      throw Object.assign(new Error(msg), { code, ...extra })
    }
    if (rb.state !== 'pending' && rb.state !== 'superseded') {
      fail('RB_NOT_PENDING', `工单已结束：${rb.state}${rb.supersedeReason ? `（${rb.supersedeReason}）` : ''}`)
    }
    if (rb.baseHeadId !== this.headId) {
      // 乐观锁优先级最高：哪怕提交动作已把单子预作废，对旧补丁的确认也明确返回 409
      rb.state = 'superseded'
      rb.supersedeReason = rb.supersedeReason || `审批时头版已变为 ${this.headId}，旧补丁不可应用`
      rb.closedAt = rb.closedAt || Date.now()
      fail('STALE_HEAD', `审批过期：当前头版是 ${this.headId}，补丁基线停留在 ${rb.baseHeadId}。请按新头版重新计算并发起。`,
        { currentHead: this.headId, baseHead: rb.baseHeadId })
    }
    if (rb.state !== 'pending') {
      fail('RB_NOT_PENDING', `工单已结束：${rb.state}${rb.supersedeReason ? `（${rb.supersedeReason}）` : ''}`)
    }
    if (expectedPatchHash !== rb.patchHash) {
      fail('PATCH_HASH_MISMATCH', '确认的补丁与工单冻结补丁不一致，拒绝')
    }
    // 服务端重算（不信任客户端任何计算）
    const head = this.#version(this.headId)
    const target = this.#version(rb.targetVersionId)
    const recomputed = buildPatch(head.root, target.root, head.id, target.id)
    if (recomputed.patchHash !== rb.patchHash) {
      fail('PATCH_RECOMPUTE_MISMATCH', '服务端重算补丁与确认补丁不一致，拒绝')
    }
    if (target.rootHash !== rb.targetRootHash) {
      fail('TARGET_DRIFT', '目标版本快照发生漂移，拒绝')
    }

    // ---- 提交新版本（还原目标快照，身份/hash 逐字节一致）----
    const restored = deepFreeze(cloneTree(target.root))
    const number = this.versions.length + 1
    const vid = `v${number}_rb_${Math.random().toString(36).slice(2, 5)}`
    const nv = {
      id: vid, number, kind: 'rollback', root: restored,
      rootHash: target.rootHash, // 与已签收版本内容一致（内容寻址）
      message: `回滚还原到 ${target.id}（工单 ${rb.id}）`,
      author: approver || '审批人', parentId: head.id, createdAt: Date.now(),
      restoredFrom: target.id, rollbackId: rb.id,
    }
    this.versions.push(nv)
    this.headId = vid
    rb.state = 'approved'
    rb.approvedBy = approver || '审批人'
    rb.approvedAt = Date.now()
    rb.resultVersionId = vid
    rb.closedAt = Date.now()
    rb.history.push({ at: Date.now(), by: rb.approvedBy, action: 'approve', detail: `生成新版本 ${vid}，内容等同 ${target.id}` })
    this.#appendLog('rollback-approve', rb.approvedBy, {
      rollbackId: rb.id, newVersion: vid, restoredFrom: target.id, rootHash: target.rootHash,
    })
    this.checkpoints.push({ versionId: vid, rootHash: target.rootHash, opSeq: this.opSeq })

    // 同一时期的其他待审批单全部过期
    this.rollbacks.filter((x) => x.state === 'pending' && x.baseHeadId === rb.baseHeadId && x.id !== id)
      .forEach((x) => {
        x.state = 'superseded'
        x.supersedeReason = `并发审批：${rb.approvedBy} 已先生成 ${vid}`
        x.closedAt = Date.now()
        this.#appendLog('rollback-superseded', 'system', { rollbackId: x.id, newHead: vid })
      })
    return { version: this.#summary(nv), rollback: this.#rbSummary(rb) }
  }

  async rejectRollback(id, { approver, reason }) {
    await wait(LATENCY)
    const rb = this.rollbacks.find((x) => x.id === id)
    if (!rb) throw Object.assign(new Error('工单不存在'), { code: 'NO_ROLLBACK' })
    if (rb.state !== 'pending') throw Object.assign(new Error('工单已结束'), { code: 'RB_NOT_PENDING' })
    rb.state = 'rejected'
    rb.approvedBy = approver || '审批人'
    rb.closedAt = Date.now()
    rb.history.push({ at: Date.now(), by: rb.approvedBy, action: 'reject', detail: reason || '' })
    this.#appendLog('rollback-reject', rb.approvedBy, { rollbackId: id, reason })
    return this.#rbSummary(rb)
  }

  /* ================= 异步比对服务（大文稿） ================= */

  crashNextDiff() { this.crashNext = true }

  /**
   * 立即返回 jobId；后台 worker 读不可变快照计算。
   * 结果信封带 baseHeadHash：前端若发现自己当前关注的头版已变，拒绝回包。
   */
  async startDiffJob(fromVersionId, toVersionId) {
    await wait(60)
    this.#version(fromVersionId); this.#version(toVersionId)
    const jobId = `job_${Math.random().toString(36).slice(2, 7)}`
    const from = this.#version(fromVersionId)
    const to = this.#version(toVersionId)
    const job = {
      id: jobId, state: 'running', fromVersionId, toVersionId,
      baseHeadHash: this.headId, createdAt: Date.now(), finishedAt: null,
      willCrash: this.crashNext,
    }
    this.crashNext = false
    this.jobs.set(jobId, job)
    this.#appendLog('diff-start', 'system', { jobId, from: fromVersionId, to: toVersionId })

    // 大文稿：耗时放到 1.6s，给“期间切换基线/继续编辑”留出窗口
    wait(1600).then(() => {
      const live = this.jobs.get(jobId)
      if (!live || live.state !== 'running') return
      if (job.willCrash) {
        live.state = 'failed'
        live.error = '比对工作进程崩溃（worker OOM / 节点重启）'
        live.finishedAt = Date.now()
        this.#appendLog('diff-crash', 'system', { jobId })
        return
      }
      try {
        const patch = buildPatch(from.root, to.root, fromVersionId, toVersionId)
        live.state = 'succeeded'
        live.result = patch
        live.finishedAt = Date.now()
        this.#appendLog('diff-done', 'system', { jobId, patchHash: patch.patchHash, hunks: patch.hunks.length })
      } catch (e) {
        live.state = 'failed'; live.error = String(e); live.finishedAt = Date.now()
      }
    })
    return { jobId }
  }

  async pollDiffJob(jobId) {
    await wait(120)
    const job = this.jobs.get(jobId)
    if (!job) throw Object.assign(new Error('任务不存在'), { code: 'NO_JOB' })
    return {
      id: job.id, state: job.state,
      fromVersionId: job.fromVersionId, toVersionId: job.toVersionId,
      baseHeadHash: job.baseHeadHash,
      error: job.error || null,
      result: job.state === 'succeeded' ? job.result : null,
    }
  }

  /* ================= 辅助 ================= */

  #summary(v) {
    return {
      id: v.id, number: v.number, kind: v.kind, message: v.message, author: v.author,
      parentId: v.parentId, rootHash: v.rootHash, createdAt: v.createdAt,
      blocks: totalBlocks(v.root), isHead: v.id === this.headId,
      signoffs: this.signoffs.filter((s) => s.versionId === v.id),
      restoredFrom: v.restoredFrom || null, rollbackId: v.rollbackId || null,
    }
  }

  #rbSummary(r) {
    return {
      id: r.id, state: r.state, baseHeadId: r.baseHeadId, baseHeadHash: r.baseHeadHash,
      targetVersionId: r.targetVersionId, targetRootHash: r.targetRootHash,
      patchHash: r.patchHash, requestedBy: r.requestedBy, reason: r.reason,
      createdAt: r.createdAt, approvedBy: r.approvedBy || null, closedAt: r.closedAt || null,
      supersedeReason: r.supersedeReason || null, resultVersionId: r.resultVersionId || null,
      counts: r.patch.counts, history: r.history,
    }
  }
}

export const server = new ManuscriptService()
