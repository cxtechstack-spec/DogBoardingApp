-- AlterTable
ALTER TABLE "CapacityPool" ADD COLUMN     "fallbackPoolId" TEXT;

-- AddForeignKey
ALTER TABLE "CapacityPool" ADD CONSTRAINT "CapacityPool_fallbackPoolId_fkey" FOREIGN KEY ("fallbackPoolId") REFERENCES "CapacityPool"("id") ON DELETE SET NULL ON UPDATE CASCADE;
