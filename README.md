# 文稿台 · 版本比对与回滚（Vue 3 演示工程）

在不可变文稿树上实现**按段落/格式的版本比对**与**审批式回滚**：
比较服务只读冻结快照，PostgreSQL 保存版本图、签收人/理由、回滚工单、操作日志与检查点；
回滚永不原地覆盖，而是创建一个内容字节级还原已签收版本的新版本。

详细设计见 [`docs/DESIGN.md`](docs/DESIGN.md)，真实建表与事务函数见
[`server/schema.sql`](server/schema.sql)。

## 运行

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm build
```

浏览器内的 `src/services/mockServer.js` 是后端等价物：方法边界即请求边界，
★ 方法按 PG 事务语义实现（行锁/乐观锁/重算校验），接口即真实 HTTP 契约。

## 核心模型

- 节点双标识：`id`=身份（移动保持、**复制必须换新 id**）；`hash`=内容（canonical 不含 id，Merkle 根）。
- 补丁 hunk 强制三分：`text`（行内 LCS）/ `style`（marks 增删）/ `structure`
  （移动、删除、新增、复制、章节增删调序、附件 blob 替换），每个 hunk 带 `nodeId + path`。
- 回滚工单创建时冻结 `base_head + patch_hash`；审批通过时服务端做 5 项校验并重算补丁，
  审批期间头版推进 → 409 STALE_HEAD，旧确认不可能覆盖新稿。
- 大文稿差异走异步 `diff_job`（worker 租约、崩溃可重接管）；结果信封带 `base_head_hash`，
  前端发现头版已变即整包拒收，保留节点锚点并提示重算。

## 验收用例（页面操作）

| 用例 | 操作 | 预期 |
|------|------|------|
| 复制后改写 | 段落菜单「⧉ 复制」→ 改文本 → 提交 → 版本比对 | `结构·新增·复制(新身份/复制后改写)`，卡片标注来源节点、id 不同 |
| 复制复用身份（反例） | 「⎘ 同身份复制*」→ 提交 | 树内重复 id，提交被拒绝 |
| 跨章节移动 | 「移到上/下一章」→ 提交 → 比对 | 单张 `结构·移动`（nodeId 不变），不是删除+新增（种子 v1→v2 已内置） |
| 两人同时回滚 | 先在版本面板**签收 v1**，回滚页点「两人同时发起并通过」 | 仅一单成功并生成回滚版，另一单 superseded |
| 审批中附件替换 | 发起回滚后，在草稿点附件「替换文件」→ 提交 | pending 工单立即作废；强点通过返回 409；重新发起补丁含 `结构·附件替换` |
| 比较进程崩溃 | 比对页勾选「模拟崩溃」→ 开始比对 | 任务 failed，可重试 |
| 旧结果拒收 | 勾选「比对期间自动制造新编辑」→ 比对 | 回包过期被拒收，锚点保留，一键按新基线重算 |
| 独立还原 | 任意已签收版本 → 发起回滚 → 甲确认补丁并通过 | 新版本 `rootHash` 与目标版本相同，历史版本原样保留 |

## 目录

```
docs/DESIGN.md              架构/协议/恢复成本/验收设计
server/schema.sql           PG DDL：版本图、签收、回滚工单、oplog、检查点、diff_job
src/versioning/tree.js      不可变树：canonical、Merkle hash、冻结、复制换身份
src/versioning/diff.js      三类 hunk 引擎、行内 LCS、patch_hash
src/services/mockServer.js  事务语义等价的内存服务
src/components/             编辑器（节点锚点）/ 版本 / 比对 / 回滚面板
```
