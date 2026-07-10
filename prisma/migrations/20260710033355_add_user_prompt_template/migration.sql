-- CreateTable
CREATE TABLE "UserPromptTemplate" (
    "userId" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPromptTemplate_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "UserPromptTemplate" ADD CONSTRAINT "UserPromptTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "WechatUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
