-- =====================================================================
-- 文稿台：版本比对与回滚  PostgreSQL DDL（PG 14+）
-- 设计要点：
--   1. 文稿树存对象存储/内容寻址库（node 表可放 PG，也可放 S3+manifest），
--      树节点【冻结后不可变】，按 root_hash 内容寻址去重；
--   2. manuscript.head_version_id 是版本图的唯一推进点，更新走行锁 + CAS；
--   3. rollback_request 保存【创建时刻冻结的补丁 hash + 基线头 id】，
--      approve 在同一事务里做 5 项校验，过期确认一律 409；
--   4. 任何已签收版本可独立还原：signoff 直接钉住 root_hash，
--      回滚不是原地覆盖，而是 INSERT 一个 kind='rollback' 的新版本。
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- 文稿 ----------
CREATE TABLE manuscript (
    doc_id           text PRIMARY KEY,
    title            text NOT NULL DEFAULT '',
    head_version_id  bigint NULL,           -- 推进点，FK 在版本表建表后补
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------- 版本图（append-only，永不 UPDATE/DELETE） ----------
CREATE TABLE version (
    version_id     bigserial PRIMARY KEY,
    doc_id         text NOT NULL REFERENCES manuscript(doc_id),
    number         int  NOT NULL,
    kind           text NOT NULL CHECK (kind IN ('commit','rollback')),
    parent_id      bigint NULL REFERENCES version(version_id),
    root_hash      text NOT NULL,           -- 内容寻址 Merkle hash（不含 id）
    checkpoint_uri text NOT NULL,           -- 不可变树快照位置（S3/TOAST/manifest）
    message        text NOT NULL DEFAULT '',
    author         text NOT NULL,
    restored_from  bigint NULL REFERENCES version(version_id), -- rollback 版指向目标版
    rollback_id    bigint NULL,             -- 回填
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (doc_id, number),
    UNIQUE (doc_id, root_hash)              -- 相同内容不重复建版（可按需放行）
);
CREATE INDEX ON version (doc_id, parent_id);
ALTER TABLE manuscript
    ADD CONSTRAINT fk_head FOREIGN KEY (head_version_id) REFERENCES version(version_id);

-- ---------- 签收（理由必填；一个版本可多人多次签收） ----------
CREATE TABLE version_signoff (
    signoff_id   bigserial PRIMARY KEY,
    version_id   bigint NOT NULL REFERENCES version(version_id),
    doc_id       text NOT NULL REFERENCES manuscript(doc_id),
    signer       text NOT NULL,
    reason       text NOT NULL CHECK (length(btrim(reason)) > 0),
    root_hash    text NOT NULL,             -- 签收时刻钉死的快照 hash
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON version_signoff (version_id);

-- ---------- 回滚工单（审批单） ----------
CREATE TABLE rollback_request (
    rollback_id      bigserial PRIMARY KEY,
    doc_id           text NOT NULL REFERENCES manuscript(doc_id),
    state            text NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','approved','rejected','superseded')),

    -- 创建时冻结的审批对象
    base_head_id     bigint NOT NULL REFERENCES version(version_id),
    base_head_hash   text NOT NULL,
    target_id        bigint NOT NULL REFERENCES version(version_id),
    target_root_hash text NOT NULL,
    patch_hash       text NOT NULL,        -- 审批人确认的补丁字节 hash
    patch_manifest   jsonb NOT NULL,       -- hunk 列表（文本/样式/结构）+ 定位路径

    requested_by     text NOT NULL,
    reason           text NOT NULL DEFAULT '',
    approver         text NULL,
    result_version_id bigint NULL REFERENCES version(version_id),
    supersede_reason text NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    closed_at        timestamptz NULL
);
-- 同一头版基线下只允许一张 pending（用于“两人同时回滚”去重，可选）
CREATE UNIQUE INDEX ON rollback_request (doc_id, base_head_id, target_id)
    WHERE state = 'pending';

-- ---------- 操作日志（hash 链，审计/增量订阅/崩溃恢复重放） ----------
CREATE TABLE operation_log (
    seq        bigserial PRIMARY KEY,
    doc_id     text NOT NULL REFERENCES manuscript(doc_id),
    actor      text NOT NULL,
    op         text NOT NULL,              -- commit/signoff/rollback-*/diff-*
    detail     jsonb NOT NULL DEFAULT '{}',
    prev_hash  text NULL,
    checksum   text NOT NULL,              -- hash(prev_hash || seq || canonical(detail))
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- 检查点：版本 -> 快照 + 日志位点 ----------
CREATE TABLE checkpoint (
    checkpoint_id bigserial PRIMARY KEY,
    version_id    bigint NOT NULL REFERENCES version(version_id),
    root_hash     text NOT NULL,
    op_seq        bigint NOT NULL,         -- 该版本对应的日志位点
    storage_uri   text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------- 大文稿异步比对任务 ----------
CREATE TABLE diff_job (
    job_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id         text NOT NULL REFERENCES manuscript(doc_id),
    from_version   bigint NOT NULL REFERENCES version(version_id),
    to_version     bigint NOT NULL REFERENCES version(version_id),
    -- 信封：任务启动时的头版 hash，结果回包带它，前端/网关用来拒绝过期结果
    base_head_hash text NOT NULL,
    state          text NOT NULL DEFAULT 'queued'
                   CHECK (state IN ('queued','running','succeeded','failed')),
    result_uri     text NULL,              -- 大补丁放对象存储，表只存指针
    error          text NULL,
    lease_owner    text NULL,              -- worker 租约（崩溃后可被其他 worker 接管）
    lease_until    timestamptz NULL,
    attempts       int NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz NULL
);
CREATE INDEX ON diff_job (state, lease_until);

-- ---------- 附件（替换 = 新 blob 行；节点 id 不变，blob_hash 变） ----------
CREATE TABLE attachment_blob (
    blob_hash  text PRIMARY KEY,
    storage_uri text NOT NULL,
    size_bytes bigint NOT NULL,
    mime       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 事务函数：提交新版本（同时作废旧审批单）
-- =====================================================================
CREATE OR REPLACE FUNCTION commit_version(
    p_doc text, p_author text, p_message text,
    p_root_hash text, p_checkpoint_uri text
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
    v_head bigint; v_number int; v_new bigint;
BEGIN
    INSERT INTO manuscript(doc_id) VALUES (p_doc) ON CONFLICT DO NOTHING;

    SELECT head_version_id INTO v_head FROM manuscript WHERE doc_id = p_doc FOR UPDATE;
    SELECT COALESCE(MAX(number),0)+1 INTO v_number FROM version WHERE doc_id = p_doc;

    INSERT INTO version(doc_id,number,kind,parent_id,root_hash,checkpoint_uri,message,author)
    VALUES (p_doc,v_number,'commit',v_head,p_root_hash,p_checkpoint_uri,p_message,p_author)
    RETURNING version_id INTO v_new;

    UPDATE manuscript SET head_version_id = v_new, updated_at = now() WHERE doc_id = p_doc;

    -- 审批期间有人继续编辑：基线过期的 pending 单立即作废（approve 时还有二次校验）
    UPDATE rollback_request
       SET state='superseded', closed_at=now(),
           supersede_reason='审批期间产生新版本 '||v_new||'，补丁基线过期'
     WHERE doc_id=p_doc AND state='pending' AND base_head_id <> v_new;

    INSERT INTO operation_log(doc_id,actor,op,detail)
    VALUES (p_doc,p_author,'commit',jsonb_build_object('version',v_new,'parent',v_head,'root_hash',p_root_hash));

    RETURN v_new;
END $$;

-- =====================================================================
-- 事务函数：回滚审批通过（并发提交协议核心）
-- 任何一步校验失败 RAISE => 整个事务回滚，旧确认不可能覆盖新稿。
-- =====================================================================
CREATE OR REPLACE FUNCTION approve_rollback(
    p_rollback bigint, p_approver text, p_expected_patch_hash text
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
    r rollback_request%ROWTYPE;
    v_current_head bigint;
    v_recomputed_hash text;
    v_new bigint; v_number int;
    v_target_uri text;
BEGIN
    SELECT * INTO r FROM rollback_request WHERE rollback_id = p_rollback FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NO_ROLLBACK' USING ERRCODE='P0002'; END IF;
    IF r.state <> 'pending' THEN
        RAISE EXCEPTION 'RB_NOT_PENDING: %', r.state USING ERRCODE='check_violation';
    END IF;

    -- 锁头版指针
    SELECT head_version_id INTO v_current_head
      FROM manuscript WHERE doc_id = r.doc_id FOR UPDATE;

    IF v_current_head <> r.base_head_id THEN
        UPDATE rollback_request
           SET state='superseded', closed_at=now(),
               supersede_reason='审批时头版已变为 '||v_current_head
         WHERE rollback_id=p_rollback;
        RAISE EXCEPTION 'STALE_HEAD current=% base=%', v_current_head, r.base_head_id
            USING ERRCODE='serialization_failure';  -- => 客户端收到 409
    END IF;

    IF p_expected_patch_hash <> r.patch_hash THEN
        RAISE EXCEPTION 'PATCH_HASH_MISMATCH' USING ERRCODE='check_violation';
    END IF;

    -- 服务端重算补丁（读两张不可变快照），不信任客户端
    SELECT canonical_patch_hash INTO v_recomputed_hash
      FROM compute_patch(r.base_head_id, r.target_id);   -- 由比较服务实现（SQL/PL 或 RPC 回写）
    IF v_recomputed_hash <> r.patch_hash THEN
        RAISE EXCEPTION 'PATCH_RECOMPUTE_MISMATCH' USING ERRCODE='check_violation';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM version_signoff
         WHERE version_id = r.target_id AND root_hash = r.target_root_hash
    ) THEN
        RAISE EXCEPTION 'TARGET_NOT_SIGNED' USING ERRCODE='check_violation';
    END IF;

    SELECT checkpoint_uri INTO v_target_uri FROM version WHERE version_id = r.target_id;
    SELECT COALESCE(MAX(number),0)+1 INTO v_number FROM version WHERE doc_id = r.doc_id;

    -- 回滚 = 以已签收快照创建新版本（root_hash 与目标相同），绝不原地改写
    INSERT INTO version(doc_id,number,kind,parent_id,root_hash,checkpoint_uri,message,author,
                        restored_from,rollback_id)
    VALUES (r.doc_id,v_number,'rollback',v_current_head,r.target_root_hash,v_target_uri,
            '回滚还原到 v'||r.target_id,p_approver,r.target_id,p_rollback)
    RETURNING version_id INTO v_new;

    UPDATE manuscript SET head_version_id=v_new, updated_at=now() WHERE doc_id=r.doc_id;

    UPDATE rollback_request
       SET state='approved', approver=p_approver, result_version_id=v_new, closed_at=now()
     WHERE rollback_id=p_rollback;

    -- 同期其它 pending 单全部过期（两人同时回滚只可能一单成功）
    UPDATE rollback_request
       SET state='superseded', closed_at=now(),
           supersede_reason='并发审批已先生成版本 v'||v_new
     WHERE doc_id=r.doc_id AND state='pending' AND rollback_id<>p_rollback
       AND base_head_id=r.base_head_id;

    INSERT INTO operation_log(doc_id,actor,op,detail)
    VALUES (r.doc_id,p_approver,'rollback-approve',
            jsonb_build_object('rollback',p_rollback,'new_version',v_new,
                               'restored_from',r.target_id,'root_hash',r.target_root_hash));
    RETURN v_new;
END $$;
