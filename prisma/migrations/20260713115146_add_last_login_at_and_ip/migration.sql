-- AlterTable
ALTER TABLE "WechatUser" ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "lastLoginIp" VARCHAR(45);
