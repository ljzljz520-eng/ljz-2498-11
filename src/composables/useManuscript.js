import { reactive, ref, shallowRef } from 'vue'
import { HistoryStore, editWithLog, resetSeed } from '../core/history.js'
import { CompareService } from '../core/compare.js'
import { RollbackCoordinator, StaleProposalError } from '../core/protocol.js'
import { createDoc, insertNode, findNode, pathOf } from '../core/tree.js'
import { serializeTree } from '../core/snapshot.js'

export const DOC_ID = 'doc-1'

export function useManuscript() {
  resetSeed()
  const store = new HistoryStore()
  const compareService = new CompareService(store, { latencyMs: 120, crashRate: 0 })
  const coordinator = new RollbackCoordinator(store)

  let initial = createDoc('年度报告（演示文稿）')
  // 初始章节结构：两章 + 若干段落 + 一个附件，便于演示跨章移动/复制/附件替换
  initial = insertNode(initial, initial.rootId, {
    id: 'sec-intro', type: 'section', attrs: { title: '第一章 引言' }, children: [
      { id: 'par-intro-1', type: 'paragraph', text: '本文介绍 Catalpa 文稿台的版本管理能力。' },
      { id: 'par-intro-2', type: 'paragraph', text: '版本比对按结构、文本、样式三个维度输出补丁。' },
    ],
  }, 0)
  initial = insertNode(initial, initial.rootId, {
    id: 'sec-body', type: 'section', attrs: { title: '第二章 正文' }, children: [
      { id: 'par-body-1', type: 'paragraph', text: '移动段落与删除后新增必须可以区分。' },
      { id: 'par-body-2', type: 'paragraph', text: '复制节点会得到全新身份，不能复用原身份。', marks: [{ from: 0, to: 4, type: 'strong' }] },
      { id: 'att-1', type: 'attachment', text: '', attrs: { name: '需求说明.pdf', assetId: 'asset-v1', size: 128000 } },
    ],
  }, 1)
  const v1 = store.initDocument(DOC_ID, '年度报告（演示文稿）', initial, 'author-a')

  const versions = ref(store.listVersions(DOC_ID))
  const draftTree = shallowRef(initial)
  const pendingLogs = reactive({ list: [] })
  const currentUser = ref('author-a')
  const selectedVersionId = ref(v1.id)
  const anchorId = ref(null)
  const noticeLog = ref([])

  function logNotice(level, message) {
    noticeLog.value.unshift({ at: Date.now(), level, message })
    if (noticeLog.value.length > 30) noticeLog.value.pop()
  }

  function refreshVersions() {
    versions.value = store.listVersions(DOC_ID)
  }

  function applyEdit(kind, nodeId, payload) {
    const { tree, log } = editWithLog(draftTree.value, kind, nodeId, payload)
    draftTree.value = tree
    pendingLogs.list.push(log)
  }

  function editText(nodeId, text) {
    applyEdit('TEXT', nodeId, { text })
  }
  function editAttr(nodeId, patch) {
    applyEdit('STYLE', nodeId, { attrs: { ...(findNode(draftTree.value, nodeId)?.attrs || {}), ...patch } })
  }
  function move(nodeId, parentId, index) {
    applyEdit('MOVE', nodeId, { parentId, index })
  }
  function remove(nodeId) {
    applyEdit('DELETE', nodeId, {})
  }
  function insertParagraph(parentId, text = '新段落') {
    applyEdit('INSERT', null, { parentId, spec: { type: 'paragraph', text }, index: -1 })
  }
  function insertSpec(parentId, spec) {
    applyEdit('INSERT', null, { parentId, spec, index: -1 })
  }
  function copyNode(nodeId, parentId) {
    applyEdit('COPY', nodeId, { fromId: nodeId, parentId, index: -1 })
  }
  function replaceAttachment(nodeId) {
    const node = findNode(draftTree.value, nodeId)
    const nextAsset = `asset-${Math.random().toString(16).slice(2, 8)}`
    applyEdit('STYLE', nodeId, {
      attrs: { ...(node.attrs || {}), assetId: nextAsset, replacedAt: Date.now() },
    })
    logNotice('warn', `附件 ${node.attrs.name} 已替换为 ${nextAsset}（头版将前进）`)
  }

  function commitDraft(message) {
    const v = store.commit(DOC_ID, draftTree.value, {
      author: currentUser.value,
      message: message || `编辑提交 @ ${new Date().toLocaleTimeString()}`,
      ops: pendingLogs.list.map((l) => ({ ...l, payload: JSON.parse(JSON.stringify(l.payload)) })),
    })
    pendingLogs.list.length = 0
    refreshVersions()
    selectedVersionId.value = v.id
    logNotice('info', `${v.id} 已提交（${v.isCheckpoint ? '检查点全量快照' : '操作日志记录'}）`)
    return v
  }

  function signOff(versionId, signer, reason) {
    store.signOff(DOC_ID, versionId, signer, reason)
    refreshVersions()
    logNotice('info', `${versionId} 已由 ${signer} 签收：${reason}（强制独立快照）`)
  }

  // —— 比较：异步 + 防旧包。前端只保留"最新请求序号"对应的回包 ——
  let requestSeq = 0
  let activeJobId = null
  const compareState = reactive({
    loading: false,
    error: null,
    result: null,
    droppedStale: 0,
    lastToken: null,
  })

  async function requestCompare(fromId, toId) {
    requestSeq += 1
    const mySeq = requestSeq
    if (activeJobId) compareService.cancel(activeJobId) // 新请求作废在途任务
    const { jobId, promise } = compareService.submit(DOC_ID, fromId, toId, mySeq)
    activeJobId = jobId
    compareState.loading = true
    compareState.error = null
    compareState.lastToken = { seq: mySeq, jobId }
    try {
      const result = await promise
      // 拒绝旧结果回包：序号过期或已被新任务取消
      if (mySeq !== requestSeq || jobId !== activeJobId) {
        compareState.droppedStale += 1
        logNotice('warn', `丢弃过期比较回包 ${jobId}（当前 #${requestSeq}，回包 #${mySeq}）`)
        return null
      }
      compareState.result = result
      compareState.loading = false
      logNotice('info', `比较完成 #${mySeq}：结构 ${result.patch.dimensions.structure} / 文本 ${result.patch.dimensions.text} / 样式 ${result.patch.dimensions.style}`)
      return result
    } catch (err) {
      if (mySeq !== requestSeq) {
        compareState.droppedStale += 1
        return null
      }
      compareState.loading = false
      if (err.code === 'CRASHED') {
        compareState.error = '比较进程在计算中崩溃，请重试（快照完好，无数据损失）。'
        logNotice('error', `比较任务 ${jobId} 崩溃`)
      } else if (err.code === 'CANCELLED') {
        compareState.error = '比较任务已被新请求取消。'
      } else {
        compareState.error = err.message
      }
      return null
    }
  }

  // 让下一次比较以给定概率崩溃（验收：比较进程崩溃）
  function armCrash(rate = 1) {
    compareService.options.crashRate = rate
    logNotice('warn', '已注入比较进程崩溃故障')
  }
  function clearCrash() {
    compareService.options.crashRate = 0
  }

  // —— 回滚提案与审批 ——
  const proposals = ref([])
  function refreshProposals() {
    proposals.value = [...coordinator.proposals.values()].reverse()
  }

  function proposeRollback(result, reason) {
    try {
      const pr = coordinator.propose(DOC_ID, result, { requestedBy: currentUser.value, reason })
      refreshProposals()
      logNotice('info', `回滚提案 ${pr.id} 已创建：${pr.baseHeadVersionId} → ${pr.targetVersionId}`)
      return pr
    } catch (err) {
      logNotice('error', `提案被拒：${err.code}`)
      throw err
    }
  }

  async function approveRollback(proposalId, approver = currentUser.value, reason = '确认回滚') {
    try {
      const { newVersion } = await coordinator.approve(proposalId, approver, reason)
      // 回滚后：工作草稿切换为新版本内容（历史不回退，头版前进）
      const mat = store.materialize(DOC_ID, newVersion.id)
      draftTree.value = mat.tree
      pendingLogs.list.length = 0
      refreshVersions()
      refreshProposals()
      selectedVersionId.value = newVersion.id
      logNotice('info', `审批通过：${newVersion.id} 已创建（内容还原自目标版，全量快照）`)
      return newVersion
    } catch (err) {
      refreshProposals()
      if (err instanceof StaleProposalError || err.code) {
        logNotice('error', `审批失败 ${err.code}：补丁过期，必须重新计算（不能用过期确认覆盖新稿）`)
      }
      throw err
    }
  }

  function rejectRollback(proposalId, approver, reason) {
    coordinator.reject(proposalId, approver, reason)
    refreshProposals()
  }

  function validateProposal(proposalId) {
    const v = coordinator.validate(proposalId)
    refreshProposals()
    return v
  }

  function focusAnchor(nodeId) {
    anchorId.value = null
    setTimeout(() => { anchorId.value = nodeId }, 0)
  }

  // 物化任意版本（演示恢复成本 + 已签收版本独立还原）
  function inspectVersion(versionId) {
    const mat = store.materialize(DOC_ID, versionId)
    const head = store.headVersion(DOC_ID)
    const { contentHash } = serializeTree(mat.tree)
    return {
      ...mat,
      contentHash,
      signedOff: store.getVersion(DOC_ID, versionId).signedOff,
      isHead: head.id === versionId,
    }
  }

  function nodePath(nodeId, tree = draftTree.value) {
    return pathOf(tree, nodeId)
  }

  return {
    store,
    coordinator,
    compareService,
    versions,
    draftTree,
    currentUser,
    selectedVersionId,
    anchorId,
    noticeLog,
    compareState,
    proposals,
    editText, editAttr, move, remove, insertParagraph, insertSpec, copyNode, replaceAttachment,
    commitDraft, signOff, requestCompare, armCrash, clearCrash,
    proposeRollback, approveRollback, rejectRollback, validateProposal,
    focusAnchor, inspectVersion, nodePath,
    refreshVersions, refreshProposals, logNotice,
  }
}
