import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { realAuthResolvers, type AuthResolvers } from "@/lib/auth-session";
import { assertExpectedBrand } from "@/lib/brand-auth";
import { resolveBrandAdmin } from "@/lib/brand-qr-route";
import { setCodeRedemptionStopped } from "@/lib/qr-redemption-stop";

/** Stops new redemptions of one NEW code. A redeemed code cannot be changed. */
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  return stopCodeRedemptionImpl(request, context, realAuthResolvers);
}

export async function stopCodeRedemptionImpl(request: NextRequest, { params }: Context, deps: AuthResolvers) {
  try {
    const guard = await resolveBrandAdmin(deps);
    if (!guard.ok) return guard.response;
    const mismatch = assertExpectedBrand(request, guard.brand);
    if (mismatch) return NextResponse.json(mismatch, { status: mismatch.status });
    const { id } = await params;
    const result = await setCodeRedemptionStopped(prisma, { codeId: id, brandId: guard.brandId, stopped: true });
    if (!result.ok) {
      if (result.reason === "NOT_FOUND") return NextResponse.json({ error: "QR code not found." }, { status: 404 });
      return NextResponse.json({ error: "This code was already redeemed; its redemption cannot be stopped.", code: "QR_ALREADY_USED" }, { status: 409 });
    }
    return NextResponse.json({ data: { id, redemptionStoppedAt: result.stoppedAt } });
  } catch (error) {
    console.error("[brand/qr-codes][stop-redemption] Error:", error);
    return NextResponse.json({ error: "Failed to update the code." }, { status: 500 });
  }
}
