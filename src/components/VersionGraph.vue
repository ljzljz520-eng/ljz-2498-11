<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  versions: { type: Array, required: true },
  selected: { type: String, default: '' },
  proposals: { type: Array, default: () => [] },
})
const emit = defineEmits([
  'select', 'compare', 'signoff', 'inspect',
  'approve', 'reject', 'validate',
])

const baseId = ref('')
const targetId = ref('')
const signer = ref('reviewer-li')
const reason = ref('内容核对无误，同意签收')
const approvalReason = ref('同意按补丁回滚')

const headId = computed(() => props.versions[props.versions.length - 1]?.id)

// 默认：基准=当前头版，目标=上一版；新版本提交后自动跟随头版
watch(headId, (h, oldH) => {
  if (!h) return
  if (!baseId.value || baseId.value === oldH) baseId.value = h
  if (!targetId.value && props.versions.length >= 2) {
    targetId.value = props.versions[props.versions.length - 2].id
  }
}, { immediate: true })

function signoffsOf(v) {
  // 通过事件由上层提供数据成本高；这里直接读版本对象上挂的签收列表（App 注入 signoffMap）
  return props.signoffMap?.[v.id] || []
}
defineExpose({ setPair: (b, t) => { baseId.value = b; targetId.value = t } })
</script>

<template>
  <section class="panel side-panel">
    <div class="panel-header"><h2>版本图 · 签收 · 审批</h2></div>

    <div class="compare-picker">
      <label>基准版（当前头版）
        <select v-model="baseId">
          <option v-for="v in versions" :key="v.id" :value="v.id">
            {{ v.id }} · seq{{ v.seq }}{{ v.id === headId ? ' · HEAD' : '' }}{{ v.signedOff ? ' · 已签收' : '' }}
          </option>
        </select>
      </label>
      <label>目标版
        <select v-model="targetId">
          <option v-for="v in versions" :key="v.id" :value="v.id">
            {{ v.id }} · seq{{ v.seq }}{{ v.id === headId ? ' · HEAD' : '' }}{{ v.signedOff ? ' · 已签收' : '' }}
          </option>
        </select>
      </label>
      <button class="primary-sm" type="button" :disabled="!baseId || !targetId || baseId === targetId"
        @click="emit('compare', baseId, targetId)">
        比较版本（异步）
      </button>
    </div>

    <div class="version-list">
      <div
        v-for="v in [...versions].reverse()"
        :key="v.id"
        class="version-row"
        :class="{ head: v.id === headId, chosen: v.id === selected }"
        @click="emit('select', v.id)"
      >
        <div class="vr-main">
          <code class="vr-id">{{ v.id }}</code>
          <span class="vr-seq">seq{{ v.seq }}</span>
          <span v-if="v.id === headId" class="tag head-tag">HEAD</span>
          <span v-if="v.isCheckpoint" class="tag cp-tag">检查点</span>
          <span v-if="v.signedOff" class="tag sign-tag">已签收</span>
        </div>
        <div class="vr-meta">{{ v.message }} · {{ v.author }} · {{ v.opCount }} 条操作</div>
        <div v-for="s in signoffsOf(v)" :key="s.at" class="signoff-line">
          ✍ {{ s.signer }}：{{ s.reason }}
        </div>
        <div class="vr-actions">
          <button type="button" class="mini" @click.stop="emit('inspect', v.id)">独立还原/成本</button>
          <button type="button" class="mini" @click.stop="emit('signoff', v.id, signer, reason)">签收（强制快照）</button>
        </div>
        <div v-if="v.parentId" class="vr-parent">↑ parent {{ v.parentId }}</div>
      </div>
    </div>

    <div class="signoff-form">
      <input v-model="signer" placeholder="签收人" />
      <input v-model="reason" placeholder="签收理由" />
    </div>

    <div class="proposal-block">
      <h3>回滚审批中的提案</h3>
      <p v-if="!proposals.length" class="empty">暂无提案。比较后可在补丁区发起。</p>
      <div v-for="p in proposals" :key="p.id" class="proposal" :class="p.status.toLowerCase()">
        <div class="p-head">
          <code>{{ p.id }}</code>
          <span class="pstatus" :class="p.status.toLowerCase()">{{ p.status }}</span>
        </div>
        <div class="p-flow">
          <code>{{ p.baseHeadVersionId }}@seq{{ p.baseHeadSeq }}</code>
          <span class="arrow2">补丁 →</span>
          <code>{{ p.targetVersionId }}</code>
        </div>
        <div class="p-reason">理由：{{ p.reason }}</div>
        <div class="p-cs">checksum <code>{{ p.patchChecksum.slice(0, 12) }}…</code></div>
        <div v-if="p.newVersionId" class="p-done">已生成新版本 <code>{{ p.newVersionId }}</code></div>
        <div class="p-actions" v-if="p.status === 'OPEN'">
          <input v-model="approvalReason" placeholder="审批意见" />
          <button type="button" class="mini ok" @click="emit('validate', p.id)">重新校验</button>
          <button type="button" class="mini ok" @click="emit('approve', p.id, approvalReason)">确认审批并回滚</button>
          <button type="button" class="mini no" @click="emit('reject', p.id, approvalReason)">拒绝</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.side-panel { min-height: 0; }
.compare-picker { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.compare-picker label { font-size: 0.72rem; color: var(--muted); display: flex; flex-direction: column; gap: 3px; }
.compare-picker select { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); font-size: 0.82rem; }
.primary-sm { margin-top: 4px; border: 0; background: var(--accent); color: #fff; border-radius: 8px; padding: 7px; cursor: pointer; font-size: 0.82rem; }
.primary-sm:disabled { opacity: 0.5; cursor: not-allowed; }
.version-list { max-height: 280px; overflow: auto; padding: 6px 10px; display: flex; flex-direction: column; gap: 6px; }
.version-row { border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; cursor: pointer; background: #fff; transition: all .15s; }
.version-row:hover { border-color: var(--accent); }
.version-row.chosen { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent); }
.version-row.head { background: var(--accent-soft); }
.vr-main { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.vr-id { font-family: var(--mono); font-weight: 700; font-size: 0.78rem; }
.vr-seq { font-size: 0.7rem; color: var(--muted); }
.tag { font-size: 0.62rem; padding: 1px 6px; border-radius: 999px; color: #fff; }
.head-tag { background: var(--accent); }
.cp-tag { background: #6b7280; }
.sign-tag { background: #b5832b; }
.vr-meta { font-size: 0.72rem; color: var(--muted); margin-top: 2px; }
.vr-parent { font-size: 0.66rem; color: #93a29a; font-family: var(--mono); }
.signoff-line { font-size: 0.7rem; color: #8a5e12; margin-top: 2px; }
.vr-actions { display: flex; gap: 6px; margin-top: 6px; }
.mini { font-size: 0.68rem; border: 1px solid var(--border); background: #fff; border-radius: 7px; padding: 3px 7px; cursor: pointer; }
.mini:hover { border-color: var(--accent); color: var(--accent); }
.mini.ok { border-color: #2f8f63; color: #2f8f63; }
.mini.no { border-color: var(--danger); color: var(--danger); }
.signoff-form { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--border); }
.signoff-form input { width: 50%; font-size: 0.72rem; padding: 5px 7px; border: 1px solid var(--border); border-radius: 7px; }
.proposal-block { border-top: 1px solid var(--border); padding: 10px 12px; }
.proposal-block h3 { margin: 0 0 6px; font-size: 0.82rem; }
.empty { font-size: 0.74rem; color: var(--muted); }
.proposal { border: 1px solid var(--border); border-radius: 10px; padding: 8px; margin-bottom: 8px; background: #fff; }
.proposal.approved { border-color: var(--accent); background: var(--accent-soft); }
.proposal.stale, .proposal.rejected, .proposal.superseded { border-color: var(--danger); background: #fdf0ee; }
.p-head { display: flex; justify-content: space-between; align-items: center; }
.pstatus { font-size: 0.66rem; padding: 1px 7px; border-radius: 999px; background: #eef1ef; }
.pstatus.open { background: #e6f2fb; color: #1e5a87; }
.pstatus.approved { background: var(--accent); color: #fff; }
.pstatus.stale, .pstatus.rejected, .pstatus.superseded { background: var(--danger); color: #fff; }
.p-flow { font-size: 0.74rem; margin: 5px 0; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.arrow2 { color: var(--muted); }
.p-reason, .p-cs { font-size: 0.7rem; color: var(--muted); }
.p-cs code, .p-flow code, .p-done code { font-family: var(--mono); }
.p-done { font-size: 0.72rem; color: var(--accent); margin-top: 3px; }
.p-actions { display: flex; gap: 5px; margin-top: 6px; flex-wrap: wrap; }
.p-actions input { flex: 1; min-width: 90px; font-size: 0.7rem; padding: 4px 6px; border: 1px solid var(--border); border-radius: 6px; }
</style>
