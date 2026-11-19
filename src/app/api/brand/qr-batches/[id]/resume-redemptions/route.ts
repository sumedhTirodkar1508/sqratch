import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { realAuthResolvers, type AuthResolvers } from "@/lib/auth-session";
import { assertExpectedBrand } from "@/lib/brand-auth";
import { resolveBrandAdmin } from "@/lib/brand-qr-route";
import { resumeBatchRedemptions } from "@/lib/qr-redemption-stop";

/** Resumes only the codes this batch stopped; individually stopped codes stay stopped. */
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  return resumeBatchRedemptionsImpl(request, context, realAuthResolvers);
}

export async function resumeBatchRedemptionsImpl(request: NextRequest, { params }: Context, deps: AuthResolvers) {
  try {
    const guard = await resolveBrandAdmin(deps);
    if (!guard.ok) return guard.response;
    const mismatch = assertExpectedBrand(request, guard.brand);
    if (mismatch) return NextResponse.json(mismatch, { status: mismatch.status });
    const { id } = await params;
    const result = await resumeBatchRedemptions(prisma, { batchId: id, brandId: guard.brandId });
    if (!result) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    return NextResponse.json({ data: result });
  } catch (error) {
    console.error("[brand/qr-batches][resume-redemptions] Error:", error);
    return NextResponse.json({ error: "Failed to resume redemptions." }, { status: 500 });
  }
}
