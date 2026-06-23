-- CreateTable
CREATE TABLE "QueryOperationRecord" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "adminId" INTEGER,
    "oldQueries" INTEGER NOT NULL,
    "newQueries" INTEGER NOT NULL,
    "changeAmount" INTEGER NOT NULL,
    "reason" TEXT DEFAULT '管理员修改',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueryOperationRecord_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "QueryOperationRecord" ADD CONSTRAINT "QueryOperationRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "WechatUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueryOperationRecord" ADD CONSTRAINT "QueryOperationRecord_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "WechatUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
