-- AlterTable
ALTER TABLE "WechatUser" ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "nickname" SET DEFAULT '微信用户';
