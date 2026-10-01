<script setup>
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps({
  root: { type: Object, required: true },
  // hunkId -> { nodeId, type, op } 的高亮索引
  highlightIndex: { type: Object, default: () => new Map() },
  activeNodeId: { type: String, default: null },
  readonly: { type: Boolean, default: false },
  title: { type: String, default: '工作草稿' },
  badge: { type: [String, Number], default: '' },
})

const emit = defineEmits([
  'update-text', 'toggle-mark', 'add-block', 'duplicate-block',
  'copy-block', 'move-block', 'delete-block', 'replace-attachment',
  'update-section-title', 'add-section',
])

const wrapper = ref(null)
const flashClass = ref('')

watch(() => props.activeNodeId, async (id) => {
  if (!id) return
  await nextTick()
  const el = wrapper.value?.querySelector(`[data-node-id="${CSS.escape(id)}"]`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    flashClass.value = 'flash'
    setTimeout(() => { flashClass.value = '' }, 1400)
  }
})

function hl(nodeId) {
  return props.highlightIndex.get(nodeId) || null
}

const markButtons = [
  ['bold', 'B'],
  ['italic', 'I'],
  ['quote', '“'],
]

function sectionIndexOf(nodeId) {
  return props.root.children.findIndex((s) => s.id === nodeId)
}
function sectionOfBlock(sectionId) {
  return props.root.children.find((s) => s.id === sectionId)
}

function moveAcross(nodeId, currentSectionId, dir) {
  const cur = sectionOfBlock(currentSectionId)
  const si = props.root.children.indexOf(cur)
  const target = props.root.children[si + dir]
  if (!target) return
  emit('move-block', { nodeId, fromSectionId: currentSectionId, toSectionId: target.id })
}
</script>

<template>
  <div class="manuscript" ref="wrapper">
    <div class="ms-header">
      <h3>{{ title }} <span v-if="badge" class="ms-badge">{{ badge }}</span></h3>
      <button v-if="!readonly" class="mini" type="button" @click="emit('add-section')">+ 新章节</button>
    </div>

    <section
      v-for="(sec, si) in root.children"
      :key="sec.id"
      class="chapter"
      :data-node-id="sec.id"
      :class="['hl-' + (hl(sec.id)?.type || ''), { flash: activeNodeId === sec.id && flashClass }]"
    >
      <header class="chapter-head">
        <input
          :value="sec.title"
          :readonly="readonly"
          class="chapter-title"
          @input="emit('update-section-title', { sectionId: sec.id, title: $event.target.value })"
        />
        <span v-if="hl(sec.id)" class="chip" :class="'chip-' + hl(sec.id).type">{{ hl(sec.id).label }}</span>
      </header>

      <div
        v-for="node in sec.children"
        :key="node.id"
        class="block"
        :data-node-id="node.id"
        :class="[
          'hl-' + (hl(node.id)?.type || ''),
          { flash: activeNodeId === node.id && flashClass, marked: node.marks?.length },
        ]"
      >
        <!-- 段落 -->
        <template v-if="node.kind === 'p'">
          <textarea
            class="para-input"
            :value="node.text"
            :readonly="readonly"
            rows="1"
            @input="emit('update-text', { nodeId: node.id, sectionId: sec.id, text: $event.target.value })"
          />
          <div v-if="node.marks?.length" class="mark-row">
            <span v-for="m in node.marks" :key="m" class="mark-tag">{{ m }}</span>
          </div>
        </template>

        <!-- 附件 -->
        <template v-else-if="node.kind === 'attachment'">
          <div class="attachment-row">
            <span class="att-icon">📎</span>
            <div class="att-meta">
              <strong>{{ node.name }}</strong>
              <small>{{ node.mime }} · {{ node.size }} B · blob {{ node.blobHash.slice(0, 12) }}</small>
            </div>
            <button v-if="!readonly" class="mini warn" type="button"
                    @click="emit('replace-attachment', { nodeId: node.id, sectionId: sec.id })">
              替换文件
            </button>
          </div>
        </template>

        <!-- 锚点条：该节点的差异标签 -->
        <div v-if="hl(node.id)" class="anchors">
          <span v-for="h in hl(node.id).items" :key="h.hunkId" class="chip" :class="'chip-' + h.type">
            {{ h.label }}
          </span>
        </div>

        <!-- 操作 -->
        <div v-if="!readonly" class="block-ops">
          <template v-if="node.kind === 'p'">
            <button
              v-for="[m, label] in markButtons" :key="m"
              class="mini" :class="{ active: node.marks?.includes(m) }"
              type="button"
              @click="emit('toggle-mark', { nodeId: node.id, sectionId: sec.id, mark: m })"
            >{{ label }}</button>
          </template>
          <button class="mini" type="button" title="复制（新身份）"
                  @click="emit('copy-block', { nodeId: node.id, sectionId: sec.id })">⧉ 复制</button>
          <button class="mini" type="button" title="复制节点"
                  @click="emit('duplicate-block', { nodeId: node.id, sectionId: sec.id })">⎘ 同身份复制*</button>
          <button class="mini" type="button" :disabled="si === 0"
                  @click="moveAcross(node.id, sec.id, -1)">← 移到上一章</button>
          <button class="mini" type="button" :disabled="si === root.children.length - 1"
                  @click="moveAcross(node.id, sec.id, 1)">移到下一章 →</button>
          <button class="mini danger" type="button"
                  @click="emit('delete-block', { nodeId: node.id, sectionId: sec.id })">删除</button>
        </div>
      </div>

      <button v-if="!readonly" class="mini add-block" type="button"
              @click="emit('add-block', { sectionId: sec.id })">+ 段落</button>
    </section>
  </div>
</template>

<style scoped>
.manuscript { display: flex; flex-direction: column; gap: 14px; }
.ms-header { display: flex; align-items: center; justify-content: space-between; }
.ms-header h3 { margin: 0; font-size: 15px; }
.ms-badge { font-size: 11px; background: #2d3a5c; color: #9db4ff; padding: 2px 8px; border-radius: 10px; margin-left: 6px; }
.chapter {
  border: 1px solid #28304a; border-radius: 10px; padding: 12px 14px;
  background: #141a2e; transition: box-shadow .25s, border-color .25s;
}
.chapter-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.chapter-title {
  flex: 1; background: transparent; border: none; color: #e8ecff;
  font-size: 15px; font-weight: 700; outline: none;
  border-bottom: 1px dashed transparent;
}
.chapter-title:not(:read-only):focus { border-bottom-color: #4b5d96; }
.block {
  border-left: 3px solid transparent; border-radius: 6px;
  padding: 8px 10px; margin: 6px 0; background: #18203a;
  transition: box-shadow .25s, border-color .25s, background .25s;
}
.block.marked { border-left-color: #6d7bd8; }
.para-input {
  width: 100%; resize: vertical; min-height: 30px;
  background: transparent; border: none; color: #dfe5ff;
  font: inherit; outline: none; line-height: 1.7;
}
.mark-row { display: flex; gap: 6px; margin-top: 4px; }
.mark-tag {
  font-size: 10px; color: #8ea2e8; background: #20294a;
  border: 1px solid #33406e; border-radius: 8px; padding: 1px 7px;
}
.attachment-row { display: flex; align-items: center; gap: 10px; }
.att-icon { font-size: 20px; }
.att-meta { display: flex; flex-direction: column; gap: 2px; }
.att-meta small { color: #7e8bc0; font-size: 11px; }
.block-ops { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.add-block { margin-top: 8px; }
.anchors { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.chip {
  font-size: 10px; padding: 2px 8px; border-radius: 9px; font-weight: 600;
}
.chip-text { background: #103326; color: #46e0a0; border: 1px solid #1c5c43; }
.chip-style { background: #332a10; color: #f0c14b; border: 1px solid #6b5420; }
.chip-structure { background: #3a1626; color: #ff7aa2; border: 1px solid #6b2648; }
.chip-neutral { background: #1d2748; color: #9db4ff; border: 1px solid #33406e; }
.hl-text { box-shadow: inset 3px 0 0 #2fbf88; }
.hl-style { box-shadow: inset 3px 0 0 #d8a72e; }
.hl-structure { box-shadow: inset 3px 0 0 #e0568b; }
.flash { animation: flash 1.3s ease; }
@keyframes flash {
  0%, 60% { background: #2a3560; }
  100% { background: #18203a; }
}
.chapter.flash { animation: flash 1.3s ease; }
.mini {
  font-size: 11px; padding: 3px 9px; border-radius: 6px;
  background: #222c4d; color: #c6d1ff; border: 1px solid #33406e; cursor: pointer;
}
.mini:hover:not(:disabled) { background: #2c3a66; }
.mini:disabled { opacity: .35; cursor: not-allowed; }
.mini.active { background: #38447e; border-color: #6d7bd8; }
.mini.danger { background: #3a1d2b; border-color: #6b2d47; color: #ff9cbc; }
.mini.warn { background: #3a2d16; border-color: #6b5420; color: #f3c969; }
</style>
