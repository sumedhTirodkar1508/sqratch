import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { deriveShopifyStorefrontUrl } from "@/lib/commerce/connection-service";

/** The customer's own redemptions are paged: newest first, never more than MAX_LIMIT rows per response. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

export async function GET(request?: NextRequest) {
  try {
    const params = request?.nextUrl.searchParams;
    const rawLimit = params?.get("limit") ?? null;
    const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
    const cursor = params?.get("cursor") ?? null;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT || (cursor !== null && (cursor.length === 0 || cursor.length > 100))) {
      return NextResponse.json({ error: `limit must be an integer between 1 and ${MAX_LIMIT}.` }, { status: 400 });
    }

    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // A cursor must be one of this customer's own redemptions; any other id is rejected, not used as a position.
    if (cursor && !(await prisma.commerceRewardRedemption.findFirst({ where: { id: cursor, userId: session.user.id }, select: { id: true } }))) {
      return NextResponse.json({ error: "Invalid cursor." }, { status: 400 });
    }

    const rows = await prisma.commerceRewardRedemption.findMany({
      where: {
        userId: session.user.id,
      },
      include: {
        brand: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
          },
        },
        offer: {
          select: {
            id: true,
            title: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const redemptions = rows.slice(0, limit);

    return NextResponse.json({
      pagination: { nextCursor: hasMore ? redemptions[redemptions.length - 1].id : null, hasMore },
      data: redemptions.map((redemption) => ({
        id: redemption.id,
        code: redemption.code,
        status: redemption.status,
        brand: redemption.brand,
        offer: redemption.offer,
        issuedAt: redemption.issuedAt,
        expiresAt: redemption.expiresAt,
        usedAt: redemption.usedAt,
        pointsCost: redemption.pointsCost,
        discountType: redemption.discountType,
        discountAmountCents: redemption.discountAmountCents,
        discountPercentageBasisPoints: redemption.discountPercentageBasisPoints,
        currencyCode: redemption.currencyCode,
        // Maintain the established Shopify endpoint contract. The fields are
        // mapped from provider-neutral persistence names above this boundary.
        shopifyDiscountStatus: redemption.externalDiscountStatus,
        shopifyAsyncUsageCount: redemption.externalUsageCount,
        shopifyLastCheckedAt: redemption.providerLastCheckedAt,
        // The redemption's OWN historical shop-domain snapshot (captured at
        // redemption time) — never the brand's current domain, which could
        // have relinked since. See src/lib/commerce/connection-service.ts's
        // deriveShopifyStorefrontUrl doc comment.
        shopUrl: deriveShopifyStorefrontUrl(redemption.externalAccountId),
      })),
    });
  } catch (error) {
    console.error("[rewards/shopify/redemptions][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load reward redemptions." },
      { status: 500 },
    );
  }
}
