-- DropIndex
DROP INDEX "QueryRecord_shareToken_key";

-- AlterTable
ALTER TABLE "QueryRecord" DROP COLUMN "shareToken";

-- AlterTable
ALTER TABLE "ShareRecord"
ADD COLUMN "queryRecordId" INTEGER,
ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "ShareRecord" SET "updatedAt" = "createdAt";

ALTER TABLE "ShareRecord"
ALTER COLUMN "updatedAt" SET NOT NULL;

-- CreateIndex
CREATE INDEX "ShareRecord_sharerId_idx" ON "ShareRecord"("sharerId");

-- CreateIndex
CREATE INDEX "ShareRecord_openerId_idx" ON "ShareRecord"("openerId");

-- CreateIndex
CREATE INDEX "ShareRecord_queryRecordId_idx" ON "ShareRecord"("queryRecordId");

-- CreateIndex
CREATE INDEX "ShareRecord_createdAt_idx" ON "ShareRecord"("createdAt");

-- AddForeignKey
ALTER TABLE "ShareRecord"
ADD CONSTRAINT "ShareRecord_queryRecordId_fkey"
FOREIGN KEY ("queryRecordId") REFERENCES "QueryRecord"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
