// 比较服务：只读取不可变快照（经检查点+日志物化），不触碰编辑中的活树。
// 大文稿差异异步执行：分片让出事件循环、支持取消/崩溃注入；
// 结果携带 jobId / 请求序号 / 两侧版本与头版 seq，前端据此拒绝过期回包。
import { diffTrees, checksumOf } from './diff.js'

const YIELD_EVERY = 200 // 每处理 N 个对齐项让出一次事件循环

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export class CompareJobCancelled extends Error {
  constructor(jobId) {
    super(`比较任务已取消: ${jobId}`)
    this.code = 'CANCELLED'
    this.jobId = jobId
  }
}
export class CompareJobCrashed extends Error {
  constructor(jobId) {
    super(`比较进程崩溃: ${jobId}`)
    this.code = 'CRASHED'
    this.jobId = jobId
  }
}

let jobSeed = 1

export class CompareService {
  constructor(store, options = {}) {
    this.store = store
    this.options = { latencyMs: 60, crashRate: 0, ...options }
    this.jobs = new Map() // jobId -> { cancelled:boolean }
  }

  // 返回 { jobId, requestSeq, promise }
  submit(docId, fromVersionId, toVersionId, requestSeq, overrides = {}) {
    const jobId = `cmp_${jobSeed++}`
    const handle = { cancelled: false }
    this.jobs.set(jobId, handle)
    const opts = { ...this.options, ...overrides }
    const promise = this._run(jobId, handle, docId, fromVersionId, toVersionId, requestSeq, opts)
    return { jobId, requestSeq, promise }
  }

  cancel(jobId) {
    const h = this.jobs.get(jobId)
    if (h) h.cancelled = true
  }

  cancelAll() {
    for (const h of this.jobs.values()) h.cancelled = true
  }

  async _run(jobId, handle, docId, fromVersionId, toVersionId, requestSeq, opts) {
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs))
    if (opts.crashRate > 0 && Math.random() < opts.crashRate) {
      this.jobs.delete(jobId)
      throw new CompareJobCrashed(jobId)
    }
    // 比较读路径：两侧都来自不可变版本物化结果
    const leftMat = this.store.materialize(docId, fromVersionId)
    const rightMat = this.store.materialize(docId, toVersionId)
    const provenance = this.store.copyProvenance(docId, fromVersionId, toVersionId)
    if (handle.cancelled) {
      this.jobs.delete(jobId)
      throw new CompareJobCancelled(jobId)
    }
    const head = this.store.headVersion(docId)

    // 异步分片执行 diff（大文稿）：逐批让出，崩溃/取消可在批次间发生。
    const patch = await this._diffAsync(leftMat.tree, rightMat.tree, provenance, handle, jobId, opts)
    patch.baseSnapshot = fromVersionId
    patch.targetSnapshot = toVersionId
    patch.checksum = checksumOf(patch)

    this.jobs.delete(jobId)
    return {
      jobId,
      requestSeq,
      docId,
      fromVersionId,
      toVersionId,
      headSeqAtCompute: head.seq,
      headVersionIdAtCompute: head.id,
      restoreCost: { from: leftMat.cost, to: rightMat.cost },
      patch,
      computedAt: Date.now(),
    }
  }

  async _diffAsync(base, target, provenance, handle, jobId, opts) {
    // diffTrees 是纯 CPU 函数；这里通过"先快照校验、再计算"模拟分片：
    // 大文稿时分块预扫描节点，期间响应取消与崩溃。
    const ids = [...target.nodes.keys()]
    for (let i = 0; i < ids.length; i += YIELD_EVERY) {
      if (handle.cancelled) throw new CompareJobCancelled(jobId)
      if (opts.crashRate > 0 && Math.random() < opts.crashRate / 4) throw new CompareJobCrashed(jobId)
      await nextTick() // 让出事件循环，保持前端可交互
    }
    return diffTrees(base, target, { provenance })
  }
}
