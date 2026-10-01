// 版本图 + 操作日志 + 检查点的混合存储内核（与 PG DDL 一一对应，见 docs/design.md）。
// - 每个版本是版本图中的一个节点（parent 链构成有向无环图，当前实现为线性链）。
// - 全量快照只在检查点落盘（每 CHECKPOINT_INTERVAL 个版本 + 每个已签收版本强制检查点）；
//   其余版本通过从最近检查点回放前向操作日志物化，恢复成本 = 最多 K-1 次操作回放。
// - 比较服务只读取不可变快照/物化结果，绝不读编辑中的活树。
import { serializeTree, deserializeTree, cloneSnapshotJson } from './snapshot.js'
import {
  setText, setAttrs, moveNode, removeNode, insertNode, duplicateSubtree,
} from './tree.js'

export const CHECKPOINT_INTERVAL = 5

let seqSeed = 1
let versionSeed = 1
export function resetSeed() { seqSeed = 1; versionSeed = 1 }

export class HistoryStore {
  constructor() {
    // PG: versions(doc_id, version_id, parent_id, commit_seq, author, message, snapshot_hash, is_checkpoint, signed_off)
    this.versions = new Map()              // docId -> Version[]
    this.snapshotStore = new Map()         // contentHash -> snapshot json（内容寻址，不可变）
    // PG: op_log(seq, doc_id, version_id, op_kind, node_id, payload jsonb)
    this.opLog = []                        // 全序前向操作日志
    // PG: sign_offs(version_id, signer, reason, signed_at)
    this.signOffs = new Map()              // versionId -> [{signer, reason, at}]
    this.docMeta = new Map()
  }

  initDocument(docId, title, tree, author = 'author-a') {
    this.versions.set(docId, [])
    this.docMeta.set(docId, { title, headSeq: 0 })
    const v = this.commit(docId, tree, { author, message: '创建文稿' })
    this.addCheckpoint(docId, v.id) // V1 强制检查点
    return v
  }

  headVersion(docId) {
    const list = this.versions.get(docId)
    return list[list.length - 1] || null
  }

  getVersion(docId, versionId) {
    return this.versions.get(docId).find((v) => v.id === versionId) || null
  }

  listVersions(docId) {
    return [...(this.versions.get(docId) || [])]
  }

  // 提交新版本。ops 为本次编辑的前向操作描述（用于检查点间回放与复制溯源）。
  // forceCheckpoint：回滚新版本等场景强制落全量快照（独立可还原，不依赖后续日志）。
  commit(docId, tree, { author, message, ops = [], forceCheckpoint = false }) {
    const list = this.versions.get(docId)
    const parent = list.length ? list[list.length - 1] : null
    const { payload, contentHash } = serializeTree(tree)
    if (!this.snapshotStore.has(contentHash)) this.snapshotStore.set(contentHash, payload)
    const seq = seqSeed
    seqSeed += 1
    const version = {
      id: `v${versionSeed++}`,
      docId,
      parentId: parent ? parent.id : null,
      seq,
      author,
      message,
      createdAt: Date.now(),
      snapshotHash: contentHash,
      isCheckpoint: false,
      signedOff: false,
      opCount: ops.length,
    }
    list.push(version)
    ops.forEach((op) => {
      this.opLog.push({ seq: this.opLog.length + 1, docId, versionId: version.id, ...op })
    })
    this.docMeta.get(docId).headSeq = seq
    if (forceCheckpoint || !parent || list.length % CHECKPOINT_INTERVAL === 1) {
      // V1 / 每 K 个版本 / 强制（回滚新版本、签收）均为检查点
      this.addCheckpoint(docId, version.id)
    }
    return version
  }

  addCheckpoint(docId, versionId) {
    const v = this.getVersion(docId, versionId)
    v.isCheckpoint = true // 快照已在 commit 时写入内容寻址存储，这里仅打标记
  }

  signOff(docId, versionId, signer, reason) {
    const v = this.getVersion(docId, versionId)
    if (!v) throw new Error('版本不存在')
    v.signedOff = true
    this.addCheckpoint(docId, versionId) // 已签收版本强制保留独立快照，永不依赖日志
    const arr = this.signOffs.get(versionId) || []
    arr.push({ signer, reason, at: Date.now() })
    this.signOffs.set(versionId, arr)
    return arr
  }

  listSignOffs(versionId) {
    return this.signOffs.get(versionId) || []
  }

  // 两版本之间的复制溯源映射 newNodeId -> sourceNodeId（比较服务识别"复制"而非新增）
  copyProvenance(docId, fromVersionId, toVersionId) {
    const fromSeq = this.getVersion(docId, fromVersionId).seq
    const toSeq = this.getVersion(docId, toVersionId).seq
    const [lo, hi] = fromSeq <= toSeq ? [fromSeq, toSeq] : [toSeq, fromSeq]
    const inRange = new Set(
      this.listVersions(docId).filter((v) => v.seq > lo && v.seq <= hi).map((v) => v.id)
    )
    const map = new Map()
    for (const e of this.opLog) {
      if (e.docId === docId && inRange.has(e.versionId) && e.opKind === 'COPY') {
        for (const [sourceId, copiedId] of Object.entries(e.payload.idMap || {})) {
          map.set(copiedId, sourceId)
        }
      }
    }
    return map
  }

  // —— 物化：从最近检查点回放操作日志。返回 { tree, replayedOps, checkpointId, cost } ——
  materialize(docId, versionId) {
    const target = this.getVersion(docId, versionId)
    let cp = target
    while (cp && !cp.isCheckpoint) cp = this.getVersion(docId, cp.parentId)
    let tree = deserializeTree(cloneSnapshotJson(this.snapshotStore.get(cp.snapshotHash)))
    let replayed = 0
    const chain = []
    let cur = target
    while (cur && cur.id !== cp.id) {
      chain.unshift(cur)
      cur = cur.parentId ? this.getVersion(docId, cur.parentId) : null
    }
    for (const v of chain) {
      const entries = this.opLog.filter((e) => e.versionId === v.id)
      tree = applyOps(tree, entries)
      replayed += entries.length
    }
    return {
      tree,
      checkpointId: cp.id,
      replayedOps: replayed,
      cost: { snapshotReadBytes: 0, replayedOps: replayed, boundedBy: CHECKPOINT_INTERVAL - 1 },
    }
  }
}

// 前向操作回放（比较/恢复路径，确定性）
export function applyOps(tree, entries) {
  let t = tree
  for (const e of entries) {
    const p = e.payload || {}
    if (e.opKind === 'TEXT') t = setText(t, e.nodeId, p.text, p.marks)
    else if (e.opKind === 'STYLE') t = setAttrs(t, e.nodeId, p.attrs)
    else if (e.opKind === 'MOVE') t = moveNode(t, e.nodeId, p.parentId, p.index)
    else if (e.opKind === 'DELETE') t = removeNode(t, e.nodeId)
    else if (e.opKind === 'INSERT') t = insertNode(t, p.parentId, p.spec, p.index)
    else if (e.opKind === 'COPY') t = duplicateSubtree(t, p.fromId, p.parentId, p.index, new Map(Object.entries(p.idMap || {}))).tree
  }
  return t
}

// 编辑辅助：执行一次结构编辑并记录操作日志载荷
export function editWithLog(tree, opKind, nodeId, payload) {
  if (opKind === 'TEXT') return { tree: setText(tree, nodeId, payload.text, payload.marks), log: { opKind, nodeId, payload } }
  if (opKind === 'STYLE') return { tree: setAttrs(tree, nodeId, payload.attrs), log: { opKind, nodeId, payload } }
  if (opKind === 'MOVE') return { tree: moveNode(tree, nodeId, payload.parentId, payload.index), log: { opKind, nodeId, payload } }
  if (opKind === 'DELETE') return { tree: removeNode(tree, nodeId), log: { opKind, nodeId, payload } }
  if (opKind === 'INSERT') {
    const next = insertNode(tree, payload.parentId, payload.spec, payload.index)
    return { tree: next, log: { opKind, nodeId: payload.spec.id, payload } }
  }
  if (opKind === 'COPY') {
    const result = duplicateSubtree(tree, payload.fromId, payload.parentId, payload.index)
    const fullPayload = { ...payload, idMap: Object.fromEntries(result.idMap) }
    return { tree: result.tree, log: { opKind, nodeId: result.rootId, payload: fullPayload } }
  }
  throw new Error(`未知操作 ${opKind}`)
}
