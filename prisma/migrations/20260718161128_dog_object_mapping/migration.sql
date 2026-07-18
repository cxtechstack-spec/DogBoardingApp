-- AlterTable
ALTER TABLE "Client" ADD COLUMN "dogObjectKey" TEXT,
ADD COLUMN "dogNameFieldKey" TEXT,
ADD COLUMN "dogBreedFieldKey" TEXT,
ADD COLUMN "dogNotesFieldKey" TEXT,
ADD COLUMN "dogVaccineFieldKeys" TEXT NOT NULL DEFAULT '[]';
