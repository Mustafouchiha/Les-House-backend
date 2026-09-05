-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "blocked" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "Branch_name_key" ON "Branch"("name");
