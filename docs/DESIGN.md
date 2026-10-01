# 文稿台 · 版本比对与回滚 —— 技术设计

## 0. 需求拆解（可追溯）

| # | 需求 | 落地位置 |
|---|------|----------|
| R1 | Vue 按段落和格式显示补丁 | `ComparePanel.vue`：文本/样式/结构三类 hunk 卡片，行内 token、标签增删、移动/复制/附件结构摘要 |
| R2 | 比较服务读取不可变文稿树 | 版本快照 `Object.freeze` 深冻结；比较服务只通过 `getSnapshot(id)` 读；PG 侧版本行 append-only + `checkpoint_uri` |
| R3 | PG 保留版本图、签收人及理由 | `version(parent_id)`、`version_signoff(signer, reason, root_hash)`，reason CHECK 非空 |
| R4 | 移动段落 ≠ 删除后新增 | diff 以**节点 id（身份）**为主键：同 id 两版都在且父章节/次序变化 = `move`；id 消失才是 delete |
| R5 | 复制节点不能复用同一身份 | 复制走 `copyWithNewIdentity`：深拷贝后递归分配新 id；内容 hash 相同但 id 不同 → `insert(copied)`；草稿提交前校验树内 id 唯一；同 id 副本是反例，提交被拒 |
| R6 | 文本、结构、样式差异各自可定位 | 每个 hunk 强制且仅属于 `text/style/structure` 一类，带 `nodeId + path`，前端可按类过滤、点击滚动到节点锚点 |
| R7 | 回滚通过创建新版本实现 | approve 事务 INSERT `kind='rollback'` 新版本，`root_hash` 等同目标快照；历史版本与头指针形成新边，永不原地覆盖 |
| R8 | 审批的是头版→目标版之间的补丁 | 创建工单时服务端**冻结**补丁与 `patch_hash`；审批弹窗展示；通过时带 `expected_patch_hash` |
| R9 | 审批期间有人编辑需重新计算 | 提交新版本时 pending 单置 `superseded`；approve 事务再查 `head<>base_head_id` → 409 STALE_HEAD；并**重算补丁**比对 hash |
| R10 | 不能用过期确认覆盖新稿 | R9 + 行锁 `SELECT … FOR UPDATE` 顺序化，两人同时回滚只可能一单成功，另一单作废 |
| R11 | 整树快照 vs 操作日志配检查点 | §4：内容寻址快照（零重放装载）+ hash 链 oplog（审计/订阅）+ checkpoint 绑定日志位点 |
| R12 | 大文稿差异异步执行 | `diff_job` 表 + worker 租约；前端拿 jobId 轮询，结果信封带 `base_head_hash` |
| R13 | 前端保留节点锚点并拒绝旧结果回包 | 任务期间不清空筛选/锚点；回包 `baseHeadHash !== 当前HEAD` 整包丢弃并提示重算 |
| R14 | 验收五个场景 | §7 对照表 |
| R15 | 任意已签收版本独立还原 | signoff 钉住 `(version_id, root_hash)`；回滚只依赖该快照与其 checkpoint，不依赖后续版本 |

---

## 1. 数据模型

### 1.1 文稿树：身份与内容双标识

```
Node = Section | Paragraph | Attachment
Section    { id, kind:'section',    title, marks[], children: Node[] }
Paragraph  { id, kind:'p',          text,  marks[] }
Attachment { id, kind:'attachment', name, blobHash, mime, size, marks[] }
```

- **id（身份）**：编辑期内随节点存活。移动不改 id；编辑文本/样式不改 id；
  **复制必须产生全新 id（含嵌套子树递归换发）**。
- **hash（内容）**：`hash(canonical(node))`，canonical **不含 id**；
  section 的 hash 纳入所有子节点 hash（Merkle）。根 hash `root_hash` 代表整稿内容。
  ⇒ 复制出来的节点 hash 相同、id 不同；移动后树在新位置重算，父级 hash 变化但节点身份不变。
- canonical 规则：键固定顺序、marks 排序、缺省字段归一（演示 `canonicalNode`；生产用 canonical JSON，
  哈希算法换 BLAKE3/xxhash3）。
- 提交即冻结：演示用 `deepFreeze`；生产快照写对象存储（S3 Object Lock / WORM bucket）或
  PG TOAST 表，地址即 `checkpoint_uri`，`version` 行只存 `root_hash + uri`。

> 为什么不能只存整稿大 JSON：不可变对象按 hash 去重后，跨版本共享未改动子树，
> v2 只新增“变化路径”上的对象，存储接近操作日志方案，读取却像整树快照（见 §4 成本对比）。

### 1.2 关系表（详见 `server/schema.sql`）

```
manuscript(doc_id, head_version_id)                       -- 头指针，唯一推进点
version(version_id, doc_id, number, kind, parent_id,
        root_hash, checkpoint_uri, restored_from, …)      -- append-only 版本图
version_signoff(signoff_id, version_id, signer,
        reason NOT EMPTY, root_hash, created_at)
rollback_request(rollback_id, state,
        base_head_id, base_head_hash,                     -- 创建时冻结的头
        target_id, target_root_hash,
        patch_hash, patch_manifest,                       -- 冻结的补丁
        requested_by, reason, approver, result_version_id, …)
operation_log(seq, op, detail, prev_hash, checksum)       -- hash 链
checkpoint(version_id, root_hash, op_seq, storage_uri)
diff_job(job_id, from_version, to_version, base_head_hash,
        state, result_uri, lease_owner, lease_until, attempts)
attachment_blob(blob_hash, storage_uri, size, mime)       -- 附件替换 = 新 blob
```

版本图是一棵以 parent_id 为边的 DAG（线性提交 + 回滚回边指向已签收版本），
`head_version_id` 永远指向最新提交。**回滚版与普通版在图里同构**，
差别只是 `kind='rollback'` 与 `restored_from`，因此“还原后继续编辑”不需要特殊逻辑。

---

## 2. 差异模型：三类可定位 hunk

补丁是从旧版路径到新版路径的 hunk 序列，hunk 是最小定位单元：

```jsonc
{ "id": "h…", "type": "text|style|structure", "op": "modify|move|delete|insert|…",
  "nodeId": "p_intro", "blockKind": "p", "sectionId": "s_1",
  "oldPath": [0,0], "newPath": [0,0],
  // text: tokens = LCS 行内差异 [{t:'eq|ins|del', text}]
  // style: removedMarks/addMarks
  // structure: oldSummary/newSummary/copied/likeCopyOf …
}
```

判定规则（身份优先）：

1. id 两版都有：
   - 父章节变化，或**同章节幸存块相对次序**变化 → `structure/move`（跨章节/章内重排）；
   - p 文本变化 → `text/modify`（行内 LCS，按 Intl word 分词）；
   - marks 变化 → `style/modify`（removed/add 分别列出）；
   - 附件 `blobHash/size` 变化 → `structure/attachment-replaced`；附件改名算 text。
   - 章节标题变化 → `text`（blockKind=section-title）；章节调序 → `structure/move`。
2. id 只在旧版 → `structure/delete`。
3. id 只在新版：
   - 新节点内容 hash 命中某个旧块 → `structure/insert {copied:true, likeCopyOf}`；
   - 否则做段落级相似度（LCS/长度 ≥0.6）命中 → `copied + tokens`（**复制后改写**仍可溯源）；
   - 都不命中 → 纯新增。

由此 R4/R5 天然成立：
“删除再在别处新增”是新 id → delete+insert 两张卡；“移动”是同 id 一张 move 卡；
“复制”是内容 hash 相等但 id 不同，并标注来源节点。

`patch_hash = hash(canonical(hunks + from/to root_hash))`，作为审批与防篡改凭证。

---

## 3. 并发提交协议（回滚审批）

### 3.1 角色与时序

- **编辑**：在草稿（基于 head 的工作副本）上修改，提交 → `commit_version` 推进 head。
- **发起人**：对任一**已签收**版本创建回滚工单。
- **审批人**：审阅创建时冻结的补丁，确认后通过。

### 3.2 创建工单（事务）

```
SELECT head_version_id, head root, target root FOR 快照读;
ASSERT target 存在签收行;
ASSERT target <> head;
patch = compute_patch(head → target);            -- 此刻冻结
INSERT rollback_request(state='pending',
       base_head_id=head, base_head_hash, target_id, target_root_hash,
       patch_hash=patch.hash, patch_manifest=patch.hunks);
```

审批语义被物化：审批人批准的不是“回滚到 v1”这个意图，
而是**确定的字节序列补丁**（hunk 列表 + 两端 root_hash + patch_hash）。

### 3.3 提交新版本（事务）

`commit_version` 推进 head 后立即：

```
UPDATE rollback_request SET state='superseded', supersede_reason=…
 WHERE doc=? AND state='pending' AND base_head_id <> NEW_head;
```

让界面上的旧单立刻变灰；这只是**第一道防线（快速失败）**。

### 3.4 审批通过（事务，第二、三、四道防线）

`approve_rollback(rid, approver, expected_patch_hash)`：

1. `SELECT * FROM rollback_request … FOR UPDATE`，state 必须 pending；
2. `SELECT head_version_id FROM manuscript … FOR UPDATE`，
   `current_head <> base_head_id` ⇒ 置 superseded 并抛 `STALE_HEAD`（SQLSTATE 40001/409）；
3. `expected_patch_hash = r.patch_hash`（防看错单/防中间人改单）；
4. **服务端重算** `compute_patch(base_head → target)`，hash 必须仍等于冻结值
   （快照不可变时这步恒等，保留它是为了比对服务升级/快照损坏时 fail-closed）；
5. 目标存在签收行且 `root_hash` 与工单一致；

全部通过才：

```
INSERT version(kind='rollback', parent=current_head,
               root_hash=target.root_hash, checkpoint_uri=target.checkpoint_uri,
               restored_from=target, rollback_id=rid);
UPDATE manuscript SET head=NEW;
UPDATE rollback SET state='approved', result=NEW;
-- 同基线其它 pending 单（第二个人的确认）批量置 superseded
```

行锁顺序固定为 `rollback_request → manuscript`，两笔并发审批：
先拿到 manuscript 行锁的提交成功，后者等到锁后看到 head 已变 → STALE_HEAD。
**不可能出现两个回滚版，也不可能用旧补丁覆盖审批期间的新提交。**

冲突返回 409 后客户端标准动作：拉取新版本图 → 按新 head 重新创建工单（新补丁重新走审批）。

---

## 4. 快照 vs 操作日志：恢复成本对比

| 方案 | 装载 v(k) | 存储量 | 篡改防护 | 适用 |
|------|-----------|--------|----------|------|
| A. 整树快照（每版全量） | O(1) 直接读 | O(N×树) | hash 自校验 | 读多 |
| B. 纯操作日志 | 从 v1 顺序重放 k-1 个 op | O(变更量) | hash 链 | 审计、协作事件流 |
| **C. 混合（本设计）** | **命中 checkpoint：O(1)**；最坏从最近 checkpoint 重放尾部 | O(变更量 + 去重共享对象) | 快照 Merkle 自校验 + 日志链双保险 | 生产 |

混合方案要点：

- `checkpoint(version_id, root_hash, op_seq, storage_uri)`：每次 commit/rollback 都落；
  内容寻址让未改子树零成本共享，A 方案的存储退化并不发生。
- `operation_log`：`checksum = H(prev_hash | seq | canonical(detail))`，
  断链/改写立刻可验；提供给实时订阅、审计报表、崩溃后的尾日志重放。
- 大文稿可改为每 N 个 op 或定时 checkpoint，恢复成本 = 重放 ≤ N 条 op。
- **任意已签收版本独立还原**：signoff 行钉住 `(version_id, root_hash)`，
  其 checkpoint 永不 GC（未签收的中间快照可按策略回收），
  回滚直接引用该 `checkpoint_uri`，与“它之后又过了多少版”无关。

---

## 5. 异步比对服务（大文稿）

### 5.1 任务协议

1. `POST /diff {from,to}` → 服务端建 `diff_job(state=queued, base_head_hash=当前head)`，返回 jobId；
2. worker 抢占：`UPDATE … SET state='running', lease_owner=me, lease_until=now()+30s
   WHERE job_id=? AND state IN ('queued','running' 且租约过期)`——崩溃后租约到期可被接管重试
   （`attempts` 限次，结果/补丁写对象存储，表存 `result_uri`）；
3. worker **只读**两张不可变快照 + 附件 blob，不持业务写锁，不阻塞编辑提交；
4. `GET /diff/{jobId}` 返回 `{state, result?, error, base_head_hash}`。

### 5.2 前端防旧包（stale envelope）

- 发起任务后前端只保存 `jobToken`；轮询回包先比对
  `envelope.base_head_hash === 当前版本图 HEAD`，不一致：
  **不渲染补丁、不写高亮**，显示“结果已拒收”，保留节点锚点/筛选条件，引导一键重算。
- 组件卸载/重新发起时 `jobToken++`，迟到轮询直接丢弃。
- 演示中“比对进行中自动制造新编辑”开关复现该竞态；
  “模拟比对进程崩溃”开关让 worker 写 `state=failed`，前端给重试入口
  （生产由租约机制自动重新调度）。

### 5.3 性能

- 行内 LCS 是 O(n·m)，按段落执行；超大段落用 Myers + 阈值或先按句子分块。
- 结构匹配 O(旧块+新块)（id map + hash map），相似度兜底只对未匹配块做。
- 大文稿 worker 分片（按章节）计算再合并；补丁按 hunk 分页返回，首屏只渲染可视章节。

---

## 6. 前端结构

```
src/
  versioning/tree.js      # 节点模型、canonical、Merkle hash、freeze、复制换身份
  versioning/diff.js      # 三类 hunk 引擎、行内 LCS、patch_hash
  services/mockServer.js  # 等价后端：版本图/签收/工单事务/异步任务/oplog
  components/
    ManuscriptEditor.vue  # 段落树编辑；data-node-id 锚点；差异 chip 与三类左侧色条
    VersionPanel.vue      # 版本图、签收（理由）、提交、发起回滚入口
    ComparePanel.vue      # 基线选择、异步状态、防旧包、过滤器、hunk 卡片
    RollbackPanel.vue     # 工单、冻结补丁入口、甲/乙审批、并发按钮
  App.vue                 # 状态编排、toast、补丁弹窗、恢复成本视图、日志
server/schema.sql         # PG DDL + commit/approve 事务函数
```

节点锚点：编辑器每个块/章节渲染 `data-node-id`；点 hunk 卡片
→ `scrollIntoView({block:'center'})` + 闪烁高亮；
比对结果过期时不清空锚点，只清空高亮层。

---

## 7. 验收用例

| 用例 | 操作路径 | 预期 |
|------|----------|------|
| **U1 复制后改写** | 段落菜单「⧉ 复制」→ 改文本/加样式 → 提交 → 与基线比对 | 出现 `结构·新增·复制(新身份)`（纯复制）或 `…复制后改写`（带行内 token），来源节点显示在卡片；对比「⎘ 同身份复制*」反例：树内重复 id，提交被拒 |
| **U2 跨章节移动** | 「移到上一章/下一章」→ 提交 → 比对 | 单张 `结构·移动` 卡，父章节变化、nodeId 不变；无 delete+insert；v1→v2 种子数据已内置一例 |
| **U3 两人同时回滚** | 签收 v1 → 回滚面板「两人同时发起并通过」 | Promise 并发下仅一人成功生成 rollback 版，另一单 `superseded`，日志含 `rollback-approve` 与 `rollback-superseded`；手工对已过期单点通过 → 409 STALE_HEAD |
| **U4 审批中附件替换** | 发起回滚（pending）→ 草稿里「替换文件」→ 提交 → 回审批 | 工单立即变「已过期作废」；即使强点通过也 409；重新发起后补丁含 `结构·附件替换`（id 不变、blobHash 变） |
| **U5 比较进程崩溃** | 勾选「模拟崩溃」→ 开始比对 | job failed，前端提示并可重试；生产由 `diff_job.lease_until` 自动重新抢占 |
| **附：旧结果拒收** | 勾选「比对期间自动制造新编辑」→ 比对 | 回包 `baseHeadHash ≠ HEAD`，补丁不渲染、锚点保留，一键按新基线重算 |
| **附：独立还原** | 签收 v1 后连续制造 v2/v3/v4 → 从版本面板对 v1 发起回滚并通过 | 生成新版本，rootHash 与 v1 完全相同（内容字节级还原），不依赖 v2~v4；回滚版同样可再签收 |

---

## 8. 生产化清单（演示之外）

- canonical 序列化与哈希固化为跨语言规范（JSON Canonicalization Scheme + BLAKE3）。
- 快照存 WORM 对象存储，PG 只存 root_hash/manifest；上传走先写对象、后插版本行。
- `approve_rollback` 的补丁重算由比较服务 RPC 完成或预生成 `patch_hash` 唯一表。
- diff_job 加章节分片、结果分页、worker 指标；前端改 SSE/WebSocket 推送。
- 审批支持多人会签：`rollback_request` 改 `required_approvals` + 子表，quorum 达成才推进 head，
  期间 head 变化规则不变（任一人在过期基线上的确认作废，需要对新补丁重新表态）。
- 权限：签收/审批角色、reason 模板、工单通知；oplog 投递到只追加审计存储。
