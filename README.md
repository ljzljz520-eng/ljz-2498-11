# Catalpa 文稿台：版本比对与回滚

在原有 Catalpa 编辑/预览基础上，实现了一套**不可变文稿树**的版本管理系统：结构/文本/样式三维补丁、
按段落与格式展示差异、检查点+操作日志的混合存储、基于乐观锁（CAS）的回滚审批，以及大文稿异步比对与防旧包。

## 快速开始

```bash
pnpm install
pnpm dev       # 开发：http://localhost:3000
pnpm test      # 核心单元 + 5 个验收场景（Node 直接运行，无需浏览器）
pnpm build
```

## 功能总览

- **不可变文稿树**：节点有稳定身份（id）；移动保留身份，复制整子树换发身份；内容与身份分离（内容指纹哈希）。
- **三维差异**（`src/core/diff.js`）：
  - 结构：`move / copy / insert / delete`，移动用 LCS 与"删除后新增"严格区分；
  - 文本：段落级 token LCS，段内行内删/增上色；
  - 样式：块级 attrs 与行内 marks 区间（added/removed/restyled）分别报告；
  - 每个差异都带节点 id 与根→节点路径锚点。
- **版本存储**（`src/core/history.js`，PG DDL 见 `docs/design.md`）：
  版本图 + 前向操作日志 + 每 K 个版本/签收/回滚的检查点快照；物化成本上界 K−1 次操作回放；
  已签收版本强制快照，**任意已签收版本 0 回放独立还原**。
- **比较服务**（`src/core/compare.js`）：只读不可变版本、分片异步、可取消、可注入崩溃；
  回包带请求序号与计算时头版，前端丢弃过期回包。
- **回滚审批**（`src/core/protocol.js`）：回滚=创建新版本；确认的是"当前头版→目标版"补丁；
  审批期间有人编辑/替换附件/他人先回滚，头版 seq 前进，旧确认以 `HEAD_MOVED` 拒绝，必须重算。

## 页面操作

顶栏提供 5 个**验收场景一键复现**按钮：① 复制后改写 ② 跨章节移动 ③ 两人同时回滚
④ 审批中附件替换 ⑤ 比较进程崩溃。常规操作：

1. 左侧树编辑器改文字、加粗/对齐、复制段落、跨章移动、替换附件 →「提交为新版本」；
2. 右上选择基准版/目标版 →「比较版本（异步）」，右侧按 结构/文本/样式 三个页签查看补丁；
3. 对任意版本填写签收人/理由后「签收」；
4. 在补丁区填写理由「发起回滚审批」，在版本图底部对提案做 重新校验/确认/拒绝；
5. 「独立还原/成本」可查看某版本物化时基于哪个检查点、回放了多少操作、内容哈希。

## 目录

```text
docs/design.md            # PG DDL、三维差异规则、恢复成本、并发提交协议、验收对照
src/core/                 # 纯逻辑（无 Vue 依赖，可独立测试）
  tree.js identity.js hash.js snapshot.js diff.js history.js compare.js protocol.js
src/composables/useManuscript.js
src/components/           # TreeEditor / VersionGraph / PatchView
test/unit.test.js         # 单元：移动区分、复制换身份、文本/样式、物化、签收
test/acceptance.test.js   # 5 个验收场景 + 签收独立还原
```
