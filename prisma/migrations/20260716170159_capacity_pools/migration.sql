-- CreateTable
CREATE TABLE "CapacityPool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "totalCapacity" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CapacityPool_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Backfill: give each existing service its own dedicated pool, preserving today's
-- per-service capacity numbers exactly. No capacity sharing is introduced by this
-- migration — clients keep separate pools until someone consolidates them in settings.
INSERT INTO "CapacityPool" ("id", "clientId", "name", "totalCapacity", "createdAt", "updatedAt")
SELECT 'pool_' || "id", "clientId", "serviceType" || ' Pool', "capacity", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "ServiceSettings";

-- AlterTable
ALTER TABLE "ServiceSettings" ADD COLUMN "capacityPoolId" TEXT;

UPDATE "ServiceSettings" SET "capacityPoolId" = 'pool_' || "id";

-- RedefineTable: enforce NOT NULL + FK on capacityPoolId and drop the old "capacity" column
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ServiceSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "billingUnit" TEXT NOT NULL,
    "baseRate" REAL NOT NULL,
    "capacityPoolId" TEXT NOT NULL,
    "activeDays" TEXT NOT NULL,
    "depositType" TEXT NOT NULL,
    "depositValue" REAL NOT NULL,
    "depositTiming" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ServiceSettings_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ServiceSettings_capacityPoolId_fkey" FOREIGN KEY ("capacityPoolId") REFERENCES "CapacityPool" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ServiceSettings" ("id","clientId","serviceType","billingUnit","baseRate","capacityPoolId","activeDays","depositType","depositValue","depositTiming","createdAt","updatedAt")
SELECT "id","clientId","serviceType","billingUnit","baseRate","capacityPoolId","activeDays","depositType","depositValue","depositTiming","createdAt","updatedAt" FROM "ServiceSettings";
DROP TABLE "ServiceSettings";
ALTER TABLE "new_ServiceSettings" RENAME TO "ServiceSettings";
CREATE UNIQUE INDEX "ServiceSettings_clientId_serviceType_key" ON "ServiceSettings"("clientId", "serviceType");
PRAGMA foreign_keys=ON;
