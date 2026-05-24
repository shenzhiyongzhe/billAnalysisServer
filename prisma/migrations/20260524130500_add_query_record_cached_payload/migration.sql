-- AlterTable
ALTER TABLE "QueryRecord"
ADD COLUMN "summaryJson" JSONB,
ADD COLUMN "transactionsJson" JSONB,
ADD COLUMN "startDate" TIMESTAMP(3),
ADD COLUMN "endDate" TIMESTAMP(3);
