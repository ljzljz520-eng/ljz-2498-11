<script setup>
import { computed } from 'vue'
import { pathLabel } from '../versioning/diff'

const props = defineProps({
  rollbacks: { type: Array, default: () => [] },
  versions: { type: Array, default: () => [] },
  currentHeadId: String,
  busyId: String,
})
const emit = defineEmits(['approve', 'reject', 'duel', 'open-patch'])

const vmap = computed(() => new Map(props.versions.map((v) => [v.id, v])))
function vLabel(id) {
  const v = vmap.value.get(id)
  return v ? `v${v.number}` : (id || '?')
}
function timeOf(ts) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
}
const STATE = {
  pending: ['待审批', 'st-pending'],
  approved: ['已通过 · 已生成新版本', 'st-approved'],
  rejected: ['已驳回', 'st-rejected'],
  superseded: ['已过期作废', 'st-superseded'],
}
</script>

<template>
  <div class="rb-wrap">
    <div class="duel-box">
      <div>
        <b>并发验收：两人同时回滚</b>
        <p>两人对【当前头版 → v1】各发一单，再同时点通过。只有一人成功，另一单因头版推进而作废。</p>
      </div>
      <button class="primary small" :disabled="busyId" @click="emit('duel')">两人同时发起并通过</button>
    </div>

    <p v-if="!rollbacks.length" class="hint">还没有回滚工单。在「版本」面板对任一已签收版本点击“发起回滚”。</p>

    <ul class="rb-list">
      <li v-for="r in [...rollbacks].reverse()" :key="r.id" class="rb-card" :class="r.state">
        <div class="rb-head">
          <span class="rb-id">{{ r.id }}</span>
          <span class="rb-state" :class="STATE[r.state][1]">{{ STATE[r.state][0] }}</span>
          <span class="rb-time">{{ timeOf(r.createdAt) }}</span>
        </div>

        <p class="rb-flow">
          {{ vLabel(r.baseHeadId) }} <code class="hash">{{ r.baseHeadHash.slice(0,8) }}</code>
          <span class="big-arrow">⟹</span>
          {{ vLabel(r.targetVersionId) }} <code class="hash">{{ r.targetRootHash.slice(0,8) }}</code>
        </p>
        <p class="rb-meta">
          发起人 {{ r.requestedBy }} · 理由：{{ r.reason || '（未填）' }}
        </p>

        <div class="counts">
          <span class="ct ct-text">文本 {{ r.counts.text }}</span>
          <span class="ct ct-style">样式 {{ r.counts.style }}</span>
          <span class="ct ct-structure">结构 {{ r.counts.structure }}</span>
          <button class="mini" @click="emit('open-patch', r.id)">查看冻结补丁</button>
          <code class="ph">patch {{ r.patchHash.slice(0, 10) }}</code>
        </div>

        <div v-if="r.state === 'pending'" class="base-line" :class="{ stale: r.baseHeadId !== currentHeadId }">
          <template v-if="r.baseHeadId === currentHeadId">
            ✅ 补丁基线仍是当前头版 {{ vLabel(r.baseHeadId) }}，可以审批
          </template>
          <template v-else>
            ⚠️ 当前头版已变为 {{ vLabel(currentHeadId) }}，本单基线 {{ vLabel(r.baseHeadId) }} 过期，
            通过将被服务端拒绝
          </template>
        </div>

        <p v-if="r.supersedeReason" class="reason">作废原因：{{ r.supersedeReason }}</p>
        <p v-else-if="r.state === 'approved'" class="reason ok">
          {{ r.approvedBy }} 已通过，生成新版本 {{ r.resultVersionId }}（内容字节级等同 {{ vLabel(r.targetVersionId) }}）
        </p>

        <!-- 审批操作：两个人的按钮，方便点出并发 -->
        <div v-if="r.state === 'pending'" class="approve-row">
          <button class="approve" :disabled="busyId === r.id" @click="emit('approve', { id: r.id, who: '审批人·甲' })">
            甲：确认补丁并通过
          </button>
          <button class="approve alt" :disabled="busyId === r.id" @click="emit('approve', { id: r.id, who: '审批人·乙' })">
            乙：确认补丁并通过
          </button>
          <button class="mini" :disabled="busyId === r.id" @click="emit('reject', r.id)">驳回</button>
          <span v-if="busyId === r.id" class="spinner" />
        </div>

        <details class="history">
          <summary>流转记录</summary>
          <ul>
            <li v-for="(h, i) in r.history" :key="i">{{ timeOf(h.at) }} · {{ h.by }} · {{ h.action }} — {{ h.detail }}</li>
          </ul>
        </details>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.rb-wrap { display: flex; flex-direction: column; gap: 12px; }
.duel-box {
  display: flex; gap: 12px; align-items: center; justify-content: space-between;
  background: #1c1636; border: 1px solid #4a3a8c; border-radius: 10px; padding: 11px 14px;
}
.duel-box p { margin: 4px 0 0; font-size: 11px; color: #a99ee0; }
.primary {
  padding: 8px 14px; border-radius: 8px; border: none; cursor: pointer; white-space: nowrap;
  background: linear-gradient(135deg, #4a63d8, #6e54d8); color: #fff; font-weight: 700; font-size: 12px;
}
.primary:disabled { opacity: .4; cursor: not-allowed; }
.hint { font-size: 12px; color: #7e8bc0; }
.rb-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.rb-card { background: #141a2e; border: 1px solid #28304a; border-radius: 10px; padding: 12px 14px; }
.rb-card.pending { border-color: #4a5fb0; }
.rb-card.approved { border-color: #1f5c43; }
.rb-card.rejected { border-color: #5c3a1f; opacity: .85; }
.rb-card.superseded { border-color: #5c1f38; opacity: .9; }
.rb-head { display: flex; align-items: center; gap: 9px; }
.rb-id { font-family: monospace; font-size: 12px; color: #9db4ff; }
.rb-state { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 9px; }
.st-pending { background: #1d2748; color: #9db4ff; }
.st-approved { background: #103326; color: #6fe0ac; }
.st-rejected { background: #3a2a10; color: #f0c14b; }
.st-superseded { background: #3a1626; color: #ff9cbc; }
.rb-time { margin-left: auto; font-size: 11px; color: #7e8bc0; }
.rb-flow { margin: 9px 0 3px; font-size: 14px; font-weight: 700; color: #e8ecff; }
.big-arrow { color: #8fa6ff; margin: 0 4px; }
.hash { font-size: 11px; color: #9db4ff; font-weight: 400; }
.rb-meta { margin: 2px 0; font-size: 12px; color: #aeb9e4; }
.counts { display: flex; align-items: center; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
.ct { font-size: 11px; border-radius: 8px; padding: 2px 9px; }
.ct-text { background: #103326; color: #46e0a0; }
.ct-style { background: #332a10; color: #f0c14b; }
.ct-structure { background: #3a1626; color: #ff7aa2; }
.ph { font-size: 10px; color: #7e8bc0; }
.base-line { font-size: 11px; color: #87efbf; background: #10231c; border: 1px solid #1f4d3a; border-radius: 7px; padding: 6px 9px; }
.base-line.stale { color: #f3a26c; background: #2e2010; border-color: #6b4a1f; }
.reason { font-size: 11px; color: #ff9cbc; margin: 6px 0 0; }
.reason.ok { color: #6fe0ac; }
.approve-row { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.approve {
  font-size: 12px; font-weight: 700; padding: 8px 14px; border-radius: 8px; cursor: pointer;
  border: none; background: #1f7a52; color: #eafff5;
}
.approve.alt { background: #4a5fb0; }
.approve:disabled { opacity: .45; cursor: not-allowed; }
.spinner {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid #33406e; border-top-color: #8fa6ff;
  animation: spin .8s linear infinite; display: inline-block;
}
@keyframes spin { to { transform: rotate(360deg); } }
.history { margin-top: 8px; font-size: 11px; color: #7e8bc0; }
.history ul { margin: 6px 0 0; padding-left: 16px; }
.mini {
  font-size: 11px; padding: 4px 9px; border-radius: 6px;
  background: #222c4d; color: #c6d1ff; border: 1px solid #33406e; cursor: pointer;
}
.mini:disabled { opacity: .4; }
</style>
