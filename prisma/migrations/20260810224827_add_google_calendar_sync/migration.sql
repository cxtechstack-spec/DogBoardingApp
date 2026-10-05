-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "googleEventId" TEXT;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "googleAccessTokenEncrypted" TEXT,
ADD COLUMN     "googleCalendarEmail" TEXT,
ADD COLUMN     "googleRefreshTokenEncrypted" TEXT,
ADD COLUMN     "googleTokenExpiry" TIMESTAMP(3),
ADD COLUMN     "timeZone" TEXT;
