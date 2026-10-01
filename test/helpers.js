// 构造一个多章节演示文稿（与前端初始稿一致）
import { createDoc, insertNode } from '../src/core/tree.js'
import { HistoryStore, resetSeed } from '../src/core/history.js'

export function freshStore() {
  resetSeed()
  const store = new HistoryStore()
  let t = createDoc('年度报告')
  t = insertNode(t, t.rootId, {
    id: 'sec-intro', type: 'section', attrs: { title: '第一章 引言' }, children: [
      { id: 'par-intro-1', type: 'paragraph', text: '本文介绍 Catalpa 文稿台的版本管理能力。' },
      { id: 'par-intro-2', type: 'paragraph', text: '版本比对按结构、文本、样式三个维度输出补丁。' },
    ],
  }, 0)
  t = insertNode(t, t.rootId, {
    id: 'sec-body', type: 'section', attrs: { title: '第二章 正文' }, children: [
      { id: 'par-body-1', type: 'paragraph', text: '移动段落与删除后新增必须可以区分。' },
      { id: 'par-body-2', type: 'paragraph', text: '复制节点会得到全新身份，不能复用原身份。', marks: [{ from: 0, to: 4, type: 'strong' }] },
      { id: 'att-1', type: 'attachment', text: '', attrs: { name: '需求说明.pdf', assetId: 'asset-v1', size: 128000 } },
    ],
  }, 1)
  store.initDocument('doc-1', '年度报告', t, 'author-a')
  return { store, tree: t }
}

export function assert(cond, message) {
  if (!cond) {
    throw new Error(`断言失败: ${message}`)
  }
}
export function equal(a, b, message) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${message || '不相等'}\n  期望=${JSON.stringify(b)}\n  实际=${JSON.stringify(a)}`)
  }
}
