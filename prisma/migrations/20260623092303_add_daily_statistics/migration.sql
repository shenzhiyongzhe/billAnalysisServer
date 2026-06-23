-- CreateTable
CREATE TABLE "DailyStatistics" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "todayQueries" INTEGER NOT NULL DEFAULT 0,
    "todayRecharges" INTEGER NOT NULL DEFAULT 0,
    "totalQueries" INTEGER NOT NULL DEFAULT 0,
    "totalRecharges" INTEGER NOT NULL DEFAULT 0,
    "avgQueriesPerDay" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyStatistics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyStatistics_date_key" ON "DailyStatistics"("date");
