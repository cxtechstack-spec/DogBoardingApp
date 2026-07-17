-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "capacityPoolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Unit_capacityPoolId_fkey" FOREIGN KEY ("capacityPoolId") REFERENCES "CapacityPool" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTable: replace free-text "assignedUnit" with a real "unitId" FK.
-- Pre-launch test data only — no real bookings to preserve unit assignments for.
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Booking" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "ghlDogObjectId" TEXT NOT NULL,
    "ghlOwnerContactId" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME NOT NULL,
    "unitId" TEXT,
    "addOnsSelected" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "lockedRate" REAL NOT NULL,
    "ghlInvoiceId" TEXT,
    "vaccineCheckBooking" TEXT,
    "vaccineCheckDropoff" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "denialReason" TEXT,
    "ghlRemainderInvoiceId" TEXT,
    CONSTRAINT "Booking_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Booking_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Booking" ("id","clientId","ghlDogObjectId","ghlOwnerContactId","serviceType","startDate","endDate","addOnsSelected","status","lockedRate","ghlInvoiceId","vaccineCheckBooking","vaccineCheckDropoff","createdAt","updatedAt","denialReason","ghlRemainderInvoiceId")
SELECT "id","clientId","ghlDogObjectId","ghlOwnerContactId","serviceType","startDate","endDate","addOnsSelected","status","lockedRate","ghlInvoiceId","vaccineCheckBooking","vaccineCheckDropoff","createdAt","updatedAt","denialReason","ghlRemainderInvoiceId" FROM "Booking";
DROP TABLE "Booking";
ALTER TABLE "new_Booking" RENAME TO "Booking";
PRAGMA foreign_keys=ON;
