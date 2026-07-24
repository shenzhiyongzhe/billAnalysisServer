-- AlterTable
ALTER TABLE "DailyStatistics" DROP COLUMN "todayRecharges",
DROP COLUMN "totalRecharges",
ADD COLUMN     "todayActiveUsers" INTEGER NOT NULL DEFAULT 0;
