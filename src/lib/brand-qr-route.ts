import { NextRequest, NextResponse } from "next/server";
import { type AuthResolvers } from "@/lib/auth-session";
import { getBrandContextFailure } from "@/lib/brand-auth";

/**
 * Shared first steps for brand QR mutations: signed in and a brand admin. The
 * route itself then calls `assertExpectedBrand` (so the stale-tab check is
 * visible at every mutation) and uses the returned brand and acting user.
 */
export async function resolveBrandAdmin(deps: AuthResolvers) {
  if (!(await deps.resolveSession())) {
    return { ok: false as const, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const brand = await deps.resolveBrandAdminContext();
  if (!brand?.membership?.brand) {
    const failure = getBrandContextFailure(brand);
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      ),
    };
  }
  return { ok: true as const, brand, brandId: brand.membership.brand.id, userId: brand.userId };
}

export type { NextRequest };
