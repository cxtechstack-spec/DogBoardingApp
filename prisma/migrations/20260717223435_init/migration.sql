-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('BOARDING', 'DAY_CARE', 'DAY_TRAINING');

-- CreateEnum
CREATE TYPE "BillingUnit" AS ENUM ('DAY', 'NIGHT');

-- CreateEnum
CREATE TYPE "DepositType" AS ENUM ('NONE', 'PERCENT', 'FLAT');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'ACTIVE', 'COMPLETED', 'DENIED');

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "ghlLocationId" TEXT NOT NULL,
    "maxAddOnsPerDay" INTEGER NOT NULL DEFAULT 1,
    "ghlApiTokenEncrypted" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapacityPool" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "totalCapacity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapacityPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL,
    "capacityPoolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceSettings" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "billingUnit" "BillingUnit" NOT NULL,
    "baseRate" DOUBLE PRECISION NOT NULL,
    "capacityPoolId" TEXT NOT NULL,
    "activeDays" TEXT NOT NULL,
    "depositType" "DepositType" NOT NULL,
    "depositValue" DOUBLE PRECISION NOT NULL,
    "depositTiming" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AddOn" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AddOn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "ghlDogObjectId" TEXT NOT NULL,
    "ghlOwnerContactId" TEXT NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "unitId" TEXT,
    "addOnsSelected" TEXT NOT NULL DEFAULT '[]',
    "status" "BookingStatus" NOT NULL DEFAULT 'REQUESTED',
    "denialReason" TEXT,
    "lockedRate" DOUBLE PRECISION NOT NULL,
    "ghlInvoiceId" TEXT,
    "ghlRemainderInvoiceId" TEXT,
    "vaccineCheckBooking" TEXT,
    "vaccineCheckDropoff" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_ghlLocationId_key" ON "Client"("ghlLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceSettings_clientId_serviceType_key" ON "ServiceSettings"("clientId", "serviceType");

-- AddForeignKey
ALTER TABLE "CapacityPool" ADD CONSTRAINT "CapacityPool_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_capacityPoolId_fkey" FOREIGN KEY ("capacityPoolId") REFERENCES "CapacityPool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceSettings" ADD CONSTRAINT "ServiceSettings_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceSettings" ADD CONSTRAINT "ServiceSettings_capacityPoolId_fkey" FOREIGN KEY ("capacityPoolId") REFERENCES "CapacityPool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AddOn" ADD CONSTRAINT "AddOn_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

