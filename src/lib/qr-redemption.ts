import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";

type RedemptionDbClient = Prisma.TransactionClient | typeof prisma;

export async function redeemQrCodeForUser(options: {
  qrCodeId?: string | null;
  userId: string;
  userEmail?: string | null;
  db?: RedemptionDbClient;
  /**
   * Set only by the sign-in transfer of an anonymous unlock that already exists.
   * Every surviving anonymous unlock was created before any stop or under the
   * code's row lock while it was not stopped, so it is honoured even if the code
   * was stopped afterwards. Never set it for a fresh scan.
   */
  honorExistingAnonymousUnlock?: boolean;
}) {
  const { qrCodeId, userId, userEmail } = options;

  if (!qrCodeId) {
    return {
      redeemed: false,
      alreadyRedeemed: false,
      alreadyRedeemedByViewer: false,
      stopped: false,
    };
  }

  const db = options.db || prisma;
  const usedAt = new Date();

  const result = await db.qRCode.updateMany({
    where: {
      id: qrCodeId,
      status: "NEW",
      ...(options.honorExistingAnonymousUnlock ? {} : { redemptionStoppedAt: null }),
    },
    data: {
      status: "USED",
      redeemedById: userId,
      email: userEmail || undefined,
      usedAt,
    },
  });

  if (result.count > 0) {
    return {
      redeemed: true,
      alreadyRedeemed: false,
      alreadyRedeemedByViewer: false,
      stopped: false,
    };
  }

  const existing = await db.qRCode.findUnique({
    where: { id: qrCodeId },
    select: {
      redeemedById: true,
      status: true,
      redemptionStoppedAt: true,
    },
  });

  const alreadyRedeemed = existing?.status === "USED";
  const alreadyRedeemedByViewer = existing?.redeemedById === userId;

  return {
    redeemed: alreadyRedeemedByViewer,
    alreadyRedeemed,
    alreadyRedeemedByViewer,
    stopped: existing?.status === "NEW" && existing.redemptionStoppedAt !== null,
  };
}
