<script setup>
import { computed } from 'vue'

const props = defineProps({
  tree: { type: Object, required: true },
  anchorId: { type: String, default: null },
  pendingCount: { type: Number, default: 0 },
})
const emit = defineEmits(['edit-text', 'edit-style', 'move', 'remove', 'insert', 'copy', 'replace-attachment', 'commit'])

const root = computed(() => props.tree.nodes.get(props.tree.rootId))
const title = computed(() => root.value?.attrs?.title || '文稿')

function node(id) {
  return props.tree.nodes.get(id)
}
function sectionChildren() {
  // 顶层只保留 section / 直接挂的块
  return root.value?.children || []
}
function isAttachment(n) {
  return n.type === 'attachment'
}
function onInputText(id, ev) {
  emit('edit-text', id, ev.target.value)
}
function toggleBold(id) {
  const n = node(id)
  const strong = (n.marks || []).some((m) => m.type === 'strong')
  const marks = strong
    ? n.marks.filter((m) => m.type !== 'strong')
    : [...(n.marks || []), { from: 0, to: (n.text || '').length, type: 'strong' }]
  // marks 走 TEXT 载荷（marks 字段），便于样式维度报告行内格式差异
  emit('edit-text', id, n.text || '', marks)
}
function align(id, alignValue) {
  emit('edit-style', id, { align: alignValue })
}
function renameSection(id, ev) {
  emit('edit-style', id, { title: ev.target.value })
}
</script>

<template>
  <section class="panel editor-panel">
    <div class="panel-header">
      <h2>文稿树编辑区（活稿，尚未提交）</h2>
      <div class="actions">
        <span v-if="pendingCount" class="pending-dot">有 {{ pendingCount }} 项未提交操作</span>
        <button type="button" class="ghost-btn primary-inline" @click="emit('commit')">提交为新版本</button>
      </div>
    </div>

    <div class="tree-scroll">
      <div class="doc-title">{{ title }}</div>

      <div
        v-for="cid in sectionChildren()"
        :key="cid"
        class="chapter"
        :class="{ anchored: anchorId === cid }"
      >
        <template v-if="node(cid).type === 'section'">
          <div class="chapter-head" :class="{ anchored: anchorId === cid }">
            <input class="chapter-name" :value="node(cid).attrs.title" @input="renameSection(cid, $event)" />
            <code class="nid">{{ cid }}</code>
            <span class="node-tools">
              <button type="button" class="mini" @click="emit('insert', cid, '段落：' + Math.random().toString(16).slice(2, 5))">+段落</button>
              <button type="button" class="mini" @click="emit('copy', cid, rootId)">复制整章</button>
              <button type="button" class="mini danger" @click="emit('remove', cid)">删除章</button>
            </span>
          </div>

          <div
            v-for="pid in node(cid).children"
            :key="pid"
            class="block"
            :class="[
              node(pid).type,
              { anchored: anchorId === pid,
                'is-strong': (node(pid).marks || []).some((m) => m.type === 'strong') },
            ]"
            :style="node(pid).attrs?.align ? { textAlign: node(pid).attrs.align } : null"
          >
            <template v-if="isAttachment(node(pid))">
              <div class="att">
                <span class="att-icon">📎</span>
                <div>
                  <div class="att-name">{{ node(pid).attrs.name }}</div>
                  <div class="att-asset">assetId: <code>{{ node(pid).attrs.assetId }}</code></div>
                </div>
              </div>
              <div class="node-tools">
                <button type="button" class="mini warn" @click="emit('replace-attachment', pid)">替换附件（不改文字）</button>
                <button type="button" class="mini" @click="emit('copy', pid, cid)">复制附件</button>
                <button type="button" class="mini danger" @click="emit('remove', pid)">删除</button>
              </div>
            </template>

            <template v-else>
              <textarea
                class="para-text"
                rows="1"
                :value="node(pid).text"
                @input="onInputText(pid, $event)"
              ></textarea>
              <div class="node-tools">
                <code class="nid">{{ pid }}</code>
                <button type="button" class="mini" @click="toggleBold(pid)">B</button>
                <button type="button" class="mini" @click="align(pid, 'left')">左</button>
                <button type="button" class="mini" @click="align(pid, 'center')">中</button>
                <button type="button" class="mini" @click="emit('copy', pid, cid)">复制段落</button>
                <button type="button" class="mini"
                  v-for="(sid, si) in sectionChildren().filter((x) => x !== cid)"
                  :key="sid"
                  @click="emit('move', pid, sid, -1)">移至「{{ node(sid).attrs?.title || sid }}」#{{ si }}</button>
                <button type="button" class="mini danger" @click="emit('remove', pid)">删除</button>
              </div>
            </template>
          </div>
        </template>

        <!-- 直接挂在 doc 下的零散块 -->
        <div v-else class="block loose" :class="{ anchored: anchorId === cid }">
          <textarea class="para-text" rows="1" :value="node(cid).text" @input="onInputText(cid, $event)"></textarea>
          <div class="node-tools">
            <code class="nid">{{ cid }}</code>
            <button type="button" class="mini danger" @click="emit('remove', cid)">删除</button>
          </div>
        </div>
      </div>

      <div class="add-row">
        <button type="button" class="ghost-btn" @click="emit('insert', rootId, { type: 'section', attrs: { title: '新章节 ' + Math.random().toString(16).slice(2, 5) }, children: [] })">+ 新章节</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.editor-panel { min-height: 0; }
.primary-inline { background: var(--accent); color: #fff; border-color: var(--accent); }
.pending-dot { font-size: 0.72rem; color: #b5832b; background: #fbf3e2; border: 1px solid #e7d3a4; border-radius: 999px; padding: 3px 9px; }
.tree-scroll { overflow: auto; padding: 14px 16px; }
.doc-title { font-size: 1.15rem; font-weight: 800; margin-bottom: 10px; }
.chapter { border: 1px solid var(--border); border-radius: 12px; margin-bottom: 12px; overflow: hidden; }
.chapter-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: linear-gradient(180deg, #f4f8f6, #eef4f0); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.chapter-name { font-weight: 700; font-size: 0.9rem; border: 1px solid transparent; background: transparent; border-radius: 6px; padding: 3px 6px; min-width: 160px; }
.chapter-name:focus { outline: none; border-color: var(--accent); background: #fff; }
.nid { font-family: var(--mono); font-size: 0.64rem; color: #8fa39a; background: #f3f6f4; padding: 1px 5px; border-radius: 5px; }
.node-tools { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.mini { font-size: 0.66rem; border: 1px solid var(--border); background: #fff; border-radius: 6px; padding: 2px 6px; cursor: pointer; }
.mini:hover { border-color: var(--accent); color: var(--accent); }
.mini.danger { color: var(--danger); }
.mini.danger:hover { border-color: var(--danger); }
.mini.warn { color: #b5832b; }
.block { padding: 8px 12px; border-bottom: 1px dashed #e3ebe6; scroll-margin: 80px; }
.block.loose { background: #fafcfb; }
.para-text { width: 100%; outline: none; line-height: 1.8; font-size: 0.93rem; border: 1px solid #e3ebe6; border-radius: 6px; padding: 4px 8px; resize: vertical; font-family: inherit; background: #fff; }
.para-text:focus { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent); }
.block.is-strong .para-text { font-weight: 700; }
.block[style*="center"] .para-text { }
.att { display: flex; gap: 10px; align-items: center; padding: 4px 0; }
.att-icon { font-size: 1.4rem; }
.att-name { font-weight: 600; font-size: 0.88rem; }
.att-asset { font-size: 0.72rem; color: var(--muted); }
.anchored { animation: flash 1.6s ease; box-shadow: 0 0 0 3px rgba(20, 108, 67, 0.35); border-radius: 10px; }
@keyframes flash {
  0% { background: #fff4c2; }
  100% { background: transparent; }
}
.add-row { padding: 6px 0 20px; }
</style>
