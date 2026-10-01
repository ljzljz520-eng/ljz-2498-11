<script setup>
defineProps({
  versions: { type: Array, default: () => [] },
  draftDirty: Boolean,
  busy: Boolean,
})
const emit = defineEmits(['commit-draft', 'signoff', 'pick', 'set-compare-pair', 'start-rollback'])

function timeOf(ts) {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function shortHash(h) { return h.slice(0, 10) }
</script>

<template>
  <div class="panel-stack">
    <div class="action-box">
      <button class="primary" :disabled="!draftDirty || busy" @click="emit('commit-draft')">
        将草稿提交为新版本
      </button>
      <p v-if="!draftDirty" class="hint">草稿与头版一致，暂无可提交内容。</p>
      <p v-else class="hint ok">草稿存在改动，提交将生成新版本并推进版本图头指针。</p>
    </div>

    <ul class="v-list">
      <li v-for="v in versions" :key="v.id" class="v-card" :class="{ head: v.isHead }">
        <div class="v-top">
          <span class="v-no">#{{ v.number }}</span>
          <span class="v-kind" :class="'kind-' + v.kind">
            {{ v.kind === 'rollback' ? '↩ 回滚版' : '提交版' }}
          </span>
          <span v-if="v.isHead" class="head-tag">HEAD</span>
          <span class="v-time">{{ timeOf(v.createdAt) }}</span>
        </div>
        <p class="v-msg">{{ v.message }}</p>
        <p class="v-meta">
          {{ v.author }} · {{ v.blocks }} 块 · <code>{{ shortHash(v.rootHash) }}</code>
          <template v-if="v.restoredFrom"> · 还原自 {{ v.restoredFrom }}</template>
        </p>

        <div v-if="v.signoffs.length" class="signoffs">
          <div v-for="s in v.signoffs" :key="s.id" class="so">
            <span class="so-badge">✅ 已签收</span>
            <b>{{ s.by }}</b>
            <em>{{ timeOf(s.at) }}</em>
            <q>{{ s.reason }}</q>
          </div>
        </div>

        <div class="v-ops">
          <button class="mini" @click="emit('pick', v.id)">查看快照</button>
          <button class="mini" @click="emit('set-compare-pair', v.id)">与头版比对</button>
          <button class="mini" :disabled="v.isHead" @click="emit('start-rollback', v.id)">
            发起回滚
          </button>
          <button v-if="!v.signoffs.length" class="mini ok" @click="emit('signoff', v.id)">签收</button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.panel-stack { display: flex; flex-direction: column; gap: 12px; }
.action-box { background: #141a2e; border: 1px solid #28304a; border-radius: 10px; padding: 12px; }
.primary {
  width: 100%; padding: 9px; border-radius: 8px; border: none; cursor: pointer;
  background: linear-gradient(135deg, #4a63d8, #6e54d8); color: #fff; font-weight: 700;
}
.primary:disabled { opacity: .4; cursor: not-allowed; }
.hint { font-size: 11px; color: #7e8bc0; margin: 8px 0 0; }
.hint.ok { color: #6fe0ac; }
.v-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.v-card {
  background: #141a2e; border: 1px solid #28304a; border-radius: 10px; padding: 11px 13px;
  transition: border-color .2s;
}
.v-card.head { border-color: #4a5fb0; box-shadow: 0 0 0 1px #4a5fb033; }
.v-top { display: flex; align-items: center; gap: 8px; }
.v-no { font-weight: 800; color: #c6d1ff; }
.v-kind { font-size: 10px; padding: 2px 7px; border-radius: 8px; }
.kind-commit { background: #1d2748; color: #9db4ff; }
.kind-rollback { background: #3a1626; color: #ff9cbc; }
.head-tag {
  font-size: 10px; font-weight: 800; color: #0d1326; background: #8fa6ff;
  border-radius: 6px; padding: 1px 6px;
}
.v-time { margin-left: auto; font-size: 11px; color: #7e8bc0; }
.v-msg { margin: 7px 0 4px; font-size: 13px; color: #e8ecff; }
.v-meta { margin: 0; font-size: 11px; color: #7e8bc0; }
.v-meta code { color: #9db4ff; }
.signoffs { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.so {
  background: #10231c; border: 1px solid #1f4d3a; border-radius: 8px;
  padding: 7px 9px; font-size: 11px; color: #bfe8d4;
  display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline;
}
.so-badge { font-size: 10px; color: #6fe0ac; }
.so q { font-style: normal; width: 100%; color: #9ccfb6; }
.v-ops { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.mini {
  font-size: 11px; padding: 4px 9px; border-radius: 6px;
  background: #222c4d; color: #c6d1ff; border: 1px solid #33406e; cursor: pointer;
}
.mini:hover:not(:disabled) { background: #2c3a66; }
.mini:disabled { opacity: .35; cursor: not-allowed; }
.mini.ok { background: #133a2b; border-color: #1f5c43; color: #6fe0ac; }
</style>
