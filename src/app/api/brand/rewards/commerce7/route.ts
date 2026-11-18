import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getBrandManagementContext, getBrandContextFailure } from "@/lib/brand-auth";
import { getActiveCommerceConnection, isConnectionUsable } from "@/lib/commerce/connection-service";
import { COMMERCE7_EDIT_SAFE_CLAIM, COMMERCE7_REWARD_CAPABILITIES, commerce7OfferEligibility, commerce7ExclusiveAccessStatus, commerce7ExclusiveSecurity, commerce7OfferEditable, commerce7RewardReadiness, frozenExclusiveAccess, serializeBrandCommerce7Config } from "@/lib/commerce7-reward-domain";
import { getCommerce7AppConfig } from "@/lib/commerce/providers/commerce7";
import { COMMERCE7_CATALOG_PAGE_SIZE, countCommerce7Claims, countCommerce7SecurityUnknown, listCommerce7Catalog, listCommerce7Claims, listCommerce7Offers, parseCommerce7ClaimQuery, parseCommerce7OfferQuery, referencedCommerce7Products, serializeCommerce7BrandClaims, sharedCommerce7ExclusiveProducts } from "@/lib/commerce7-brand-rewards-read";
import { rewardErrorResponse } from "@/lib/commerce7-reward-http";
export async function GET(request?: NextRequest) { return commerce7BrandRewardsGetImpl(request); }
export async function commerce7BrandRewardsGetImpl(request?: NextRequest, overrides: { getContext?: typeof getBrandManagementContext } = {}) {
  try {
    const claimQuery = parseCommerce7ClaimQuery(request?.nextUrl.searchParams ?? null, { status: "claimsStatus", cursor: "claimsCursor", limit: "claimsLimit" });
    const offerQuery = parseCommerce7OfferQuery(request?.nextUrl.searchParams ?? null);
    const context = await (overrides.getContext ?? getBrandManagementContext)();
    if (!context?.membership?.brand) { const failure = getBrandContextFailure(context); return NextResponse.json({ error: failure.error }, { status: failure.status }); }
    const brandId = context.membership.brand.id;
    const [commerce7, shopify] = await Promise.all([getActiveCommerceConnection(brandId, "COMMERCE7"), getActiveCommerceConnection(brandId, "SHOPIFY")]);
    const firstPage = { q: "", cursor: null, limit: COMMERCE7_CATALOG_PAGE_SIZE };
    const [offersPage, claimsPage, claimCounts, allPage, exclusivePage, securityUnknownCount, counts, safeClaims] = await Promise.all([
      // Offers page independently of claims and the catalog: `offersCursor` continues the list.
      listCommerce7Offers(prisma, brandId, offerQuery),
      listCommerce7Claims(prisma, brandId, claimQuery),
      countCommerce7Claims(prisma, brandId),
      // The pickers start from the first catalog page; further pages and searches come from the products endpoint.
      commerce7 ? listCommerce7Catalog(prisma, brandId, commerce7.id, { ...firstPage, exclusiveOnly: false }) : { products: [], nextCursor: null },
      commerce7 ? listCommerce7Catalog(prisma, brandId, commerce7.id, { ...firstPage, exclusiveOnly: true }) : { products: [], nextCursor: null },
      // Products whose Product Security has never been read (a catalog list may omit it): a count only, so the picker can say
      // "sync products" instead of "no eligible products". Counted in the database over every product, not over a page.
      commerce7 ? countCommerce7SecurityUnknown(prisma, brandId, commerce7.id) : 0,
      prisma.commerceRewardRedemption.groupBy({ by: ["offerId", "slotReleased", "entitlementEverGranted"], where: { brandId, provider: "COMMERCE7" }, _count: { _all: true } }),
      prisma.commerceRewardRedemption.groupBy({ by: ["offerId"], where: { brandId, provider: "COMMERCE7", ...COMMERCE7_EDIT_SAFE_CLAIM }, _count: { _all: true } }),
    ]);
    const offers = offersPage.offers;
    // Security metadata stays on the server: the browser gets titles and IDs, and only an eligibility verdict per offer.
    const tagsOf = (metadata: unknown) => commerce7ExclusiveSecurity(metadata)?.tagIds ?? [];
    // Products the offers already reference are resolved by direct id lookup, whatever their position in the catalog.
    const referenced = await referencedCommerce7Products(prisma, brandId, [...new Set([...(commerce7 ? [commerce7.id] : []), ...offers.map((offer) => offer.connectionId).filter((id): id is string => !!id)])], [...new Set(offers.flatMap((offer) => offer.products.map((row) => row.externalProductId)))]);
    const referencedProducts = [...new Map(referenced.map((row) => [row.externalId, { externalId: row.externalId, title: row.title }])).values()];
    // Only an available product of the CURRENT connection counts as the offer's product, exactly as before.
    const offerProduct = (offer: { products: { externalProductId: string }[] }) => referenced.find((row) => commerce7 && row.connectionId === commerce7.id && row.isAvailable && row.externalId === offer.products[0]?.externalProductId) ?? null;
    // Other synchronized products secured by the same tag: granting it may unlock them too (counted over the whole catalog).
    const sharedCounts = new Map<string, number>();
    if (commerce7) await Promise.all(offers.filter((offer) => offer.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS").map(async (offer) => { const frozen = frozenExclusiveAccess(offer.commerce7Config); if (frozen) sharedCounts.set(offer.id, (await sharedCommerce7ExclusiveProducts(prisma, brandId, commerce7.id, frozen.tagId, frozen.productId)).length); }));
    const exclusiveDetails = (offer: { id: string; rewardMode: string; commerce7Config: unknown; products: { externalProductId: string }[] }) => {
      if (offer.rewardMode !== "EXCLUSIVE_PRODUCT_ACCESS") return { exclusiveAccessStatus: null };
      const product = offerProduct(offer);
      return {
        exclusiveAccessStatus: commerce7ExclusiveAccessStatus(offer.commerce7Config, product),
        exclusiveTagCount: product ? tagsOf(product.providerMetadata).length : 0,
        exclusiveSharedProductCount: sharedCounts.get(offer.id) ?? 0,
      };
    };
    const products = allPage.products; const exclusiveProducts = exclusivePage.products;
    return NextResponse.json({ providers: { SHOPIFY: !!shopify && isConnectionUsable(shopify), COMMERCE7: !!commerce7 && isConnectionUsable(commerce7) }, connection: commerce7 ? { id: commerce7.id, displayName: commerce7.displayName, currencyCode: commerce7.currencyCode, status: commerce7.status } : null, capabilities: COMMERCE7_REWARD_CAPABILITIES,
      readiness: commerce7RewardReadiness(!!getCommerce7AppConfig()),
      offers: offers.map((offer) => ({ ...offer, commerce7Config: serializeBrandCommerce7Config(offer.commerce7Config, offer.rewardMode), ...exclusiveDetails(offer),
        // Stored Active/Inactive (isActive) and current claim eligibility are reported separately; neither changes the other.
        eligibility: commerce7OfferEligibility(offer, { productIds: offer.products.map((row) => row.externalProductId), exclusiveProduct: offer.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS" ? offerProduct(offer) : null }), editable: commerce7OfferEditable(offer.reservedClaimCount, offer._count.redemptions, safeClaims.find((row) => row.offerId === offer.id)?._count._all ?? 0), totalClaims: offer.reservedClaimCount, issuedCount: counts.filter((count) => count.offerId === offer.id && count.entitlementEverGranted).reduce((sum, count) => sum + count._count._all, 0) })),
      offersPage: { nextCursor: offersPage.nextCursor, totalCount: offersPage.totalCount },
      claims: await serializeCommerce7BrandClaims(prisma, brandId, claimsPage.claims), claimsPage: { filter: claimQuery.filter, nextCursor: claimsPage.nextCursor, ...claimCounts },
      products, referencedProducts, productsPage: { nextCursor: allPage.nextCursor, exclusiveNextCursor: exclusivePage.nextCursor }, exclusiveProducts, exclusiveDiagnostics: { securityUnknownCount, lastProductSyncAt: commerce7?.lastProductSyncAt ?? null } });
  } catch (error) { return rewardErrorResponse(error); }
}
