-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "stripeCustomerId" TEXT;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "balanceAutoChargeWebhookUrl" TEXT;
