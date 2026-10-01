# 文稿台版本比对与回滚 — 设计说明

> 对应需求：给文稿台加入版本比对与回滚；Vue 按段落与格式显示补丁；比较服务读取不可变文稿树；
> PG 保留版本图、签收人及理由；移动≠删除后新增、复制不复用身份；文本/结构/样式差异各自可定位；
> 回滚通过创建新版本实现，确认人审批"当前头版→目标版"补丁，期间有人继续编辑必须重算，过期确认不能覆盖新稿；
> 比较整棵树快照与操作日志配检查点的恢复成本与并发提交协议；大文稿差异异步、前端保留节点锚点并拒绝旧结果；
> 验收复制后改写、跨章节移动、两人同时回滚、审批中附件替换、比较进程崩溃；任意已签收版本独立还原。

## 1. 总体架构

```
┌─────────────── Vue 3 前端 ───────────────┐
│ TreeEditor   VersionGraph   PatchView    │
│  (活稿编辑)   (版本/签收/审批) (三维补丁)   │
└───────┬──────────────┬──────────────┬────┘
        │ 编辑/提交      │ 比较请求(异步)  │ 审批(CAS)
┌───────▼──────────────▼──────────────▼────────────────┐
│  版本服务          比较服务(只读)        回滚协调器       │
│  HistoryStore     CompareService      RollbackCoord.  │
└───────┬──────────────┴──────────────┬────────────────┘
        │                             │ 物化(检查点+日志回放)
┌───────▼─────────────────────────────▼────────────────┐
│  PostgreSQL：版本图 / 操作日志 / 签收 / 回滚提案          │
│  对象存储(或 PG bytea)：内容寻址不可变快照               │
└───────────────────────────────────────────────────────┘
```

核心不变量：

1. **文稿树不可变**：每次编辑产出一棵新树（结构共享未触及节点），旧版本永不被原地改写。
2. **比较只读不可变版本**：比较服务只从"检查点快照 + 前向操作日志回放"物化出的树读取，绝不读编辑中的活稿。
3. **身份（identity）与内容（content）分离**：
   - `node.id` 是身份，移动保持不变；复制整棵子树**换发全部 id**，不复用；
   - 内容指纹（FNV-1a 64bit 哈希）只看 type/text/marks/attrs/子序，复制件与原件指纹相同但 id 不同。
4. **回滚不是覆盖**：在版本图上追加一个"内容等于目标版、父节点为当前头版"的新版本。
5. **审批对象是补丁**：`patch = diff(当前头版, 目标版)`，带 `checksum`；头版一前进，旧补丁立即失效。

## 2. 数据模型（PostgreSQL DDL）

```sql
-- 文稿
CREATE TABLE documents (
  doc_id      TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 版本图：每个版本一个节点，parent_id 形成（可分叉的）有向图；本系统按线性链使用
CREATE TABLE versions (
  doc_id         TEXT NOT NULL REFERENCES documents(doc_id),
  version_id     TEXT NOT NULL,
  parent_id      TEXT,
  commit_seq     BIGINT NOT NULL,           -- 文档内单调递增，乐观锁版本号
  author         TEXT NOT NULL,
  message        TEXT NOT NULL,
  snapshot_hash  TEXT NOT NULL,             -- 指向内容寻址快照（恒等还原依据）
  is_checkpoint  BOOLEAN NOT NULL DEFAULT false,
  signed_off     BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, version_id),
  UNIQUE (doc_id, commit_seq)
);
CREATE INDEX ON versions(doc_id, commit_seq DESC);

-- 内容寻址不可变快照（生产可放 S3/OSS，DB 只存 hash；演示用 jsonb/bytea）
CREATE TABLE snapshots (
  content_hash CHAR(16) PRIMARY KEY,        -- 规范化 JSON 的 FNV-1a 64bit
  payload      JSONB NOT NULL,              -- {rootId, nodes:{id:{...children:[]}}}
  bytes        INT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 前向操作日志：检查点之间用于物化；同时是"复制溯源"的权威来源
CREATE TABLE op_log (
  seq        BIGSERIAL PRIMARY KEY,
  doc_id     TEXT NOT NULL,
  version_id TEXT NOT NULL,
  op_kind    TEXT NOT NULL CHECK (op_kind IN ('TEXT','STYLE','MOVE','DELETE','INSERT','COPY')),
  node_id    TEXT,                           -- COPY 时为新复制子树根 id
  payload    JSONB NOT NULL,                 -- TEXT:{text,marks} MOVE:{parentId,index}
                                             -- COPY:{fromId,parentId,index,idMap:{旧id:新id}}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON op_log(doc_id, version_id);

-- 签收：一个版本可被多人多次签收；签收即强制检查点（GC 豁免，独立可还原）
CREATE TABLE sign_offs (
  id         BIGSERIAL PRIMARY KEY,
  doc_id     TEXT NOT NULL,
  version_id TEXT NOT NULL,
  signer     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  signed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (doc_id, version_id, signer)
);

-- 回滚提案（审批中的补丁 + 乐观锁基准）
CREATE TABLE rollback_proposals (
  id                    TEXT PRIMARY KEY,
  doc_id                TEXT NOT NULL,
  base_head_version_id  TEXT NOT NULL,       -- 提案时的头版
  base_head_seq         BIGINT NOT NULL,     -- 提交时 CAS 比较的就是它
  target_version_id     TEXT NOT NULL,
  patch                 JSONB NOT NULL,
  patch_checksum        CHAR(16) NOT NULL,
  reason                TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('OPEN','APPROVED','STALE','REJECTED','SUPERSEDED')),
  requested_by          TEXT NOT NULL,
  approved_by           TEXT,
  approval_reason       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at           TIMESTAMPTZ
);
-- 每篇文稿最多一个进行中提案（可按业务取舍；保留错误也可改为按人唯一）
CREATE UNIQUE INDEX one_open_proposal_per_doc
  ON rollback_proposals(doc_id) WHERE status = 'OPEN';
```

补丁 JSON（`catalpa.patch/v1`）：

```jsonc
{
  "format": "catalpa.patch/v1",
  "baseSnapshot": "v5", "targetSnapshot": "v2",
  "dimensions": { "structure": 3, "text": 2, "style": 1 },
  "ops": [
    { "kind": "move",   "id": "par-body-1",
      "from": { "parentId": "sec-body", "index": 0, "path": [...] },
      "to":   { "parentId": "sec-intro", "index": 2, "path": [...] } },
    { "kind": "copy",   "id": "par_ab12…", "fromId": "par-intro-1", "parentId": "sec-intro", "index": 2, "path": [...] },
    { "kind": "delete", "id": "par-x", "parentId": "sec-body", "index": 3, "path": [...] },
    { "kind": "insert", "id": "par_new", "parentId": "sec-intro", "index": 1, "path": [...] },
    { "kind": "text",   "id": "par-intro-2", "anchor": {...},
      "segments": [ {"type":"eq","text":"…"}, {"type":"del","text":"、"}, {"type":"ins","text":"与"} ] },
    { "kind": "style",  "id": "att-1", "anchor": {...},
      "attrChanges": [ {"key":"assetId","before":"asset-v1","after":"asset-v2"} ],
      "markChanges": [ {"type":"range-restyled","range":{"from":0,"to":4},"mark":"strong","before":null,"after":{"tone":"red"}} ] }
  ],
  "checksum": "9f3c…"        // 除 checksum 外全部字段的规范化哈希
}
```

每个 op 都带 `anchor/from/to.path`（根→节点的 id 路径），前端据此**保留节点锚点**：
即使整棵树重新渲染，节点 id 不变即可滚动定位；移动给出 from/to 两个锚点。

## 3. 三维差异如何区分语义

| 需求 | 判定 |
|---|---|
| 移动 | 同一 id 在两树都存在，且**父节点改变**；同父重排用子 id 序列的 **LCS**，只有脱离公共子序列的节点报 move，避免一次增删引发兄弟 index 级联误报 |
| 删除后新增 | 旧 id 在目标树消失 → `delete`；新内容用新 id 出现 → `insert`。即使文本完全相同也**不会**被当作移动（id 不同） |
| 复制 | 新 id 出现且 `op_log.COPY.idMap` 有溯源 → `copy`（权威，复制后再改写/改样式仍报 copy + text/style）；无日志的外部快照退化为"内容指纹相同 **且源节点在目标仍存在**"启发式，从根本上排除"删除+新建同内容"被误判 |
| 文本 | 同一身份（或 copy 溯源到源）节点的 text 做 token LCS：多行按行、单行按词；输出 eq/del/ins 段，段落在前端逐段渲染、段内行内上色 |
| 样式 | 块级 `attrs`（对齐、附件 assetId 等）逐键比较；行内 `marks` 按 `from:to:type` 对齐，区分 range-added/removed/restyled |

## 4. 快照 vs 操作日志：恢复成本

两种极端：

- **全量快照每版本**：恢复 O(1)（读一份），但写入与存储 O(N·版本数)，大文稿不可承受。
- **只存操作日志**：存储小，但恢复要从 V1 重放到 Vk，O(k·操作数)，版本越老越慢，且日志一旦缺失/损坏就无法恢复。

本系统采用**检查点（快照）+ 前向日志**混合：

- 每 `K=5` 个版本落一份内容寻址全量快照；`V1`、每次**回滚新版本**、每次**签收**额外强制落点。
- 物化任意版本：读最近祖先检查点快照，沿 parent 链**顺序回放**到目标版本。
- **恢复成本上界 = K−1 个版本的操作回放**（验收实测 ≤4），空间约为 `快照数 × N + 操作总数`。
- 回放是确定性的：INSERT/COPY 的新节点 id 在提交时一次性配发并写进日志（COPY 存 `idMap`），回放复用同一 id，因此重放出的树内容哈希与提交时完全一致（单测验证）。
- **GC**：普通检查点可随保留窗口回收；**已签收版本快照永不回收**，所以任何签收版本永远 0 回放独立还原，不依赖之后是否压缩/删除日志。

## 5. 并发提交协议（回滚审批）

提案（只读校验）：

1. 比较服务异步返回 `result{fromVersionId, toVersionId, patch, headVersionIdAtCompute, headSeqAtCompute}`。
2. `propose` 要求 `fromVersionId` 必须等于**当前头版**且计算时头版未变，否则直接拒绝（比较结果已过期）。
3. 落 `rollback_proposals`，保存 `base_head_version_id/base_head_seq/patch_checksum/patch`。

审批（单事务、文档级串行）：

```sql
BEGIN;
-- 等价 SELECT … FOR UPDATE：锁住文稿头版行
SELECT commit_seq, version_id FROM versions
 WHERE doc_id = :doc ORDER BY commit_seq DESC LIMIT 1 FOR UPDATE;

-- 三个条件全部满足才允许提交
IF head.version_id <> proposal.base_head_version_id
   OR head.commit_seq <> proposal.base_head_seq THEN
  RAISE EXCEPTION 'HEAD_MOVED';              -- 期间有人编辑/他人已回滚/附件被替换
END IF;
IF checksum(proposal.patch) <> proposal.patch_checksum THEN
  RAISE EXCEPTION 'PATCH_TAMPERED';
END IF;

-- 内容 = 目标版快照（身份沿用：这是"还原"而非"复制"）
INSERT INTO snapshots … ON CONFLICT DO NOTHING;  -- 目标快照本就不可变存在
INSERT INTO versions(doc_id, version_id, parent_id, commit_seq, snapshot_hash, is_checkpoint, …)
VALUES (:doc, newId, head.version_id, head.seq+1, :target_snapshot_hash, true, …);
UPDATE rollback_proposals SET status='APPROVED', approved_by=…, approved_at=now();
COMMIT;
```

要点：

- **两人同时回滚**：两个审批在文档锁内串行。先提交者插入 seq+1 成功；后者在锁内重新读到新头版，`base_head_seq` 不匹配 → `HEAD_MOVED`，**只有一人成功**。
- **审批中继续编辑 / 附件替换**：头版 seq 前进，提案 `validate` 立即变 `HEAD_MOVED`（UI 红色失效），确认按钮提交也被同一条件挡下——**不能用过期确认覆盖新稿**。用户必须重新点"比较"得到 `diff(新头版, 目标)` 的新补丁、走新一轮审批。
- 审批中的"附件替换"无需特殊通道：附件是树上的节点（`attrs.assetId`），替换产生一个普通 STYLE 提交使头版前进，天然纳入同一 CAS。
- 新版本 `is_checkpoint=true`，回滚结果自身独立可还原。

## 6. 大文稿异步比较与防旧包

- 比较在独立服务（生产为 worker 进程/队列）中执行，输入是两个**版本 id**而非活树；worker 从不可变快照物化，分片计算（本实现每 200 个节点 `setTimeout(0)` 让出一次事件循环），期间可**取消**、可**崩溃**。
- 请求带单调递增 `requestSeq`，回包带 `{jobId, requestSeq, headVersionIdAtCompute, headSeqAtCompute, checksum}`。
- 前端规则：
  1. 发起新请求即 cancel 在途 job；
  2. 回包到达时 `mySeq !== latestSeq || jobId !== activeJobId` 一律**丢弃**并计数（"已拒绝 N 个过期回包"），不渲染；
  3. worker 崩溃只影响该 job，不触碰快照/版本，UI 提示重试（可注入 `crashRate` 复现）。
- 节点锚点：补丁的每个 op 带 id 路径；点击"定位节点"，编辑器用 id 高亮（历史版本中已不存在的 id 会明确提示），不因树重渲染丢失定位意图。

## 7. 前端结构

- `src/core/`：`tree.js`（不可变树与编辑原语）、`identity.js`（复制换身份）、`diff.js`（三维差异）、
  `snapshot.js`、`history.js`（版本图/日志/检查点/物化）、`compare.js`（异步比较）、`protocol.js`（审批 CAS）。
- `src/composables/useManuscript.js`：响应式状态、请求序号防旧包、编辑/提交/签收/审批动作。
- `src/components/`：`TreeEditor.vue`（树编辑）、`VersionGraph.vue`（版本/签收/提案）、`PatchView.vue`（三维补丁按段落与格式展示）。
- `test/unit.test.js`、`test/acceptance.test.js`：`pnpm test` 可直接运行。

## 8. 验收对照

| 验收项 | 自动化位置 |
|---|---|
| 复制后改写（新身份、copy+text 可定位） | `acceptance.test.js` 场景①；`unit.test.js` 复制组 |
| 跨章节移动（仅 move，给 from/to 锚点，区别删除新增） | 场景②；移动/删除新增单测 |
| 两人同时回滚（一胜 HEAD_MOVED 一败，新版本内容=目标版） | 场景③ |
| 审批中附件替换（旧补丁失效、重算后成功、附件一并还原） | 场景④ |
| 比较进程崩溃 + 大文稿异步 + 旧结果拒绝 | 场景⑤ |
| 任意已签收版本独立还原 | 场景附加 + 签收单测（0 回放） |
