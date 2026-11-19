import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { realAuthResolvers, type AuthResolvers } from "@/lib/auth-session";
import { assertExpectedBrand } from "@/lib/brand-auth";
import { resolveBrandAdmin } from "@/lib/brand-qr-route";
import { stopBatchRedemptions } from "@/lib/qr-redemption-stop";

/**
 * Stops NEW redemptions for this batch. Existing unlocks, points, USED codes and
 * printed links are untouched, and archiving is unrelated. Repeating is a no-op.
 */
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  return stopBatchRedemptionsImpl(request, context, realAuthResolvers);
}

export async function stopBatchRedemptionsImpl(request: NextRequest, { params }: Context, deps: AuthResolvers) {
  try {
    const guard = await resolveBrandAdmin(deps);
    if (!guard.ok) return guard.response;
    const mismatch = assertExpectedBrand(request, guard.brand);
    if (mismatch) return NextResponse.json(mismatch, { status: mismatch.status });
    const { id } = await params;
    const result = await stopBatchRedemptions(prisma, { batchId: id, brandId: guard.brandId, userId: guard.userId });
    if (!result) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    return NextResponse.json({ data: result });
  } catch (error) {
    console.error("[brand/qr-batches][stop-redemptions] Error:", error);
    return NextResponse.json({ error: "Failed to stop redemptions." }, { status: 500 });
  }
}
