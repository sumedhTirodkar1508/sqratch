import type { Prisma, PrismaClient } from "@prisma/client";
import { lockQrBatch, lockQrCodes } from "@/lib/qr-lifecycle";

/**
 * Stopping redemptions is separate from archiving (list visibility) and from
 * deletion (unused codes only). It only blocks NEW redemptions: USED codes,
 * existing unlocks, ledger rows, attribution and printed links are never
 * touched. State lives on the code row, so a scan (which locks that row) and a
 * stop are strictly ordered by PostgreSQL's row lock.
 */
export type StopResult = { batchId: string; stoppedAt: Date | null; codesAffected: number };

type Scope = { batchId: string; brandId: string };

async function loadBatch(tx: Prisma.TransactionClient, { batchId, brandId }: Scope) {
  const owned = await tx.qRCodeBatch.findFirst({ where: { id: batchId, campaign: { brandId } }, select: { id: true } });
  if (!owned) return null;
  await lockQrBatch(tx, batchId);
  return tx.qRCodeBatch.findUnique({ where: { id: batchId }, select: { id: true, redemptionStoppedAt: true } });
}

export async function stopBatchRedemptions(
  db: PrismaClient,
  { batchId, brandId, userId, now = new Date() }: Scope & { userId: string; now?: Date },
): Promise<StopResult | null> {
  return db.$transaction(async (tx) => {
    const batch = await loadBatch(tx, { batchId, brandId });
    if (!batch) return null;
    // Already stopped: nothing to do. In particular a code the brand resumed on its
    // own is not silently stopped again by a repeated request.
    if (batch.redemptionStoppedAt) return { batchId: batch.id, stoppedAt: batch.redemptionStoppedAt, codesAffected: 0 };
    const stoppedAt = now;
    await tx.qRCodeBatch.update({
      where: { id: batch.id },
      data: { redemptionStoppedAt: stoppedAt, redemptionStoppedById: userId },
    });
    // Only NEW, not-yet-stopped codes: a code stopped on its own keeps its own
    // timestamp, and USED codes are never modified. Rows already locked by a
    // concurrent redemption are re-checked after it commits.
    const result = await tx.qRCode.updateMany({
      where: { batchId: batch.id, status: "NEW", redemptionStoppedAt: null },
      data: { redemptionStoppedAt: stoppedAt },
    });
    return { batchId: batch.id, stoppedAt, codesAffected: result.count };
  });
}

export async function resumeBatchRedemptions(
  db: PrismaClient,
  { batchId, brandId }: Scope,
): Promise<StopResult | null> {
  return db.$transaction(async (tx) => {
    const batch = await loadBatch(tx, { batchId, brandId });
    if (!batch) return null;
    let codesAffected = 0;
    if (batch.redemptionStoppedAt) {
      // Only codes stopped BY this batch stop; an individually stopped code has
      // its own timestamp and stays stopped.
      const result = await tx.qRCode.updateMany({
        where: { batchId: batch.id, redemptionStoppedAt: batch.redemptionStoppedAt },
        data: { redemptionStoppedAt: null },
      });
      codesAffected = result.count;
      await tx.qRCodeBatch.update({
        where: { id: batch.id },
        data: { redemptionStoppedAt: null, redemptionStoppedById: null },
      });
    }
    return { batchId: batch.id, stoppedAt: null, codesAffected };
  });
}

export type CodeStopOutcome =
  | { ok: true; stoppedAt: Date | null }
  | { ok: false; reason: "NOT_FOUND" | "USED" | "NO_CHANGE" };

/** Stops (or resumes) one NEW code. A USED code can never be stopped. */
export async function setCodeRedemptionStopped(
  db: PrismaClient,
  { codeId, brandId, stopped, now = new Date() }: { codeId: string; brandId: string; stopped: boolean; now?: Date },
): Promise<CodeStopOutcome> {
  return db.$transaction(async (tx) => {
    await lockQrCodes(tx, [codeId]);
    const code = await tx.qRCode.findFirst({
      where: { id: codeId, campaign: { brandId } },
      select: { status: true, redemptionStoppedAt: true, batch: { select: { redemptionStoppedAt: true } } },
    });
    if (!code) return { ok: false as const, reason: "NOT_FOUND" as const };
    if (code.status !== "NEW") return { ok: false as const, reason: "USED" as const };
    if (stopped && code.redemptionStoppedAt) {
      // Already stopped. If it carries its batch's own stamp, give it its own, so a later
      // batch resume does not silently undo this deliberate stop.
      const batchStamp = code.batch?.redemptionStoppedAt;
      if (batchStamp && batchStamp.getTime() === code.redemptionStoppedAt.getTime()) {
        await tx.qRCode.update({ where: { id: codeId }, data: { redemptionStoppedAt: now } });
        return { ok: true as const, stoppedAt: now };
      }
      return { ok: true as const, stoppedAt: code.redemptionStoppedAt };
    }
    if (!stopped && !code.redemptionStoppedAt) return { ok: true as const, stoppedAt: null };
    const stoppedAt = stopped ? now : null;
    await tx.qRCode.update({ where: { id: codeId }, data: { redemptionStoppedAt: stoppedAt } });
    return { ok: true as const, stoppedAt };
  });
}
