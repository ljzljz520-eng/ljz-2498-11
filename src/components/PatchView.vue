<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  result: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  droppedStale: { type: Number, default: 0 },
})
const emit = defineEmits(['anchor', 'propose'])

const activeDim = ref('structure')
const dims = [
  { key: 'structure', label: '结构', tone: 'struct' },
  { key: 'text', label: '文本', tone: 'text' },
  { key: 'style', label: '样式', tone: 'style' },
]

const grouped = computed(() => {
  if (!props.result) return { move: [], delete: [], copy: [], insert: [], text: [], style: [] }
  const g = { move: [], delete: [], copy: [], insert: [], text: [], style: [] }
  for (const op of props.result.patch.ops) g[op.kind].push(op)
  return g
})

const counts = computed(() => props.result?.patch.dimensions || { structure: 0, text: 0, style: 0 })

function anchorIdOf(op) {
  if (op.kind === 'move') return op.to?.id || op.id
  if (op.kind === 'delete') return op.from?.id || op.id
  return op.anchor?.id || op.id
}
function parentLabel(op) {
  const a = op.kind === 'move' ? `${op.from?.parentId ?? '?'}[${op.from?.index}]` : `${op.anchor?.parentId ?? op.parentId ?? '?'}`
  return a
}
const reason = ref('')
function display(v) {
  if (v === null || v === undefined) return '∅'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
function propose() {
  emit('propose', props.result, reason.value || '确认人审批：当前头版 → 目标版')
  reason.value = ''
}
</script>

<template>
  <section class="panel patch-panel">
    <div class="panel-header">
      <h2>补丁预览（按段落与格式）</h2>
      <div v-if="result" class="token">
        job {{ result.jobId }} · 请求 #{{ result.requestSeq }} · 头版 {{ result.headVersionIdAtCompute }}
        <span class="seq">seq={{ result.headSeqAtCompute }}</span>
      </div>
    </div>

    <div class="dim-tabs">
      <button
        v-for="d in dims"
        :key="d.key"
        type="button"
        class="dim-tab"
        :class="[d.tone, { active: activeDim === d.key }]"
        @click="activeDim = d.key"
      >
        {{ d.label }}
        <b>{{ counts[d.key] }}</b>
      </button>
      <span v-if="droppedStale" class="dropped">已拒绝 {{ droppedStale }} 个过期回包</span>
    </div>

    <div v-if="loading" class="state">
      <div class="spinner" />
      正在异步比较大文稿（分片执行，旧请求已取消）…
    </div>
    <div v-else-if="error" class="state error">{{ error }}</div>
    <div v-else-if="!result" class="state">在左侧选择两个版本后点击「比较版本」。补丁带 checksum，确认人审批的就是它。</div>

    <div v-else class="patch-body">
      <!-- 结构维度 -->
      <template v-if="activeDim === 'structure'">
        <div v-for="op in grouped.move" :key="`m${op.id}`" class="hunk move" :data-anchor="op.to.id">
          <div class="hunk-head">
            <span class="badge move">移动 MOVE</span>
            <code class="node-id">{{ op.id }}</code>
            <button type="button" class="link" @click="emit('anchor', anchorIdOf(op))">定位节点</button>
          </div>
          <p class="locs">
            <span class="loc-from">{{ op.from.parentId }} [{{ op.from.index }}]</span>
            <span class="arrow">→</span>
            <span class="loc-to">{{ op.to.parentId }} [{{ op.to.index }}]</span>
          </p>
          <p class="hint">身份不变（同一 id 换了父/序），与"删除后新增"严格区分。</p>
        </div>

        <div v-for="op in grouped.copy" :key="`c${op.id}`" class="hunk copy" :data-anchor="op.id">
          <div class="hunk-head">
            <span class="badge copy">复制 COPY</span>
            <code class="node-id">{{ op.id }}</code>
            <span class="muted">源自</span>
            <code class="node-id from">{{ op.fromId }}</code>
            <button type="button" class="link" @click="emit('anchor', anchorIdOf(op))">定位节点</button>
          </div>
          <p class="hint">内容指纹相同，但整棵子树换发新身份，原身份不复用。</p>
        </div>

        <div v-for="op in grouped.insert" :key="`i${op.id}`" class="hunk insert" :data-anchor="op.id">
          <div class="hunk-head">
            <span class="badge insert">新增 INSERT</span>
            <code class="node-id">{{ op.id }}</code>
            <span class="muted">挂于</span><code>{{ parentLabel(op) }}</code>
            <button type="button" class="link" @click="emit('anchor', anchorIdOf(op))">定位节点</button>
          </div>
        </div>

        <div v-for="op in grouped.delete" :key="`d${op.id}`" class="hunk delete" :data-anchor="op.id">
          <div class="hunk-head">
            <span class="badge delete">删除 DELETE</span>
            <code class="node-id">{{ op.id }}</code>
            <span class="muted">原位于</span><code>{{ op.parentId }} [{{ op.index }}]</code>
          </div>
          <p class="hint">id 在目标树中彻底消失（对比移动：移动仍能找到同 id）。</p>
        </div>

        <p v-if="!grouped.move.length && !grouped.copy.length && !grouped.insert.length && !grouped.delete.length" class="state">
          两版本结构一致。
        </p>
      </template>

      <!-- 文本维度：段落级逐段渲染，段内删/增带行内底色 -->
      <template v-else-if="activeDim === 'text'">
        <article v-for="op in grouped.text" :key="`t${op.id}`" class="hunk text-hunk" :data-anchor="op.id">
          <div class="hunk-head">
            <span class="badge text">文本 TEXT</span>
            <code class="node-id">{{ op.id }}</code>
            <code class="crumb">{{ op.anchor.path.slice(1).map((p) => p).join(' / ') }}</code>
            <button type="button" class="link" @click="emit('anchor', anchorIdOf(op))">定位段落</button>
          </div>
          <p class="para-diff">
            <span
              v-for="(seg, i) in op.segments"
              :key="i"
              class="seg"
              :class="{ del: seg.type === 'del', ins: seg.type === 'ins' }"
              :data-mark="seg.type === 'del' ? '-' : seg.type === 'ins' ? '+' : ' '"
            >{{ seg.text }}</span>
          </p>
        </article>
        <p v-if="!grouped.text.length" class="state">两版本文本一致。</p>
      </template>

      <!-- 样式维度 -->
      <template v-else>
        <article v-for="op in grouped.style" :key="`s${op.id}`" class="hunk style-hunk" :data-anchor="op.id">
          <div class="hunk-head">
            <span class="badge style">样式 STYLE</span>
            <code class="node-id">{{ op.id }}</code>
            <button type="button" class="link" @click="emit('anchor', anchorIdOf(op))">定位节点</button>
          </div>
          <table class="style-table">
            <tbody>
              <tr v-for="c in op.attrChanges" :key="c.key">
                <td class="k">{{ c.key }}</td>
                <td class="v del-cell"><code>{{ display(c.before) }}</code></td>
                <td class="arr">→</td>
                <td class="v ins-cell"><code>{{ display(c.after) }}</code></td>
              </tr>
              <tr v-for="(c, i) in op.markChanges" :key="`m${i}`">
                <td class="k">{{ c.mark }} [{{ c.range.from }}–{{ c.range.to }}]</td>
                <td class="v del-cell"><code>{{ display(c.before) }}</code></td>
                <td class="arr">{{ c.type }}</td>
                <td class="v ins-cell"><code>{{ display(c.after) }}</code></td>
              </tr>
            </tbody>
          </table>
        </article>
        <p v-if="!grouped.style.length" class="state">两版本样式一致。</p>
      </template>

      <div v-if="result" class="propose-bar">
        <input v-model="reason" class="reason-input" placeholder="审批意见 / 回滚理由（PG sign_offs.reason）" />
        <button type="button" class="primary" @click="propose">发起回滚审批（头版 → 目标版）</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.patch-panel { min-height: 0; }
.token { font-size: 0.72rem; color: var(--muted); font-family: var(--mono); }
.token .seq { color: var(--accent); margin-left: 6px; }
.dim-tabs { display: flex; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); align-items: center; flex-wrap: wrap; }
.dim-tab { border: 1px solid var(--border); background: #fff; border-radius: 999px; padding: 5px 12px; cursor: pointer; font-size: 0.82rem; display: inline-flex; gap: 6px; align-items: center; }
.dim-tab b { font-size: 0.72rem; background: #eef3f0; border-radius: 999px; padding: 1px 7px; }
.dim-tab.active.struct { border-color: #7c5cbf; color: #5b3fa8; background: #f2edfb; }
.dim-tab.active.text { border-color: #b5832b; color: #8a5e12; background: #fbf3e2; }
.dim-tab.active.style { border-color: #2b7ab5; color: #1e5a87; background: #e6f2fb; }
.dropped { margin-left: auto; color: var(--danger); font-size: 0.75rem; }
.state { padding: 26px 18px; color: var(--muted); text-align: center; }
.state.error { color: var(--danger); }
.spinner { width: 22px; height: 22px; border: 3px solid #d6e1db; border-top-color: var(--accent); border-radius: 50%; margin: 0 auto 10px; animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.patch-body { overflow: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.hunk { border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; background: #fff; }
.hunk.move { border-left: 4px solid #7c5cbf; }
.hunk.copy { border-left: 4px solid #0f9d8f; }
.hunk.insert { border-left: 4px solid var(--accent); }
.hunk.delete { border-left: 4px solid var(--danger); }
.hunk.text-hunk { border-left: 4px solid #b5832b; }
.hunk.style-hunk { border-left: 4px solid #2b7ab5; }
.hunk-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.badge { font-size: 0.68rem; padding: 2px 8px; border-radius: 999px; color: #fff; letter-spacing: .04em; }
.badge.move { background: #7c5cbf; }
.badge.copy { background: #0f9d8f; }
.badge.insert { background: var(--accent); }
.badge.delete { background: var(--danger); }
.badge.text { background: #b5832b; }
.badge.style { background: #2b7ab5; }
.node-id { font-family: var(--mono); font-size: 0.74rem; background: #f0f3f1; padding: 1px 6px; border-radius: 6px; }
.node-id.from { background: #e3f6f3; color: #0a6e64; }
.muted { color: var(--muted); font-size: 0.75rem; }
.link { border: 0; background: none; color: var(--accent); cursor: pointer; font-size: 0.75rem; padding: 0; }
.locs { margin: 6px 0 0; font-family: var(--mono); font-size: 0.78rem; display: flex; gap: 8px; align-items: center; }
.loc-from { color: var(--danger); }
.loc-to { color: var(--accent); }
.arrow { color: var(--muted); }
.hint { margin: 6px 0 0; font-size: 0.74rem; color: var(--muted); }
.para-diff { margin: 8px 0 0; line-height: 1.9; font-size: 0.92rem; white-space: pre-wrap; }
.seg.del { background: #fbe3e0; color: #8e2a20; text-decoration: line-through; border-radius: 3px; padding: 0 1px; }
.seg.ins { background: #dcf3e6; color: #0f5c38; border-radius: 3px; padding: 0 1px; }
.crumb { font-size: 0.68rem; color: var(--muted); }
.style-table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 0.8rem; }
.style-table td { padding: 4px 8px; border-bottom: 1px dashed #e3ebe6; vertical-align: top; }
.style-table .k { font-family: var(--mono); color: #1e5a87; width: 34%; }
.del-cell code { background: #fbe3e0; }
.ins-cell code { background: #dcf3e6; }
.arr { color: var(--muted); width: 26px; text-align: center; }
.propose-bar { display: flex; gap: 8px; margin-top: 6px; position: sticky; bottom: 0; background: linear-gradient(180deg, transparent, #fff 30%); padding-top: 10px; }
.reason-input { flex: 1; border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; font-size: 0.85rem; }
.primary { border: 0; background: var(--accent); color: #fff; border-radius: 10px; padding: 8px 14px; cursor: pointer; font-size: 0.85rem; white-space: nowrap; }
.primary:hover { filter: brightness(1.08); }
</style>
