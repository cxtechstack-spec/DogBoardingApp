-- AlterTable
ALTER TABLE "Client" ADD COLUMN "maxAddOnsPerDay" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "AddOn" DROP COLUMN "perDayCap";
