-- CreateTable
CREATE TABLE "AiAnalysisReport" (
    "id" SERIAL NOT NULL,
    "queryRecordId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "userNotes" TEXT NOT NULL DEFAULT '',
    "report" TEXT NOT NULL,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAnalysisReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiAnalysisReport_queryRecordId_createdAt_idx" ON "AiAnalysisReport"("queryRecordId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AiAnalysisReport" ADD CONSTRAINT "AiAnalysisReport_queryRecordId_fkey" FOREIGN KEY ("queryRecordId") REFERENCES "QueryRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAnalysisReport" ADD CONSTRAINT "AiAnalysisReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "WechatUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
