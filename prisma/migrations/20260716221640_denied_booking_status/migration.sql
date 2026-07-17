-- AlterTable
-- BookingStatus.DENIED needs no SQL change (SQLite enums are unconstrained TEXT).
ALTER TABLE "Booking" ADD COLUMN "denialReason" TEXT;
