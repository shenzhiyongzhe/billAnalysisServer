-- 先删除重复的 idNumber 记录，只保留最早那条（id 最小）
-- 如果表是全新的、没有重复数据，这一步会安全地跳过
DELETE FROM "StatementUser"
WHERE id NOT IN (
  SELECT MIN(id)
  FROM "StatementUser"
  GROUP BY "idNumber"
);

-- 添加唯一约束
CREATE UNIQUE INDEX "StatementUser_idNumber_key" ON "StatementUser"("idNumber");

-- 同步 Prisma 约束元数据
ALTER TABLE "StatementUser" ADD CONSTRAINT "StatementUser_idNumber_key" UNIQUE USING INDEX "StatementUser_idNumber_key";
