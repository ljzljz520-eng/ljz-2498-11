<script setup>
import { computed } from 'vue'
import { pathLabel } from '../versioning/diff'

const props = defineProps({
  versions: { type: Array, default: () => [] },
  fromId: String,
  toId: String,
  job: Object, // {state, baseHeadHash, currentHeadHash, stale, result, error}
  filter: { type: String, default: 'all' },
  crashArmed: Boolean,
  pendingAutoEdit: Boolean,
})
const emit = defineEmits([
  'set-from', 'set-to', 'run', 'retry', 'crash-toggle',
  'auto-edit-toggle', 'filter', 'hunk-click',
])

const vmap = computed(() => new Map(props.versions.map((v) => [v.id, v])))
const patch = computed(() => props.job?.result || null)

const visibleHunks = computed(() => {
  if (!patch.value) return []
  return props.filter === 'all' ? patch.value.hunks : patch.value.hunks.filter((h) => h.type === props.filter)
})

const TYPE_LABEL = { text: '文本', style: '样式', structure: '结构' }
const OP_LABEL = {
  modify: '修改', move: '移动', delete: '删除', insert: '新增',
  'section-add': '新增章节', 'section-delete': '删除章节',
  'attachment-replaced': '附件替换',
}

function labelOf(h) {
  const parts = [TYPE_LABEL[h.type]]
  parts.push(OP_LABEL[h.op] || h.op)
  if (h.op === 'insert' && h.copied) parts.push(h.tokens ? '复制后改写' : '复制(新身份)')
  if (h.blockKind === 'section-title') parts.push('章节标题')
  return parts.join(' · ')
}
function vLabel(id) {
  const v = vmap.value.get(id)
  return v ? `v${v.number}` : id
}
function marksText(arr) { return (arr || []).map((m) => ({ bold: '粗体', italic: '斜体', quote: '引用' }[m] || m)).join('、') }
</script>

<template>
  <div class="cmp">
    <div class="pair-box">
      <label>基线</label>
      <select :value="fromId" @change="emit('set-from', $event.target.value)">
        <option v-for="v in versions" :key="v.id" :value="v.id">v{{ v.number }} {{ v.message }}</option>
      </select>
      <span class="arrow">⟶</span>
      <label>目标</label>
      <select :value="toId" @change="emit('set-to', $event.target.value)">
        <option v-for="v in versions" :key="v.id" :value="v.id">v{{ v.number }} {{ v.message }}</option>
      </select>
      <button class="primary small" :disabled="!fromId || !toId || fromId === toId || job?.state === 'running'"
              @click="emit('run')">开始比对</button>
    </div>

    <div class="sim-box">
      <label class="switch" :class="{ on: crashArmed }">
        <input type="checkbox" :checked="crashArmed" @change="emit('crash-toggle')">
        模拟比对进程崩溃（下次任务）
      </label>
      <label class="switch" :class="{ on: pendingAutoEdit }">
        <input type="checkbox" :checked="pendingAutoEdit" @change="emit('auto-edit-toggle')">
        比对期间自动制造新编辑（验证旧结果拒收）
      </label>
    </div>

    <!-- 任务状态 -->
    <div v-if="job" class="job-status" :class="job.state">
      <template v-if="job.state === 'running'">
        <span class="spinner" /> 比对在后台执行（读取不可变快照）…
        <span class="job-hash">信封 baseHead: {{ job.baseHeadHash?.slice(0, 10) }}｜当前 HEAD: {{ job.currentHeadHash?.slice(0, 10) }}</span>
      </template>
      <template v-else-if="job.state === 'failed'">
        <b>💥 {{ job.error }}</b>
        <button class="mini" @click="emit('retry')">重新发起任务</button>
      </template>
      <template v-else-if="job.state === 'succeeded' && job.stale">
        <b class="stale">🚫 结果已拒收：回包 baseHead {{ job.baseHeadHash.slice(0, 8) }} 已过期，当前 HEAD {{ job.currentHeadHash.slice(0, 8) }}。</b>
        <span>前端保留了节点锚点与筛选状态，请按新头版重新比对。</span>
        <button class="mini" @click="emit('retry')">用新基线重新比对</button>
      </template>
      <template v-else-if="job.state === 'succeeded'">
        <b class="ok">✅ 补丁就绪</b>
        <span>{{ vLabel(patch.fromVersionId) }} ⟶ {{ vLabel(patch.toVersionId) }} · {{ patch.hunks.length }} 处差异 ·
          patchHash <code>{{ patch.patchHash.slice(0, 12) }}</code></span>
      </template>
    </div>

    <!-- 过滤器 -->
    <div v-if="patch && !job.stale && job.state === 'succeeded'" class="filters">
      <button v-for="f in [['all','全部'],['text','文本'],['style','样式'],['structure','结构']]" :key="f[0]"
              class="fbtn" :class="{ active: filter === f[0] }" @click="emit('filter', f[0])">
        {{ f[1] }}
        <em v-if="f[0] !== 'all'" class="cnt">{{ patch.counts[f[0]] }}</em>
        <em v-else class="cnt">{{ patch.hunks.length }}</em>
      </button>
    </div>

    <!-- hunk 卡片 -->
    <div v-if="patch && !job.stale && job.state === 'succeeded'" class="hunks">
      <button v-for="h in visibleHunks" :key="h.id"
              class="hunk" :class="['h-' + h.type, 'op-' + h.op]"
              @click="emit('hunk-click', h)">
        <div class="h-head">
          <span class="h-type">{{ labelOf(h) }}</span>
          <span class="h-path">{{ pathLabel(h) }}</span>
        </div>

        <!-- 行内文本 -->
        <div v-if="h.tokens" class="inline">
          <span v-for="(tk, i) in h.tokens" :key="i" :class="'tk tk-' + tk.t">{{ tk.text }}</span>
        </div>

        <!-- 样式 -->
        <div v-if="h.type === 'style'" class="style-diff">
          <span v-if="h.removedMarks?.length" class="mark-del">－ {{ marksText(h.removedMarks) }}</span>
          <span v-if="h.addedMarks?.length" class="mark-add">＋ {{ marksText(h.addedMarks) }}</span>
        </div>

        <!-- 结构摘要 -->
        <div v-if="h.type === 'structure'" class="struct">
          <div v-if="h.oldSummary != null" class="s-old">旧：{{ h.oldSummary || '（空）' }}</div>
          <div v-if="h.newSummary != null" class="s-new">新：{{ h.newSummary || '（空）' }}</div>
          <div v-if="h.op === 'move'" class="s-move">
            父章节 {{ h.oldParentId || '根' }} → {{ h.newParentId || '根' }}（id 不变：<code>{{ h.nodeId }}</code>）
          </div>
          <div v-if="h.op === 'insert' && h.copied" class="s-copy">
            来源节点 <code>{{ h.likeCopyOf }}</code>，复制后 id=<code>{{ h.nodeId }}</code>（身份不复用）
          </div>
          <div v-if="h.op === 'insert' && !h.copied" class="s-copy">全新 id=<code>{{ h.nodeId }}</code>（新增，非删除后重建）</div>
          <div v-if="h.op === 'delete'" class="s-copy">删除 id=<code>{{ h.nodeId }}</code>，新版不存在同身份节点</div>
          <div v-if="h.op === 'attachment-replaced'" class="s-copy">附件 id 不变，blobHash 已变化</div>
        </div>
      </button>
      <p v-if="!visibleHunks.length" class="hint">该类别下没有差异。</p>
    </div>
  </div>
</template>

<style scoped>
.cmp { display: flex; flex-direction: column; gap: 12px; }
.pair-box { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pair-box label { font-size: 11px; color: #7e8bc0; }
.pair-box select {
  flex: 1; min-width: 120px; background: #141a2e; color: #dfe5ff;
  border: 1px solid #33406e; border-radius: 7px; padding: 6px 8px; font-size: 12px;
}
.arrow { color: #6d7bd8; font-weight: 800; }
.primary {
  padding: 7px 14px; border-radius: 8px; border: none; cursor: pointer;
  background: linear-gradient(135deg, #4a63d8, #6e54d8); color: #fff; font-weight: 700;
}
.primary.small { font-size: 12px; }
.primary:disabled { opacity: .4; cursor: not-allowed; }
.sim-box { display: flex; flex-direction: column; gap: 6px; }
.switch { font-size: 11px; color: #9aa8d8; display: flex; gap: 7px; align-items: center; cursor: pointer; }
.switch.on { color: #f3a26c; }
.job-status {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: #141a2e; border: 1px solid #28304a; border-radius: 9px;
  padding: 10px 12px; font-size: 12px; color: #b9c4ec;
}
.job-status.failed { border-color: #6b2d47; color: #ff9cbc; }
.job-status .ok { color: #6fe0ac; }
.job-status .stale { color: #f3a26c; }
.job-hash { font-size: 11px; color: #7e8bc0; width: 100%; }
.spinner {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid #33406e; border-top-color: #8fa6ff;
  animation: spin .8s linear infinite; display: inline-block;
}
@keyframes spin { to { transform: rotate(360deg); } }
.filters { display: flex; gap: 7px; }
.fbtn {
  font-size: 12px; padding: 5px 11px; border-radius: 7px; cursor: pointer;
  background: #1d2748; color: #b9c4ec; border: 1px solid #33406e;
}
.fbtn.active { background: #38447e; border-color: #6d7bd8; color: #fff; }
.fbtn .cnt {
  font-style: normal; margin-left: 5px; font-size: 10px;
  background: #0d1326; border-radius: 8px; padding: 1px 6px;
}
.hunks { display: flex; flex-direction: column; gap: 9px; max-height: 52vh; overflow: auto; padding-right: 4px; }
.hunk {
  text-align: left; background: #141a2e; border: 1px solid #28304a;
  border-radius: 9px; padding: 10px 12px; cursor: pointer; color: inherit;
  transition: border-color .15s, transform .1s;
}
.hunk:hover { border-color: #5a6db5; transform: translateX(2px); }
.h-text { border-left: 3px solid #2fbf88; }
.h-style { border-left: 3px solid #d8a72e; }
.h-structure { border-left: 3px solid #e0568b; }
.h-head { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 5px; }
.h-type { font-size: 12px; font-weight: 700; color: #dfe5ff; }
.h-path { font-size: 10px; color: #7e8bc0; white-space: nowrap; }
.inline { font-size: 13px; line-height: 1.8; color: #8b96c4; }
.tk-eq { color: #aeb9e4; }
.tk-del { background: #4a1f30; color: #ffb3cd; text-decoration: line-through; border-radius: 3px; }
.tk-ins { background: #16402f; color: #87efbf; border-radius: 3px; }
.style-diff { display: flex; gap: 14px; font-size: 12px; }
.mark-del { color: #ff9cbc; }
.mark-add { color: #f0c14b; }
.struct { font-size: 12px; color: #b9c4ec; display: flex; flex-direction: column; gap: 3px; }
.s-old { color: #ff9cbc; }
.s-new { color: #87efbf; }
.s-move, .s-copy { color: #9db4ff; font-size: 11px; }
.s-move code, .s-copy code { color: #c8d4ff; }
.hint { font-size: 11px; color: #7e8bc0; }
.mini {
  font-size: 11px; padding: 4px 9px; border-radius: 6px;
  background: #222c4d; color: #c6d1ff; border: 1px solid #33406e; cursor: pointer;
}
</style>
