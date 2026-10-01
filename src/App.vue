<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { server } from './services/mockServer'
import {
  cloneTree, copyWithNewIdentity, makeP, makeSection, rootHash,
} from './versioning/tree'
import ManuscriptEditor from './components/ManuscriptEditor.vue'
import VersionPanel from './components/VersionPanel.vue'
import ComparePanel from './components/ComparePanel.vue'
import RollbackPanel from './components/RollbackPanel.vue'

/* ---------------- 全局状态 ---------------- */
const tab = ref('versions')
const busy = ref(false)
const versions = ref([])
const rollbacks = ref([])
const headId = ref('')
const draft = ref(null)
const draftBaseId = ref(null)
const draftBaseHash = ref(null)
const toast = ref(null)
const oplog = ref([])
const recovery = ref(null)

const currentUser = ref('作者A')

/* 比对 */
const cmpFrom = ref('v1')
const cmpTo = ref('')
const cmpFilter = ref('all')
const job = ref(null)
let pollTimer = null
let jobToken = 0
const crashArmed = ref(false)
const autoEditDuring = ref(false)
let autoEditDone = false

/* 冻结补丁弹窗 */
const patchModal = reactive({ open: false, rb: null, patch: null })

/* 高亮 */
const activeNodeId = ref(null)
const highlightHunks = ref([]) // 当前展示补丁的 hunks

function toastMsg(msg, kind = 'info', ms = 3600) {
  toast.value = { msg, kind }
  setTimeout(() => { if (toast.value?.msg === msg) toast.value = null }, ms)
}

async function refresh(keepDraft = true) {
  versions.value = await server.listVersions()
  rollbacks.value = await server.listRollbacks()
  headId.value = versions.value.find((v) => v.isHead)?.id
  oplog.value = await server.oplogView()
  if (!keepDraft) {
    await resetDraft()
  }
}

async function resetDraft() {
  const base = await server.getDraftBase()
  draftBaseId.value = headId.value
  draftBaseHash.value = rootHash(base)
  draft.value = cloneTree(base)
}

onMounted(async () => {
  await refresh(false)
  cmpTo.value = headId.value
})

/* ---------------- 草稿编辑（纯本地，未提交前不碰版本图） ---------------- */

function mutateDraft(fn) {
  const d = cloneTree(draft.value)
  fn(d)
  draft.value = d
}
const draftDirty = computed(() => draft.value && rootHash(draft.value) !== draftBaseHash.value)
const draftBadge = computed(() => `基线 ${draftBaseId.value}${draftDirty.value ? ' · 有未提交改动' : ''}`)

function findSection(root, id) { return root.children.find((s) => s.id === id) }

function onUpdateText({ nodeId, sectionId, text }) {
  mutateDraft((d) => {
    const node = findSection(d, sectionId).children.find((x) => x.id === nodeId)
    node.text = text
  })
}
function onUpdateSectionTitle({ sectionId, title }) {
  mutateDraft((d) => { findSection(d, sectionId).title = title })
}
function onToggleMark({ nodeId, sectionId, mark }) {
  mutateDraft((d) => {
    const node = findSection(d, sectionId).children.find((x) => x.id === nodeId)
    const set = new Set(node.marks || [])
    if (set.has(mark)) set.delete(mark); else set.add(mark)
    node.marks = [...set]
  })
}
function onAddBlock({ sectionId }) {
  mutateDraft((d) => { findSection(d, sectionId).children.push(makeP('新段落…')) })
}
function onDeleteBlock({ nodeId, sectionId }) {
  mutateDraft((d) => {
    const sec = findSection(d, sectionId)
    sec.children = sec.children.filter((x) => x.id !== nodeId)
  })
}
function onCopyBlock({ nodeId, sectionId }) {
  // 正确语义：深拷贝 + 全新身份 => 比对识别为 copy（同 hash / 不同 id）
  mutateDraft((d) => {
    const sec = findSection(d, sectionId)
    const src = sec.children.find((x) => x.id === nodeId)
    sec.children.push(copyWithNewIdentity(src))
  })
  toastMsg('已复制：内容相同但身份（id）全新，比对会显示“复制(新身份)”', 'ok')
}
function onDuplicateBlock({ nodeId, sectionId }) {
  // 反面演示：错误地复用 id，制造“身份冲突”，提交时 hash 树虽合法但 diff 无法区分移动/复制
  mutateDraft((d) => {
    const sec = findSection(d, sectionId)
    const src = sec.children.find((x) => x.id === nodeId)
    sec.children.push(structuredClone(src))
  })
  toastMsg('⚠️ 已插入同 id 副本（反例）：树内出现重复身份，提交将被拒绝', 'warn')
}
function onMoveBlock({ nodeId, fromSectionId, toSectionId }) {
  mutateDraft((d) => {
    const from = findSection(d, fromSectionId)
    const node = from.children.find((x) => x.id === nodeId)
    from.children = from.children.filter((x) => x.id !== nodeId)
    findSection(d, toSectionId).children.push(node) // 同一节点对象移动：id 保持
  })
}
function onAddSection() {
  mutateDraft((d) => { d.children.push(makeSection('新章节', [makeP('新章节的首段。')])) })
}
function onReplaceAttachment({ nodeId, sectionId }) {
  mutateDraft((d) => {
    const att = findSection(d, sectionId).children.find((x) => x.id === nodeId)
    att.blobHash = `b_${Math.random().toString(16).slice(2, 12)}`
    att.size = Math.floor(1000 + Math.random() * 40000)
    att.name = att.name.replace(/(\.[^.]+)?$/, '_v2$1')
  })
  toastMsg('附件已替换：id 不变，blobHash 变化，显示为“结构·附件替换”', 'ok')
}

const commitMsg = ref('')

async function commitDraft() {
  busy.value = true
  try {
    // 重复身份校验（复制必须新身份）
    const ids = new Set()
    let dup = null
    const walk = (nodes) => nodes.forEach((n) => {
      if (ids.has(n.id) && !dup) dup = n.id
      ids.add(n.id)
      if (n.children) walk(n.children)
    })
    walk(draft.value.children)
    if (dup) throw new Error(`检测到重复节点身份 ${dup}：复制不能复用 id`)
    const { version, superseded } = await server.commitDraft({
      root: draft.value, message: commitMsg.value || '', author: currentUser.value,
    })
    commitMsg.value = ''
    await refresh(false)
    toastMsg(`已提交 ${version.id}${superseded.length ? `；${superseded.length} 张待审批回滚单因头版推进而作废` : ''}`, 'ok')
  } catch (e) {
    toastMsg(e.message, 'error', 5200)
  } finally {
    busy.value = false
  }
}

/* ---------------- 签收 ---------------- */

async function signoff(versionId) {
  const reason = prompt(`请填写签收理由（版本 ${versionId}）：PG signoff 表要求 reason 非空`)
  if (reason === null) return
  try {
    await server.signoff(versionId, { by: currentUser.value === '作者A' ? '总编' : currentUser.value, reason })
    await refresh()
    toastMsg('签收完成：该版本现可独立还原', 'ok')
  } catch (e) { toastMsg(e.message, 'error') }
}

/* ---------------- 比对（异步 + 防旧包 + 崩溃） ---------------- */

const highlightIndex = computed(() => {
  const map = new Map()
  for (const h of highlightHunks.value) {
    const nodeId = h.nodeId
    if (!map.has(nodeId)) map.set(nodeId, { type: h.type, label: '', items: [] })
    const entry = map.get(nodeId)
    entry.items.push({ hunkId: h.id, type: h.type, label: h.type })
    if (!entry.label) entry.label = h.type
  }
  return map
})

async function runDiff() {
  if (!cmpFrom.value || !cmpTo.value || cmpFrom.value === cmpTo.value) return
  job.value = { state: 'running', baseHeadHash: null, currentHeadHash: null, stale: false, result: null, error: null }
  highlightHunks.value = []
  const myToken = ++jobToken
  autoEditDone = false
  try {
    const { jobId } = await server.startDiffJob(cmpFrom.value, cmpTo.value)
    const from = versions.value.find((v) => v.id === cmpFrom.value)
    const to = versions.value.find((v) => v.id === cmpTo.value)
    job.value = { state: 'running', baseHeadHash: null, currentHeadHash: headId.value, stale: false, result: null, error: null, jobId }

    pollTimer = setInterval(async () => {
      if (myToken !== jobToken) { clearInterval(pollTimer); return }
      const st = await server.pollDiffJob(jobId)
      // 场景：比对期间继续编辑（自动或手工提交）。结果回来时对比信封 baseHeadHash
      const currentHead = versions.value.find((v) => v.isHead)?.rootHash
      if (st.state === 'running') {
        job.value = { ...job.value, state: 'running', baseHeadHash: st.baseHeadHash, currentHeadHash: currentHead }
        // 自动编辑注入点：任务跑约一半后提交新版本
        if (autoEditDuring.value && !autoEditDone) {
          autoEditDone = true
          setTimeout(() => doAutoEditDuringJob(st.baseHeadHash), 700)
        }
        return
      }
      clearInterval(pollTimer)
      if (st.state === 'failed') {
        if (myToken === jobToken) {
          job.value = { state: 'failed', error: st.error, baseHeadHash: st.baseHeadHash, currentHeadHash: currentHead, stale: false, result: null }
          highlightHunks.value = []
        }
        return
      }
      // 成功：信封里的 baseHeadHash 是启动时头版；和当前头版比
      const stale = st.baseHeadHash !== currentHead
      if (myToken !== jobToken) return
      job.value = {
        state: 'succeeded',
        baseHeadHash: st.baseHeadHash,
        currentHeadHash: currentHead,
        stale,
        result: stale ? null : st.result,
        error: null,
      }
      if (!stale) {
        highlightHunks.value = st.result.hunks
        toastMsg('比对完成：点击任意补丁卡片可定位到段落锚点', 'ok')
      } else {
        highlightHunks.value = []
        toastMsg('比对结果已过期并被前端拒收（信封头版 ≠ 当前头版）', 'warn', 5200)
      }
    }, 350)
  } catch (e) {
    job.value = { state: 'failed', error: e.message, stale: false, result: null }
  }
}

async function doAutoEditDuringJob(_baseHash) {
  try {
    const d = cloneTree(draft.value)
    d.children[0].children.push(makeP('审批/比对期间由他人新写入的段落。'))
    const { version } = await server.commitDraft({
      root: d, message: '比对进行中：作者B 继续编辑并提交', author: '作者B',
    })
    await refresh(true)
    draft.value = d
    draftBaseId.value = version.id
    draftBaseHash.value = version.rootHash
    toastMsg('作者B 已在比对期间提交新版本，旧结果回来时将被拒收', 'warn', 5000)
  } catch (e) { /* 忽略自动场景冲突 */ }
}

function retryDiff() {
  cmpFrom.value = versions.value.find((v) => v.isHead)?.parentId || cmpFrom.value
  cmpTo.value = headId.value
  runDiff()
}

function onHunkClick(h) {
  activeNodeId.value = null
  requestAnimationFrame(() => { activeNodeId.value = h.nodeId })
}

/* ---------------- 回滚 ---------------- */

async function startRollback(targetVersionId) {
  const reason = prompt(`回滚理由（审批人将看到 head → ${targetVersionId} 的完整补丁）：`, '内容方向有误，需要恢复到已签收版本')
  if (reason === null) return
  busy.value = true
  try {
    const { rollback: rb } = await server.createRollback({
      targetVersionId, requestedBy: currentUser.value, reason,
    })
    await refresh()
    tab.value = 'rollback'
    toastMsg(`工单 ${rb.id} 已创建：补丁在服务端冻结，请审批`, 'ok')
  } catch (e) { toastMsg(e.message, 'error') } finally { busy.value = false }
}

const approving = ref(null)
async function approve({ id, who }) {
  const rb = rollbacks.value.find((x) => x.id === id)
  if (!rb) return
  // 审批人确认的是当前头版与目标版之间的补丁；expectedPatchHash 随请求上送
  if (!confirm(`${who}：请确认你审阅的是冻结补丁 ${rb.patchHash.slice(0, 10)}（${rb.counts.text} 文本 / ${rb.counts.style} 样式 / ${rb.counts.structure} 结构）。是否通过？`)) return
  approving.value = id
  try {
    const { version } = await server.approveRollback(id, { approver: who, expectedPatchHash: rb.patchHash })
    await refresh(false)
    patchModal.open = false
    toastMsg(`审批通过：已创建新版本 ${version.id}，内容还原自已签收版本`, 'ok', 5000)
  } catch (e) {
    await refresh()
    if (e.code === 'STALE_HEAD') toastMsg(`409 ${e.message}`, 'error', 6000)
    else toastMsg(e.message, 'error', 5000)
  } finally { approving.value = null }
}

async function rejectRb(id) {
  const reason = prompt('驳回理由：')
  if (reason === null) return
  await server.rejectRollback(id, { approver: '审批人', reason })
  await refresh()
}

/** 验收：两人同时回滚（并发 Promise 交错） */
async function duel() {
  busy.value = true
  try {
    const target = versions.value.find((v) => v.signoffs.length && !v.isHead)
    if (!target) { toastMsg('需要至少一个已签收且非头版的版本（请先签收 v1）', 'warn'); busy.value = false; return }
    const a = server.createRollback({ targetVersionId: target.id, requestedBy: '编辑甲', reason: '甲要求恢复' })
    const b = server.createRollback({ targetVersionId: target.id, requestedBy: '编辑乙', reason: '乙要求恢复' })
    const [ra, rb2] = await Promise.all([a, b])
    await refresh()
    // 两人几乎同时点通过
    const [resA, resB] = await Promise.allSettled([
      server.approveRollback(ra.rollback.id, { approver: '审批人·甲', expectedPatchHash: ra.rollback.patchHash }),
      server.approveRollback(rb2.rollback.id, { approver: '审批人·乙', expectedPatchHash: rb2.rollback.patchHash }),
    ])
    await refresh(false)
    const ok = resA.status === 'fulfilled' ? '甲' : '乙'
    const no = resA.status === 'fulfilled' ? '乙' : '甲'
    toastMsg(`并发结果：${ok}成功生成回滚新版本；${no}的确认因头版已推进被拒绝/作废——旧确认没有覆盖新稿`, ok ? 'ok' : 'info', 7000)
    tab.value = 'rollback'
  } catch (e) {
    toastMsg(e.message, 'error')
  } finally { busy.value = false }
}

async function openPatch(id) {
  const { rollback: rb, patch } = await server.getRollback(id)
  patchModal.open = true
  patchModal.rb = rb
  patchModal.patch = patch
  highlightHunks.value = []
}

/* ---------------- 恢复成本视图 ---------------- */
async function showRecovery(versionId) {
  recovery.value = { versionId, ...server.recoveryInfo(versionId) }
}

/* 快照查看 */
async function pickSnapshot(versionId) {
  const root = await server.getSnapshot(versionId)
  activeSnapshot.value = { versionId, root: cloneTree(root) }
  showRecovery(versionId)
}
const activeSnapshot = ref(null)
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div>
        <h1>文稿台 · 版本比对与回滚</h1>
        <p class="sub">不可变文稿树（id 身份 / hash 内容寻址）· PG 版本图+签收 · 异步补丁服务 · 乐观锁审批</p>
      </div>
      <div class="user-box">
        当前身份
        <select v-model="currentUser">
          <option>作者A</option><option>作者B</option><option>总编</option>
        </select>
      </div>
    </header>

    <main class="layout">
      <!-- 左：草稿/快照 -->
      <div class="col col-editor">
        <div v-if="!activeSnapshot" class="editor-wrap">
          <ManuscriptEditor
            :root="draft"
            :highlight-index="highlightIndex"
            :active-node-id="activeNodeId"
            title="工作草稿"
            :badge="draftBadge"
            @update-text="onUpdateText"
            @update-section-title="onUpdateSectionTitle"
            @toggle-mark="onToggleMark"
            @add-block="onAddBlock"
            @delete-block="onDeleteBlock"
            @copy-block="onCopyBlock"
            @duplicate-block="onDuplicateBlock"
            @move-block="onMoveBlock"
            @add-section="onAddSection"
            @replace-attachment="onReplaceAttachment"
          />
          <div class="commit-bar">
            <input v-model="commitMsg" placeholder="提交说明（修改了什么）" />
            <button class="primary" :disabled="!draftDirty || busy" @click="commitDraft">提交新版本</button>
            <button class="mini" @click="resetDraft">放弃改动</button>
          </div>
        </div>
        <div v-else class="snapshot-wrap">
          <ManuscriptEditor :root="activeSnapshot.root" readonly title="只读快照" :badge="activeSnapshot.versionId" />
          <div class="snap-foot">
            <button class="mini" @click="activeSnapshot = null">← 返回草稿</button>
            <div v-if="recovery" class="recovery">
              <b>恢复成本</b>
              <span>策略：{{ recovery.strategy }}</span>
              <span>重放操作数：{{ recovery.replayOps }} ｜ 快照块数：{{ recovery.snapshotBlocks }}</span>
              <span class="note">{{ recovery.note }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 右：标签页 -->
      <div class="col col-side">
        <nav class="tabs">
          <button :class="{ active: tab === 'versions' }" @click="tab = 'versions'">版本图与签收</button>
          <button :class="{ active: tab === 'compare' }" @click="tab = 'compare'">版本比对</button>
          <button :class="{ active: tab === 'rollback' }" @click="tab = 'rollback'">回滚审批</button>
          <button :class="{ active: tab === 'oplog' }" @click="tab = 'oplog'">日志/检查点</button>
        </nav>

        <VersionPanel
          v-if="tab === 'versions'"
          :versions="versions" :draft-dirty="draftDirty" :busy="busy"
          @commit-draft="commitDraft"
          @signoff="signoff"
          @pick="pickSnapshot"
          @set-compare-pair="(id) => { cmpFrom = id; cmpTo = headId; tab = 'compare' }"
          @start-rollback="startRollback"
        />

        <ComparePanel
          v-else-if="tab === 'compare'"
          :versions="versions" :from-id="cmpFrom" :to-id="cmpTo"
          :job="job" :filter="cmpFilter" :crash-armed="crashArmed"
          :pending-auto-edit="autoEditDuring"
          @set-from="cmpFrom = $event"
          @set-to="cmpTo = $event"
          @run="runDiff"
          @retry="retryDiff"
          @crash-toggle="crashArmed = !crashArmed; server.crashNextDiff()"
          @auto-edit-toggle="autoEditDuring = !autoEditDuring"
          @filter="cmpFilter = $event"
          @hunk-click="onHunkClick"
        />

        <RollbackPanel
          v-else-if="tab === 'rollback'"
          :rollbacks="rollbacks" :versions="versions"
          :current-head-id="headId" :busy-id="approving"
          @approve="approve"
          @reject="rejectRb"
          @duel="duel"
          @open-patch="openPatch"
        />

        <div v-else class="oplog">
          <h4>检查点（内容寻址快照）</h4>
          <p class="hint">每次提交/回滚都把 rootHash 固化为检查点；任一已签收版本可零重放装载。</p>
          <h4>操作日志（hash 链）</h4>
          <ul class="log-list">
            <li v-for="l in [...oplog].reverse()" :key="l.seq">
              <code>#{{ l.seq }}</code>
              <span class="op">{{ l.op }}</span>
              <span class="actor">{{ l.actor }}</span>
              <span class="detail">{{ JSON.stringify(l.detail) }}</span>
              <code class="cksum">{{ l.checksum.slice(0, 8) }}</code>
            </li>
          </ul>
        </div>
      </div>
    </main>

    <!-- toast -->
    <transition name="toast">
      <div v-if="toast" class="toast" :class="toast.kind">{{ toast.msg }}</div>
    </transition>

    <!-- 冻结补丁弹窗 -->
    <div v-if="patchModal.open" class="modal-mask" @click.self="patchModal.open = false">
      <div class="modal">
        <header>
          <h3>冻结补丁 · {{ patchModal.rb?.id }}</h3>
          <button class="mini" @click="patchModal.open = false">关闭</button>
        </header>
        <p class="hint">
          审批人通过即表示确认这一份补丁（服务端创建时冻结，通过时重算比对）。
          patchHash <code>{{ patchModal.patch?.patchHash.slice(0, 14) }}</code>
        </p>
        <ul class="patch-hunks">
          <li v-for="h in patchModal.patch?.hunks" :key="h.id" :class="'h-' + h.type">
            <b>{{ h.type }}/{{ h.op }}</b>
            <span>{{ h.oldSummary || '' }}<template v-if="h.oldSummary != null && h.newSummary != null"> → </template>{{ h.newSummary || '' }}</span>
            <code>{{ h.nodeId }}</code>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
