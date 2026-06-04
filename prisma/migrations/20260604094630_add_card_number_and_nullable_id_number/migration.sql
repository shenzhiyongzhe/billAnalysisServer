-- AlterTable
ALTER TABLE "StatementUser" ADD COLUMN     "cardNumber" TEXT,
ALTER COLUMN "idNumber" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "StatementUser_cardNumber_key" ON "StatementUser"("cardNumber");
