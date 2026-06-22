-- AlterTable
ALTER TABLE "WechatUser" ADD COLUMN     "shareCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalQueries" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ShareRecord" (
    "id" SERIAL NOT NULL,
    "sharerId" INTEGER NOT NULL,
    "openerId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShareRecord_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ShareRecord" ADD CONSTRAINT "ShareRecord_sharerId_fkey" FOREIGN KEY ("sharerId") REFERENCES "WechatUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareRecord" ADD CONSTRAINT "ShareRecord_openerId_fkey" FOREIGN KEY ("openerId") REFERENCES "WechatUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
