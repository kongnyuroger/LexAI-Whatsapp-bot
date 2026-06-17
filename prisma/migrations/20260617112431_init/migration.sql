-- CreateEnum
CREATE TYPE "ConversationState" AS ENUM ('IDLE', 'AWAITING_DOCUMENT', 'PROCESSING', 'ANALYZED', 'CHATTING');

-- CreateTable
CREATE TABLE "WhatsappUser" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "lexaiUserId" TEXT,
    "lexaiAccessToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "whatsappUserId" TEXT NOT NULL,
    "activeDocumentId" TEXT,
    "state" "ConversationState" NOT NULL DEFAULT 'IDLE',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappUser_phoneNumber_key" ON "WhatsappUser"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_whatsappUserId_key" ON "Conversation"("whatsappUserId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_whatsappUserId_fkey" FOREIGN KEY ("whatsappUserId") REFERENCES "WhatsappUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
