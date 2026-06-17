-- AlterTable
ALTER TABLE "WhatsappUser" ADD COLUMN     "lexaiAccessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "lexaiRefreshToken" TEXT;
