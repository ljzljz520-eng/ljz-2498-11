// 不可变文稿树（Manuscript Tree）。
// 节点: { id, type, text?, marks?, attrs?, children:[] }
// 树以 id -> node 的扁平 Map 持久化；每次编辑产生新的不可变版本，旧版本对象永不被改写。
import { canonicalJson, hashValue } from './hash.js'
import { mintId } from './identity.js'

export function createDoc(title = '未命名文稿') {
  const rootId = mintId('doc')
  const p1 = mintId('par')
  const nodes = new Map([
    [rootId, { id: rootId, type: 'doc', children: [p1], attrs: { title } }],
    [p1, { id: p1, type: 'paragraph', children: [], text: '' }],
  ])
  return { rootId, nodes }
}

export function findNode(tree, id) {
  return tree.nodes.get(id) || null
}

export function childIdsOf(tree, id) {
  const n = tree.nodes.get(id)
  return n ? n.children : []
}

// 路径：根到目标（含），用于前端锚点定位
export function pathOf(tree, targetId) {
  const parent = new Map()
  const walk = (id) => {
    const node = tree.nodes.get(id)
    if (!node) return false
    if (id === targetId) return true
    for (const cid of node.children) {
      if (walk(cid)) {
        parent.set(cid, id)
        return true
      }
    }
    return false
  }
  if (!walk(tree.rootId)) return []
  const path = [targetId]
  let cur = targetId
  while (parent.has(cur)) {
    cur = parent.get(cur)
    path.unshift(cur)
  }
  return path
}

// 内容指纹：只看结构/文本/属性，不看 id —— 复制出来的节点指纹相同但身份不同。
export function contentFingerprint(tree, id = tree.rootId) {
  const n = tree.nodes.get(id)
  return hashValue(canonicalJson(serializeContent(tree, id)))
}

function serializeContent(tree, id) {
  const n = tree.nodes.get(id)
  if (n.type === 'text' || n.text !== undefined) {
    return { type: n.type, text: n.text, marks: n.marks ?? [], attrs: n.attrs ?? {} }
  }
  return {
    type: n.type,
    attrs: n.attrs ?? {},
    marks: n.marks ?? [],
    children: n.children.map((cid) => serializeContent(tree, cid)),
  }
}

export function cloneTree(tree) {
  return { rootId: tree.rootId, nodes: new Map(Array.from(tree.nodes, ([k, v]) => [k, { ...v, children: [...v.children] }])) }
}

// —— 结构编辑原语（均返回新树；保留未触及节点身份）——

export function setText(tree, id, text, marks) {
  const next = cloneTree(tree)
  const node = { ...next.nodes.get(id) }
  node.text = text
  if (marks !== undefined) node.marks = marks
  next.nodes.set(id, node)
  return next
}

// 局部样式（如整段粗体）；行内 marks 的差异由 text diff 报告。
export function setAttrs(tree, id, patch) {
  const next = cloneTree(tree)
  const node = { ...next.nodes.get(id), attrs: { ...(next.nodes.get(id).attrs || {}), ...patch } }
  next.nodes.set(id, node)
  return next
}

function detach(tree, id) {
  for (const [pid, p] of tree.nodes) {
    if (p.children.includes(id)) {
      p.children = p.children.filter((c) => c !== id)
      return pid
    }
  }
  return null
}

// 移动：同一 id 挂到 newParent 的 index；与"删除旧节点 + 新建节点"严格区分（见 diff.move 检测）。
export function moveNode(tree, id, newParentId, index = -1) {
  if (id === tree.rootId || id === newParentId) return tree
  if (pathOf(tree, newParentId).includes(id)) return tree // 不能挂进自己的子孙
  const next = cloneTree(tree)
  detach(next, id)
  const parent = next.nodes.get(newParentId)
  const at = index < 0 || index > parent.children.length ? parent.children.length : index
  parent.children.splice(at, 0, id)
  return next
}

// 删除：节点及其子树从 nodes 中彻底移除（与 move 不同：id 在目标树不存在）。
export function removeNode(tree, id) {
  if (id === tree.rootId) return tree
  const next = cloneTree(tree)
  const subtree = new Set()
  const collect = (nid) => {
    subtree.add(nid)
    next.nodes.get(nid)?.children.forEach(collect)
  }
  collect(id)
  detach(next, id)
  subtree.forEach((nid) => next.nodes.delete(nid))
  return next
}

// 新增：新身份节点
export function insertNode(tree, parentId, nodeSpec, index = -1) {
  const next = cloneTree(tree)
  const id = nodeSpec.id || mintId(nodeSpec.type.slice(0, 3))
  nodeSpec.id = id // 回填，供操作日志记录身份
  const node = {
    id,
    type: nodeSpec.type,
    text: nodeSpec.text ?? '',
    marks: nodeSpec.marks ?? [],
    attrs: nodeSpec.attrs ?? {},
    children: [],
  }
  const childClones = (nodeSpec.children || []).map((child) => {
    const cid = child.id || mintId(child.type.slice(0, 3))
    next.nodes.set(cid, { id: cid, type: child.type, text: child.text ?? '', marks: child.marks ?? [], attrs: child.attrs ?? {}, children: [] })
    return cid
  })
  node.children = childClones
  next.nodes.set(id, node)
  const parent = next.nodes.get(parentId)
  const at = index < 0 || index > parent.children.length ? parent.children.length : index
  parent.children.splice(at, 0, id)
  return next
}

// 复制粘贴：整子树换发身份（身份不复用），内容不变。
// 返回 { tree, rootId, idMap: 旧id -> 新id（含整棵子树） }，供操作日志(idMap)溯源与确定性回放。
// 传入 presetIdMap 时复用指定身份（检查点回放路径）；否则现场配发并写日志。
export function duplicateSubtree(tree, id, parentId, index = -1, presetIdMap = null) {
  const src = tree.nodes.get(id)
  if (!src) return { tree, rootId: null, idMap: new Map() }
  const next = cloneTree(tree)
  const idMap = presetIdMap || new Map()
  const dup = (sid, pid) => {
    const original = next.nodes.get(sid)
    const nid = idMap.get(sid) || mintId(original.type.slice(0, 3))
    idMap.set(sid, nid)
    next.nodes.set(nid, { ...original, id: nid, children: [] })
    next.nodes.get(pid).children.push(nid)
    original.children.forEach((c) => dup(c, nid))
  }
  const parent = next.nodes.get(parentId)
  const at = index < 0 || index > parent.children.length ? parent.children.length : index
  const holderId = mintId('hold')
  next.nodes.set(holderId, { id: holderId, type: 'holder', children: [] })
  dup(id, holderId)
  const copiedRootId = next.nodes.get(holderId).children[0]
  next.nodes.delete(holderId)
  parent.children.splice(at, 0, copiedRootId)
  return { tree: next, rootId: copiedRootId, idMap }
}
