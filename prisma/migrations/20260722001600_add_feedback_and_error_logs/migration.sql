-- CreateTable
CREATE TABLE "FeedbackReport" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contact" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "contextJson" JSONB,
    "adminNote" TEXT,
    "handledBy" INTEGER,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientErrorLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "level" TEXT NOT NULL DEFAULT 'error',
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "statusCode" INTEGER,
    "url" TEXT,
    "page" TEXT,
    "contextJson" JSONB,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientErrorLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnsupportedFormatLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "queryRecordId" INTEGER,
    "reason" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "storedFileName" TEXT NOT NULL,
    "fileExt" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "guessedSource" TEXT,
    "headerExcerpt" TEXT NOT NULL DEFAULT '',
    "errorMessage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnsupportedFormatLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeedbackReport_createdAt_idx" ON "FeedbackReport"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "FeedbackReport_userId_idx" ON "FeedbackReport"("userId");

-- CreateIndex
CREATE INDEX "FeedbackReport_status_idx" ON "FeedbackReport"("status");

-- CreateIndex
CREATE INDEX "FeedbackReport_category_idx" ON "FeedbackReport"("category");

-- CreateIndex
CREATE INDEX "ClientErrorLog_createdAt_idx" ON "ClientErrorLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "ClientErrorLog_userId_idx" ON "ClientErrorLog"("userId");

-- CreateIndex
CREATE INDEX "ClientErrorLog_fingerprint_idx" ON "ClientErrorLog"("fingerprint");

-- CreateIndex
CREATE INDEX "ClientErrorLog_statusCode_idx" ON "ClientErrorLog"("statusCode");

-- CreateIndex
CREATE INDEX "ClientErrorLog_source_idx" ON "ClientErrorLog"("source");

-- CreateIndex
CREATE INDEX "UnsupportedFormatLog_createdAt_idx" ON "UnsupportedFormatLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "UnsupportedFormatLog_fileExt_idx" ON "UnsupportedFormatLog"("fileExt");

-- CreateIndex
CREATE INDEX "UnsupportedFormatLog_reason_idx" ON "UnsupportedFormatLog"("reason");

-- CreateIndex
CREATE INDEX "UnsupportedFormatLog_status_idx" ON "UnsupportedFormatLog"("status");

-- CreateIndex
CREATE INDEX "UnsupportedFormatLog_userId_idx" ON "UnsupportedFormatLog"("userId");

-- AddForeignKey
ALTER TABLE "FeedbackReport" ADD CONSTRAINT "FeedbackReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "WechatUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackReport" ADD CONSTRAINT "FeedbackReport_handledBy_fkey" FOREIGN KEY ("handledBy") REFERENCES "WechatUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientErrorLog" ADD CONSTRAINT "ClientErrorLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "WechatUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnsupportedFormatLog" ADD CONSTRAINT "UnsupportedFormatLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "WechatUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnsupportedFormatLog" ADD CONSTRAINT "UnsupportedFormatLog_queryRecordId_fkey" FOREIGN KEY ("queryRecordId") REFERENCES "QueryRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
