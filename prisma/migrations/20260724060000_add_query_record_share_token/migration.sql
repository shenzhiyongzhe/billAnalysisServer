-- AlterTable
ALTER TABLE "QueryRecord" ADD COLUMN "shareToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "QueryRecord_shareToken_key" ON "QueryRecord"("shareToken");
