import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getBrandManagementContext, getBrandContextFailure } from "@/lib/brand-auth";
import { countCommerce7Claims, listCommerce7Claims, parseCommerce7ClaimQuery, serializeCommerce7BrandClaims } from "@/lib/commerce7-brand-rewards-read";
import { rewardErrorResponse } from "@/lib/commerce7-reward-http";

/**
 * Brand-only, read-only: one page of this Brand's Commerce7 claims. `status` is ALL (claims needing action first), NEEDS_ACTION
 * or one claim status; `cursor` continues the previous page. The Brand comes from the session, never from the request.
 */
export async function GET(request: NextRequest) { return commerce7BrandClaimsGetImpl(request); }
export async function commerce7BrandClaimsGetImpl(request: NextRequest, overrides: { getContext?: typeof getBrandManagementContext } = {}) {
  try {
    const query = parseCommerce7ClaimQuery(request.nextUrl.searchParams);
    const context = await (overrides.getContext ?? getBrandManagementContext)();
    if (!context?.membership?.brand) { const failure = getBrandContextFailure(context); return NextResponse.json({ error: failure.error }, { status: failure.status }); }
    const brandId = context.membership.brand.id;
    const [page, counts] = await Promise.all([listCommerce7Claims(prisma, brandId, query), countCommerce7Claims(prisma, brandId)]);
    return NextResponse.json({ claims: await serializeCommerce7BrandClaims(prisma, brandId, page.claims), claimsPage: { filter: query.filter, nextCursor: page.nextCursor, ...counts } });
  } catch (error) { return rewardErrorResponse(error); }
}
