// 快照序列化：不可变树 <-> 可存入 PG jsonb / 对象存储的纯 JSON。
// 快照内容按内容哈希寻址，任何已签收版本可脱离后续操作日志独立还原。
import { hashValue, canonicalJson } from './hash.js'

export function serializeTree(tree) {
  const nodes = {}
  for (const [id, node] of tree.nodes) {
    nodes[id] = {
      id: node.id,
      type: node.type,
      text: node.text ?? '',
      marks: node.marks ?? [],
      attrs: node.attrs ?? {},
      children: [...node.children],
    }
  }
  const payload = { rootId: tree.rootId, nodes }
  return { payload, contentHash: hashValue(payload) }
}

export function deserializeTree(json) {
  const nodes = new Map()
  for (const [id, node] of Object.entries(json.nodes)) {
    nodes.set(id, {
      id,
      type: node.type,
      text: node.text ?? '',
      marks: node.marks ? node.marks.map((m) => ({ ...m })) : [],
      attrs: node.attrs ? JSON.parse(canonicalJson(node.attrs)) : {},
      children: [...node.children],
    })
  }
  return { rootId: json.rootId, nodes }
}

// 深拷贝已序列化快照（回滚生成新版本时使用；节点身份沿用目标版本——这是"还原"，不是"复制"）
export function cloneSnapshotJson(json) {
  return JSON.parse(JSON.stringify(json))
}
