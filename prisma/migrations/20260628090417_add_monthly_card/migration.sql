-- AlterTable
ALTER TABLE "QueryOperationRecord" ADD COLUMN     "operationType" TEXT NOT NULL DEFAULT 'queries';

-- AlterTable
ALTER TABLE "WechatUser" ADD COLUMN     "monthlyCardExpiry" TIMESTAMP(3);
