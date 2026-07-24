-- AlterTable
ALTER TABLE "QueryRecord" ADD COLUMN "uploadRequestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "QueryRecord_uploadRequestId_key" ON "QueryRecord"("uploadRequestId");
