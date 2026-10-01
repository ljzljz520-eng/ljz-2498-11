// 回滚并发提交协议（乐观锁 + 补丁复算 + 头版 CAS）。
//
// 关键不变量：
// 1. 回滚不覆写旧版本，而是基于"当前头版"创建一个内容等于目标版的新版本。
// 2. 确认者审批的是 patch(base=当前头版, target=任意历史版)，补丁带 checksum。
// 3. 提案记录 headVersionId/headSeq；审批时若头版已前进（有人继续编辑 / 他人先回滚 /
//    附件等节点被替换），旧确认一律拒绝（STALE_PROPOSAL / HEAD_MOVED），必须重新比对。
// 4. 提交用单行条件 UPDATE 做 CAS（此处以原子事务模拟），两人同时回滚只有一人成功。
import { checksumOf } from './diff.js'
import { serializeTree, deserializeTree, cloneSnapshotJson } from './snapshot.js'

let proposalSeed = 1

export const ProposalStatus = {
  OPEN: 'OPEN',
  APPROVED: 'APPROVED',
  STALE: 'STALE',
  REJECTED: 'REJECTED',
  SUPERSEDED: 'SUPERSEDED',
}

export class StaleProposalError extends Error {
  constructor(reason, detail) {
    super(reason)
    this.code = reason
    this.detail = detail
  }
}

export class RollbackCoordinator {
  constructor(store) {
    this.store = store
    // PG: rollback_proposals(id, doc_id, base_head_version_id, base_head_seq,
    //   target_version_id, patch_checksum, patch jsonb, reason, status,
    //   requested_by, requested_at, approved_by, approved_at, unique 进行中提案约束)
    this.proposals = new Map()
    // 文档级 FIFO 互斥：等价 PG 中 SELECT ... FOR UPDATE 头版行，
    // 保证两个并发 approve 串行化——先提交者成功，后者读到新头版后被判 HEAD_MOVED。
    this.locks = new Map()
  }

  withDocLock(docId, fn) {
    const prev = this.locks.get(docId) || Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    this.locks.set(docId, prev.then(() => gate))
    return prev.then(async () => {
      try {
        return await fn()
      } finally {
        release()
      }
    })
  }

  // 发起：以当前头版为补丁基准。result 为比较服务回包。
  propose(docId, compareResult, { requestedBy = 'editor', reason = '' } = {}) {
    const head = this.store.headVersion(docId)
    if (compareResult.fromVersionId !== head.id) {
      throw new StaleProposalError('STALE_COMPARE_RESULT', {
        expectBase: head.id,
        gotBase: compareResult.fromVersionId,
      })
    }
    if (compareResult.headVersionIdAtCompute !== head.id || compareResult.headSeqAtCompute !== head.seq) {
      throw new StaleProposalError('STALE_COMPARE_RESULT', '比较结果生成时头版已与当前不符')
    }
    const proposal = {
      id: `rb_${proposalSeed++}`,
      docId,
      baseHeadVersionId: head.id,
      baseHeadSeq: head.seq,
      targetVersionId: compareResult.toVersionId,
      patchChecksum: compareResult.patch.checksum,
      patch: compareResult.patch,
      restoreCost: compareResult.restoreCost,
      reason,
      requestedBy,
      status: ProposalStatus.OPEN,
      createdAt: Date.now(),
      approvedBy: null,
      approvedAt: null,
      newVersionId: null,
    }
    this.proposals.set(proposal.id, proposal)
    return proposal
  }

  // 校验但不提交：前端"审批中"轮询展示是否仍有效
  validate(proposalId) {
    const pr = this.proposals.get(proposalId)
    if (!pr) throw new StaleProposalError('NO_SUCH_PROPOSAL')
    if (pr.status !== ProposalStatus.OPEN) {
      return { valid: false, code: `PROPOSAL_${pr.status}`, proposal: pr }
    }
    const head = this.store.headVersion(pr.docId)
    if (head.id !== pr.baseHeadVersionId || head.seq !== pr.baseHeadSeq) {
      pr.status = ProposalStatus.STALE
      return {
        valid: false,
        code: 'HEAD_MOVED',
        proposal: pr,
        currentHead: head,
        changedVersionIds: this._versionsAfter(pr.docId, pr.baseHeadSeq),
      }
    }
    if (pr.patchChecksum !== checksumOf(pr.patch)) {
      pr.status = ProposalStatus.STALE
      return { valid: false, code: 'PATCH_TAMPERED', proposal: pr }
    }
    return { valid: true, proposal: pr }
  }

  // 确认者审批并提交（原子）。审批的补丁 = 当前头版 -> 目标版。
  // 确认者审批（并发安全）：两个同时审批在文档锁内串行，只有一人能成功提交。
  approve(proposalId, approver, reason) {
    const pr = this.proposals.get(proposalId)
    if (!pr) return Promise.reject(new StaleProposalError('NO_SUCH_PROPOSAL'))
    return this.withDocLock(pr.docId, () => this._approveLocked(proposalId, approver, reason))
  }

  _approveLocked(proposalId, approver, reason) {
    const pr = this.proposals.get(proposalId)
    if (!pr) throw new StaleProposalError('NO_SUCH_PROPOSAL')
    const store = this.store

    // —— 等价 PG 单事务：SELECT ... FOR UPDATE 头版行 + 条件 UPDATE ——
    const tx = store.beginTransaction ? store.beginTransaction(pr.docId) : null
    try {
      if (pr.status === ProposalStatus.APPROVED) {
        throw new StaleProposalError('ALREADY_APPROVED', { newVersionId: pr.newVersionId })
      }
      if (pr.status !== ProposalStatus.OPEN) {
        throw new StaleProposalError(`PROPOSAL_${pr.status}`)
      }
      const head = store.headVersion(pr.docId)
      if (head.id !== pr.baseHeadVersionId || head.seq !== pr.baseHeadSeq) {
        pr.status = ProposalStatus.STALE
        throw new StaleProposalError('HEAD_MOVED', {
          expected: { id: pr.baseHeadVersionId, seq: pr.baseHeadSeq },
          actual: { id: head.id, seq: head.seq },
          hint: '期间文稿被继续编辑或他人已回滚，请重新计算补丁后再确认',
        })
      }
      if (pr.patchChecksum !== checksumOf(pr.patch)) {
        pr.status = ProposalStatus.STALE
        throw new StaleProposalError('PATCH_TAMPERED')
      }

      // 构造回滚新版本：内容 = 目标版快照（身份沿用——这是还原，不是复制），
      // 父节点 = 当前头版（版本图向前，不回退历史）。
      const target = store.getVersion(pr.docId, pr.targetVersionId)
      const restoredTree = deserializeTree(
        cloneSnapshotJson(store.snapshotStore.get(target.snapshotHash))
      )
      const newVersion = store.commit(pr.docId, restoredTree, {
        author: approver,
        message: `回滚至 ${pr.targetVersionId}（审批 ${pr.id}）`,
        ops: [],
        forceCheckpoint: true, // 回滚结果独立快照，可独立还原
      })

      pr.status = ProposalStatus.APPROVED
      pr.approvedBy = approver
      pr.approvedAt = Date.now()
      pr.approvalReason = reason
      pr.newVersionId = newVersion.id
      if (tx) tx.commit()
      return { proposal: pr, newVersion }
    } catch (err) {
      if (tx) tx.rollback()
      throw err
    }
  }

  // 拒绝 / 作废
  reject(proposalId, approver, reason) {
    const pr = this.proposals.get(proposalId)
    pr.status = ProposalStatus.REJECTED
    pr.approvedBy = approver
    pr.approvalReason = reason
    return pr
  }

  _versionsAfter(docId, seq) {
    return this.store.listVersions(docId).filter((v) => v.seq > seq).map((v) => v.id)
  }
}
