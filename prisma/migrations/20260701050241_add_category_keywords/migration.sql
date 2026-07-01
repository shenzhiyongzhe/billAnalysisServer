-- CreateTable
CREATE TABLE "GlobalCategoryKeyword" (
    "id" SERIAL NOT NULL,
    "category" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalCategoryKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCustomCategory" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "counterparty" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCustomCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GlobalCategoryKeyword_keyword_key" ON "GlobalCategoryKeyword"("keyword");

-- CreateIndex
CREATE UNIQUE INDEX "UserCustomCategory_userId_counterparty_key" ON "UserCustomCategory"("userId", "counterparty");

-- AddForeignKey
ALTER TABLE "UserCustomCategory" ADD CONSTRAINT "UserCustomCategory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "WechatUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
