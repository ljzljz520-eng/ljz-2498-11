<script setup>
import { ref } from 'vue'
import { useManuscript } from './composables/useManuscript.js'
import TreeEditor from './components/TreeEditor.vue'
import VersionGraph from './components/VersionGraph.vue'
import PatchView from './components/PatchView.vue'

const m = useManuscript()
const {
  versions, draftTree, currentUser, selectedVersionId, anchorId, noticeLog,
  compareState, proposals, pendingLogs,
  editText, editAttr, move, remove, insertParagraph, insertSpec, copyNode,
  replaceAttachment, commitDraft, signOff, requestCompare, armCrash, clearCrash,
  proposeRollback, approveRollback, rejectRollback, validateProposal,
  focusAnchor, inspectVersion, logNotice, refreshVersions, refreshProposals,
} = m

const signoffMap = ref({})
function refreshSignOffs() {
  const map = {}
  for (const v of versions.value) map[v.id] = m.store.listSignOffs(v.id)
  signoffMap.value = map
}
refreshSignOffs()
function bump() {
  refreshVersions()
  refreshProposals()
  refreshSignOffs()
}

async function onCompare(baseId, targetId) {
  await requestCompare(baseId, targetId)
}
function onSignOff(vid, signer, reason) {
  signOff(vid, signer || 'reviewer', reason || '已核对')
  bump()
}
function onAnchor(nodeId) {
  focusAnchor(nodeId)
  if (!draftTree.value.nodes.has(nodeId)) {
    logNotice('warn', `锚点 ${nodeId} 属于被比较的历史版本（当前草稿中不存在），已保留定位请求`)
  }
}
function onPropose(result, reason) {
  proposeRollback(result, reason)
  bump()
}
async function onApprove(pid, reason) {
  try {
    await approveRollback(pid, currentUser.value, reason)
    bump()
  } catch {
    bump()
  }
}
function onReject(pid, reason) {
  rejectRollback(pid, currentUser.value, reason || '不同意')
  bump()
}
function onValidate(pid) {
  const v = validateProposal(pid)
  if (v.valid) logNotice('info', `提案 ${pid} 仍有效：头版未变动且补丁 checksum 一致`)
  else logNotice('error', `提案 ${pid} 已失效：${v.code}，必须重新比对`)
  bump()
}
function onInspect(vid) {
  const info = inspectVersion(vid)
  logNotice(
    'info',
    `版本 ${vid} 独立还原：检查点=${info.checkpointId}，回放操作=${info.replayedOps}（上限 ${info.cost.boundedBy}），` +
    `内容哈希=${info.contentHash.slice(0, 12)}…，已签收=${info.signedOff}`
  )
}
function onCommit() {
  commitDraft()
  bump()
}
function onInsert(parentId, specOrText) {
  if (typeof specOrText === 'string') insertParagraph(parentId, specOrText)
  else insertSpec(parentId, specOrText)
}

// —— 五个验收场景的一键复现 ——
function findSignedOrFirst(list) {
  return list.find((v) => v.signedOff) || list[0]
}

async function runScenario(key) {
  if (key === 'copy-rewrite') {
    copyNode('par-intro-1', 'sec-intro')
    const twins = [...draftTree.value.nodes.values()].filter(
      (n) => n.type === 'paragraph' && n.text === '本文介绍 Catalpa 文稿台的版本管理能力。'
    )
    const fresh = twins[twins.length - 1]
    editText(fresh.id, `${fresh.text}（复制稿，已补充版本比对说明）`)
    const v = commitDraft('场景1：复制段落后改写')
    bump()
    logNotice('info', `已提交 ${v.id}：复制节点 id=${fresh.id} ≠ 源 id=par-intro-1（身份不复用）。比较 v1 → ${v.id}`)
  } else if (key === 'move-cross-chapter') {
    move('par-body-1', 'sec-intro', -1)
    const v = commitDraft('场景2：正文段落跨章移动到引言')
    bump()
    logNotice('info', `已提交 ${v.id}：par-body-1 身份不变、父节点变为 sec-intro。比较 v1 → ${v.id}，应仅出现 MOVE`)
  } else if (key === 'two-rollback') {
    const h = m.store.headVersion('doc-1')
    const target = findSignedOrFirst(versions.value)
    const res = await requestCompare(h.id, target.id)
    if (!res) return
    const p1 = m.coordinator.propose('doc-1', res, { requestedBy: 'user-a', reason: '用户A 回滚' })
    const p2 = m.coordinator.propose('doc-1', res, { requestedBy: 'user-b', reason: '用户B 回滚' })
    bump()
    const [r1, r2] = await Promise.allSettled([
      m.coordinator.approve(p1.id, 'user-a', 'A 确认'),
      m.coordinator.approve(p2.id, 'user-b', 'B 确认'),
    ])
    const winner = r1.status === 'fulfilled' ? r1 : r2
    const loser = r1.status === 'fulfilled' ? r2 : r1
    logNotice('info', `并发回滚：成功者生成 ${winner.value.newVersion.id}；失败者 code=${loser.reason?.code}`)
    bump()
  } else if (key === 'attachment-replace') {
    const h = m.store.headVersion('doc-1')
    const target = findSignedOrFirst(versions.value)
    const res = await requestCompare(h.id, target.id)
    if (!res) return
    const p = proposeRollback(res, '审批中：附件替换演练')
    bump()
    replaceAttachment('att-1')
    commitDraft('场景4：审批期间替换附件 att-1')
    bump()
    try {
      await m.coordinator.approve(p.id, currentUser.value, '试图用旧补丁确认')
      logNotice('error', '异常：旧补丁竟然通过（不应发生）')
    } catch (err) {
      logNotice('error', `附件替换 → 头版前进 → 旧补丁被拒：${err.code}；必须重新比较后重新审批`)
      bump()
    }
  } else if (key === 'compare-crash') {
    armCrash(1)
    const h = m.store.headVersion('doc-1')
    await requestCompare(h.id, versions.value[0].id)
    clearCrash()
    logNotice('info', '比较进程崩溃已被捕获：不可变快照与版本完好，重试即可；崩溃结果不会进入补丁区')
  }
}
</script>

<template>
  <div class="page">
    <header class="hero">
      <div>
        <p class="eyebrow">Catalpa · 版本比对与回滚</p>
        <h1>不可变文稿台：结构 / 文本 / 样式三维补丁</h1>
        <p class="subtitle">比较服务只读不可变快照；回滚以新版本提交，过期确认不能覆盖新稿。</p>
      </div>
      <div class="stats">
        <label class="user-pick">操作者
          <select v-model="currentUser">
            <option value="author-a">作者 A</option>
            <option value="author-b">作者 B</option>
            <option value="reviewer-li">签收人 李</option>
          </select>
        </label>
        <span>{{ versions.length }} 版本</span>
      </div>
    </header>

    <div class="scenario-bar">
      <span class="sb-label">验收场景一键复现：</span>
      <button type="button" class="ghost-btn" @click="runScenario('copy-rewrite')">① 复制后改写</button>
      <button type="button" class="ghost-btn" @click="runScenario('move-cross-chapter')">② 跨章节移动</button>
      <button type="button" class="ghost-btn" @click="runScenario('two-rollback')">③ 两人同时回滚</button>
      <button type="button" class="ghost-btn" @click="runScenario('attachment-replace')">④ 审批中附件替换</button>
      <button type="button" class="ghost-btn danger" @click="runScenario('compare-crash')">⑤ 比较进程崩溃</button>
    </div>

    <main class="workspace">
      <div class="col col-left">
        <TreeEditor
          :tree="draftTree"
          :anchor-id="anchorId"
          :pending-count="pendingLogs.list.length"
          @edit-text="editText"
          @edit-style="editAttr"
          @move="move"
          @remove="remove"
          @insert="onInsert"
          @copy="copyNode"
          @replace-attachment="replaceAttachment"
          @commit="onCommit"
        />
      </div>

      <div class="col col-right">
        <VersionGraph
          :versions="versions"
          :selected="selectedVersionId"
          :proposals="proposals"
          :signoff-map="signoffMap"
          @select="selectedVersionId = $event"
          @compare="onCompare"
          @signoff="onSignOff"
          @inspect="onInspect"
          @approve="onApprove"
          @reject="onReject"
          @validate="onValidate"
        />
        <PatchView
          :result="compareState.result"
          :loading="compareState.loading"
          :error="compareState.error"
          :dropped-stale="compareState.droppedStale"
          @anchor="onAnchor"
          @propose="onPropose"
        />
      </div>
    </main>

    <section class="console">
      <h3>事件 / 协议日志</h3>
      <ul>
        <li v-for="(n, i) in noticeLog" :key="i" :class="n.level">
          <span class="ts">{{ new Date(n.at).toLocaleTimeString() }}</span>{{ n.message }}
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.stats { display: flex; gap: 10px; align-items: center; }
.user-pick { display: flex; flex-direction: column; font-size: 0.72rem; color: var(--muted); gap: 2px; }
.user-pick select { padding: 5px 8px; border-radius: 8px; border: 1px solid var(--border); }
.scenario-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; padding: 10px 12px; background: #fff; border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow); }
.sb-label { font-size: 0.8rem; color: var(--muted); }
.workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); gap: 14px; align-items: start; }
.col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
:deep(.panel) { min-height: auto; }
:deep(.editor-panel) { position: sticky; top: 10px; }
:deep(.tree-scroll) { max-height: 62vh; }
:deep(.patch-body) { max-height: 46vh; }
.console { margin-top: 16px; background: #10211a; color: #cfe6da; border-radius: 14px; padding: 12px 16px; font-size: 0.78rem; }
.console h3 { margin: 0 0 8px; font-size: 0.82rem; color: #9fd8bd; }
.console ul { list-style: none; margin: 0; padding: 0; max-height: 180px; overflow: auto; display: flex; flex-direction: column; gap: 3px; }
.ts { color: #7fae98; margin-right: 8px; font-family: var(--mono); }
.console li.error { color: #f1a49a; }
.console li.warn { color: #ecc77f; }
@media (max-width: 1100px) {
  .workspace { grid-template-columns: 1fr; }
}
</style>
