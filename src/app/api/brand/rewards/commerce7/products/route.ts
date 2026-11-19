import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getBrandManagementContext, getBrandContextFailure } from "@/lib/brand-auth";
import { getActiveCommerceConnection, isConnectionUsable } from "@/lib/commerce/connection-service";
import { listCommerce7Catalog, parseCommerce7CatalogQuery } from "@/lib/commerce7-brand-rewards-read";
import { RewardClaimError } from "@/lib/commerce7-reward-domain";
import { rewardErrorResponse } from "@/lib/commerce7-reward-http";

/**
 * Brand-only, read-only: the reward product picker. Pages and searches the connection's canonical synchronized catalog by title;
 * `mode=exclusive` lists only products secured to Customer Tags. Returns titles, ids and a tag count, never security metadata.
 * Eligibility is not decided here: saving and claiming re-check every product against the database.
 */
export async function GET(request: NextRequest) { return commerce7BrandProductsGetImpl(request); }
export async function commerce7BrandProductsGetImpl(request: NextRequest, overrides: { getContext?: typeof getBrandManagementContext } = {}) {
  try {
    const query = parseCommerce7CatalogQuery(request.nextUrl.searchParams);
    const context = await (overrides.getContext ?? getBrandManagementContext)();
    if (!context?.membership?.brand) { const failure = getBrandContextFailure(context); return NextResponse.json({ error: failure.error }, { status: failure.status }); }
    const brandId = context.membership.brand.id;
    const connection = await getActiveCommerceConnection(brandId, "COMMERCE7");
    if (!connection || !isConnectionUsable(connection)) throw new RewardClaimError("CONNECTION_UNAVAILABLE", "Connect Commerce7 before configuring rewards.");
    return NextResponse.json(await listCommerce7Catalog(prisma, brandId, connection.id, query));
  } catch (error) { return rewardErrorResponse(error); }
}
