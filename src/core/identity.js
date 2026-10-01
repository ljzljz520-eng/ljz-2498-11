// 节点身份：移动保留同一 id；复制必须整子树换发新身份，禁止复用。
export function mintId(prefix = 'n') {
  const rand =
    (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
      ? globalThis.crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 12)}`
  return `${prefix}_${rand}`
}

// 深拷贝一棵子树并全部换发身份；返回 { map: 旧id -> 新节点, root: 新根id }
// 内容（文本/属性/顺序）完全一致，因此内容哈希一致，但身份永远分叉。
export function cloneSubtreeWithNewIds(node, nodes) {
  const remap = new Map()
  const clone = (id) => {
    const original = nodes.get(id)
    const freshId = mintId(original.type.slice(0, 3))
    const childIds = original.children.map(clone)
    const copy = { ...original, id: freshId, children: childIds }
    remap.set(id, copy)
    return freshId
  }
  const rootId = clone(node.id)
  return { rootId, map: remap }
}
