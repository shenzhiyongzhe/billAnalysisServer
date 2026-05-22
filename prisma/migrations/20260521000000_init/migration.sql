-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "WechatUser" (
    "id" SERIAL NOT NULL,
    "openid" TEXT NOT NULL,
    "displayId" TEXT NOT NULL,
    "nickname" TEXT NOT NULL DEFAULT '寰俊鐢ㄦ埛',
    "avatar" TEXT NOT NULL DEFAULT '/static/default-avatar.png',
    "remainingQueries" INTEGER NOT NULL DEFAULT 6,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WechatUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementUser" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "idNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueryRecord" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "statementUserId" INTEGER,
    "filePath" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueryRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WechatUser_openid_key" ON "WechatUser"("openid");

-- CreateIndex
CREATE UNIQUE INDEX "WechatUser_displayId_key" ON "WechatUser"("displayId");

-- AddForeignKey
ALTER TABLE "QueryRecord" ADD CONSTRAINT "QueryRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "WechatUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueryRecord" ADD CONSTRAINT "QueryRecord_statementUserId_fkey" FOREIGN KEY ("statementUserId") REFERENCES "StatementUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

