-- 新增 status 字段，默认 'pending'
ALTER TABLE "QueryRecord" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';

-- 历史记录（已有 summaryJson）标记为 done
UPDATE "QueryRecord" SET "status" = 'done' WHERE "summaryJson" IS NOT NULL;
