import type { PrismaClient } from "@prisma/client";

const MAX_ATTEMPTS = 3;

/** The question limit counts per UTC day, for both submission and "remaining today". */
export function utcDayRange(now: Date = new Date()) {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  return { dayStart, dayEnd };
}

function isSerializationFailure(error: unknown) {
  const err = error as { code?: unknown; message?: unknown; meta?: unknown } | null;
  if (err?.code === "P2034") return true;
  // The pg driver adapter can report the raw SQLSTATE (40001) instead.
  const text = `${String(err?.message ?? "")} ${JSON.stringify(err?.meta ?? {})}`;
  return /40001|could not serialize access|TransactionWriteConflict/i.test(text);
}

export type SubmitQuestionResult =
  | { ok: true; question: { id: string; body: string; status: string; createdAt: Date }; remainingToday: number }
  | { ok: false; reason: "LIMIT_REACHED" | "BUSY" };

/**
 * Counts today's questions and creates the new one in a single serializable
 * transaction, so concurrent submissions cannot exceed `dailyLimit`. A
 * serialization failure means another submission won; the count is re-read
 * (up to three attempts) and the loser then sees the limit.
 */
export async function submitQuestionWithinLimit(
  db: PrismaClient,
  input: { experienceId: string; userId: string; body: string; dailyLimit: number; now?: Date },
): Promise<SubmitQuestionResult> {
  const { dayStart, dayEnd } = utcDayRange(input.now);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          const used = await tx.question.count({
            where: {
              experienceId: input.experienceId,
              askedById: input.userId,
              createdAt: { gte: dayStart, lt: dayEnd },
            },
          });
          if (used >= input.dailyLimit) return { ok: false as const, reason: "LIMIT_REACHED" as const };

          const question = await tx.question.create({
            data: { experienceId: input.experienceId, askedById: input.userId, body: input.body },
            select: { id: true, body: true, status: true, createdAt: true },
          });
          return { ok: true as const, question, remainingToday: Math.max(0, input.dailyLimit - used - 1) };
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
    }
  }
  // Still conflicting after three attempts: ask the caller to try again rather than guess.
  return { ok: false, reason: "BUSY" };
}
