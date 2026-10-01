/**
 * 不可变文稿树（immutable manuscript tree）
 * ------------------------------------------------------------------
 * 节点模型：
 *  - section : { kind:'section', id, title, children: Node[], marks?: string[] }
 *  - p       : { kind:'p', id, text, marks?: string[] }
 *  - attachment: { kind:'attachment', id, name, blobHash, mime, size, marks?: string[] }
 *
 * 每个节点带两类标识：
 *   id    —— 身份（identity）：编辑期间稳定；移动保持；复制得到【新 id】；
 *             因此 move 与 "删除后新增" 在 diff 时可被区分。
 *   hash  —— 内容寻址（content addressing，类 Merkle）：
 *             节点自身内容 + 子节点 hash 有序参与；身份不参与。
 *
 * 提交版本时整棵树规范化后冻结（Object.freeze），比较服务只读，
 * 任何修改都产出新版本对象，旧版本永不被改写。
 */

export function uid(prefix = 'n') {
  // 足够区分身份的短随机 id
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`
}

/** 确定性 53bit 字符串 hash（演示用；生产用 xxhash3/BLAKE3 列在设计文档） */
function cyrb53(str, seed = 0x9e3779b9) {
  let h1 = seed
  let h2 = seed
  for (let i = 0; i < str.length; i++) {
    let ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/** 规范化：排序键、去除空白字段，保证跨进程哈希一致（生产用 canonical JSON） */
export function canonicalNode(node) {
  const marks = node.marks && node.marks.length ? [...node.marks].sort() : []
  if (node.kind === 'root' || node.kind === 'section') {
    return { kind: node.kind, title: node.title ?? '', marks, children: node.children.map(canonicalNode) }
  }
  if (node.kind === 'attachment') {
    return { kind: 'attachment', name: node.name, blobHash: node.blobHash, mime: node.mime ?? '', size: node.size ?? 0, marks }
  }
  return { kind: 'p', text: node.text ?? '', marks }
}

/** 内容 hash：绝不包含 id —— 复制节点内容相同 => hash 相同，但 id 不同 */
export function contentHash(node) {
  const canon = canonicalNode(node)
  if (canon.kind === 'root' || canon.kind === 'section') {
    canon.children = node.children.map((ch) => contentHash(ch))
  }
  return cyrb53(JSON.stringify(canon))
}

export function rootHash(root) {
  return contentHash(root)
}

export function makeP(text = '', id) {
  return { kind: 'p', id: id ?? uid('p'), text, marks: [] }
}
export function makeAttachment(name, blobHash, size = 0, mime = 'application/octet-stream', id) {
  return { kind: 'attachment', id: id ?? uid('att'), name, blobHash, mime, size, marks: [] }
}
export function makeSection(title, children = [], id) {
  return { kind: 'section', id: id ?? uid('s'), title, children, marks: [] }
}

export function walk(nodes, cb, path = []) {
  nodes.forEach((node, index) => {
    const p = [...path, index]
    cb(node, p)
    if (node.kind === 'section') walk(node.children, cb, p)
  })
}

export function indexTree(root) {
  const byId = new Map()
  walk(root.children, (node, path) => byId.set(node.id, { node, path }))
  return byId
}

export function cloneTree(root) {
  return structuredClone(root)
}

/** 复制节点：深拷贝但【重新分配所有身份】，hash 保持一致 => “同内容、不同身份” */
export function copyWithNewIdentity(node) {
  const copy = structuredClone(node)
  walk([copy], (n) => {
    n.id = uid(n.kind === 'section' ? 's' : n.kind === 'p' ? 'p' : 'att')
  })
  return copy
}

export function deepFreeze(root) {
  walk([root], (node) => {
    Object.freeze(node)
    if (node.children) Object.freeze(node.children)
    if (node.marks) Object.freeze(node.marks)
  })
  Object.freeze(root.children)
  Object.freeze(root)
  return root
}

export function totalBlocks(root) {
  let n = 0
  walk(root.children, (x) => {
    if (x.kind !== 'section') n += 1
  })
  return n
}
