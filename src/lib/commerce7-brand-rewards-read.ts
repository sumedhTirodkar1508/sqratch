import { Prisma, type PrismaClient } from "@prisma/client";
import { storedCommerce7Eligibility } from "@/lib/commerce7-reward-eligibility";
import { COMMERCE7_EXCLUSIVE_SECURITY_AVAILABLE_TO, RewardClaimError, commerce7ClaimAccessState, commerce7ExclusiveSecurity, commerce7MembershipGuidance, safeClaimDiagnostic } from "@/lib/commerce7-reward-domain";
import { claimTagTitle } from "@/lib/commerce/providers/commerce7-rewards-client";

/**
 * Read-only helpers for the Brand's Commerce7 rewards workspace. They page and count in the database so no list silently
 * stops at a fixed window. They never change a claim, offer or product.
 */
type Db = Pick<PrismaClient, "commerceRewardRedemption">;
type CatalogDb = Pick<PrismaClient, "connectedCommerceProduct">;

export const LIVE_ACCESS_STATUSES = ["POINTS_DEBITED", "ISSUED", "USED", "EXPIRED"] as const;
export const COMMERCE7_CLAIM_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const CLAIM_STATUSES = ["PENDING", "POINTS_DEBITED", "ISSUED", "USED", "EXPIRED", "FAILED", "REFUNDED", "CANCELLED"] as const;
export type Commerce7ClaimFilter = "ALL" | "NEEDS_ACTION" | (typeof CLAIM_STATUSES)[number];
/** Statuses and provisioning states that still wait for the store or the provider. */
const UNRESOLVED_STATUSES = ["PENDING", "POINTS_DEBITED"] as const;
const UNRESOLVED_STATES = ["AWAITING_ELIGIBILITY", "FAILED_RETRYABLE", "MANUAL_REVIEW"] as const;

type Phase = "A" | "B" | "S";
type ClaimCursor = { p: Phase; t: Date; i: string };
const invalid = (message: string) => new RewardClaimError("INVALID_REQUEST", message, 400);

function encodeCursor(cursor: ClaimCursor) { return Buffer.from(JSON.stringify({ p: cursor.p, t: cursor.t.toISOString(), i: cursor.i })).toString("base64url"); }
function decodeCursor(raw: string): ClaimCursor {
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { p?: unknown; t?: unknown; i?: unknown };
    const date = typeof value.t === "string" ? new Date(value.t) : null;
    if ((value.p === "A" || value.p === "B" || value.p === "S") && date && !Number.isNaN(date.getTime()) && typeof value.i === "string" && value.i.length > 0 && value.i.length <= 100) return { p: value.p, t: date, i: value.i };
  } catch { /* fall through */ }
  throw invalid("Invalid claims cursor.");
}

export function parseCommerce7ClaimQuery(params: URLSearchParams | null, names: { status: string; cursor: string; limit: string } = { status: "status", cursor: "cursor", limit: "limit" }) {
  const status = params?.get(names.status) ?? "ALL";
  if (status !== "ALL" && status !== "NEEDS_ACTION" && !(CLAIM_STATUSES as readonly string[]).includes(status)) throw invalid("Unknown claim status filter.");
  const rawLimit = params?.get(names.limit) ?? null;
  const limit = rawLimit === null ? COMMERCE7_CLAIM_PAGE_SIZE : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw invalid(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
  const rawCursor = params?.get(names.cursor) ?? null;
  return { filter: status as Commerce7ClaimFilter, limit, cursor: rawCursor ? decodeCursor(rawCursor) : null };
}

function phaseWhere(brandId: string, phase: Phase, filter: Commerce7ClaimFilter): Prisma.CommerceRewardRedemptionWhereInput {
  const base = { brandId, provider: "COMMERCE7" } as const;
  if (phase === "A") return { ...base, OR: [{ needsManualReview: true }, { status: { in: [...UNRESOLVED_STATUSES] } }, { provisioningState: { in: [...UNRESOLVED_STATES] } }] };
  // The complement is spelled out: a negated nullable column would also drop rows whose provisioningState is null.
  if (phase === "B") return { ...base, needsManualReview: false, status: { notIn: [...UNRESOLVED_STATUSES] }, OR: [{ provisioningState: null }, { provisioningState: { notIn: [...UNRESOLVED_STATES] } }] };
  return { ...base, status: filter as (typeof CLAIM_STATUSES)[number] };
}

/**
 * One page of the Brand's claims, newest first. "All" lists claims needing action first, then the rest; each group is newest
 * first and the cursor carries its own group, so a page that spans the boundary and the next page both continue exactly.
 */
export async function listCommerce7Claims(db: Db, brandId: string, query: { filter: Commerce7ClaimFilter; limit: number; cursor: ClaimCursor | null }) {
  const phases: Phase[] = query.filter === "ALL" ? ["A", "B"] : query.filter === "NEEDS_ACTION" ? ["A"] : ["S"];
  const start = query.cursor ? phases.indexOf(query.cursor.p) : 0;
  if (start < 0) throw invalid("Invalid claims cursor.");
  const rows: { row: Awaited<ReturnType<typeof fetchPhase>>[number]; phase: Phase }[] = [];
  for (let index = start; index < phases.length && rows.length <= query.limit; index += 1) {
    const batch = await fetchPhase(db, brandId, phases[index], query.filter, index === start ? query.cursor : null, query.limit + 1 - rows.length);
    rows.push(...batch.map((row) => ({ row, phase: phases[index] })));
  }
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor = rows.length > query.limit && last ? encodeCursor({ p: last.phase, t: last.row.createdAt, i: last.row.id }) : null;
  return { claims: page.map((entry) => entry.row), nextCursor };
}
function fetchPhase(db: Db, brandId: string, phase: Phase, filter: Commerce7ClaimFilter, cursor: ClaimCursor | null, take: number) {
  const after: Prisma.CommerceRewardRedemptionWhereInput = cursor ? { OR: [{ createdAt: { lt: cursor.t } }, { createdAt: cursor.t, id: { lt: cursor.i } }] } : {};
  return db.commerceRewardRedemption.findMany({ where: { AND: [phaseWhere(brandId, phase, filter), after] }, include: { offer: { select: { title: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take });
}

/** Database counts over every claim, so the Brand sees the true backlog whichever page is open. */
export async function countCommerce7Claims(db: Db, brandId: string) {
  const [totalCount, needsActionCount] = await Promise.all([
    db.commerceRewardRedemption.count({ where: { brandId, provider: "COMMERCE7" } }),
    db.commerceRewardRedemption.count({ where: phaseWhere(brandId, "A", "ALL") }),
  ]);
  return { totalCount, needsActionCount };
}

type ClaimRow = Awaited<ReturnType<typeof fetchPhase>>[number];
/** The Brand-safe claim DTO. The merchant's tag UUID never leaves the server for exclusive claims. */
export async function serializeCommerce7BrandClaims(db: Pick<PrismaClient, "commerceRewardRedemption">, brandId: string, claims: ClaimRow[]) {
  const exclusiveClaims = claims.filter((claim) => claim.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS");
  // Live exclusive memberships per customer and tag, so the Brand can see when several rewards rely on one membership.
  const memberships = exclusiveClaims.length ? await db.commerceRewardRedemption.groupBy({
    by: ["connectionId", "providerCustomerId", "providerTagId"],
    where: { brandId, provider: "COMMERCE7", rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", status: { in: [...LIVE_ACCESS_STATUSES] }, membershipOwnership: { not: null },
      providerCustomerId: { in: [...new Set(exclusiveClaims.map((claim) => claim.providerCustomerId).filter((id): id is string => !!id))] }, providerTagId: { in: [...new Set(exclusiveClaims.map((claim) => claim.providerTagId).filter((id): id is string => !!id))] } },
    _count: { _all: true },
  }) : [];
  const otherLiveClaims = (claim: ClaimRow) => {
    const group = memberships.find((row) => row.connectionId === claim.connectionId && row.providerCustomerId === claim.providerCustomerId && row.providerTagId === claim.providerTagId)?._count._all ?? 0;
    return Math.max(0, group - (claim.membershipOwnership && (LIVE_ACCESS_STATUSES as readonly string[]).includes(claim.status) ? 1 : 0));
  };
  return claims.map((claim) => {
    const eligibilityMode = storedCommerce7Eligibility(claim.rewardConfigSnapshot, claim.rewardMode);
    const exclusive = claim.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS";
    // Exclusive claims grant the merchant's own tag: its UUID is never sent, and SQRATCH never revokes the membership.
    return { eligibilityMode, rewardMode: claim.rewardMode, id: claim.id, title: claim.offer.title, status: claim.status, provisioningState: claim.provisioningState, providerCustomerId: claim.providerCustomerId, providerTagId: exclusive ? null : claim.providerTagId, tagTitle: !exclusive && eligibilityMode === "CLAIMANT_ONLY" ? claimTagTitle(claim.id) : null,
      accessState: commerce7ClaimAccessState(claim), membershipOwnership: exclusive ? claim.membershipOwnership : null, membershipGuidance: exclusive ? commerce7MembershipGuidance(claim.membershipOwnership, otherLiveClaims(claim)) : null,
      message: claim.errorMessage, diagnostic: safeClaimDiagnostic(claim.lastReconcileReason), purchaseCheckedAt: claim.rewardOrderCheckedAt, needsManualReview: claim.needsManualReview, ownerActive: !!claim.provisioningOwner, canRevoke: !exclusive && claim.status === "ISSUED" && !!claim.externalDiscountId, canonicalOrderId: claim.canonicalOrderId, createdAt: claim.createdAt };
  });
}

// ── Catalog: the canonical ConnectedCommerceProduct rows, paged and searched in the database ──

export const COMMERCE7_CATALOG_PAGE_SIZE = 50;
const availableOf = (brandId: string, connectionId: string) => ({ brandId, connectionId, provider: "COMMERCE7" as const, isAvailable: true });

export function parseCommerce7CatalogQuery(params: URLSearchParams | null) {
  const q = (params?.get("q") ?? "").trim();
  if (q.length > 100) throw invalid("Search text is too long.");
  const mode = params?.get("mode") ?? "all";
  if (mode !== "all" && mode !== "exclusive") throw invalid("Unknown catalog mode.");
  const rawLimit = params?.get("limit") ?? null;
  const limit = rawLimit === null ? COMMERCE7_CATALOG_PAGE_SIZE : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw invalid(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
  const cursor = params?.get("cursor") ?? null;
  if (cursor !== null && (cursor.length === 0 || cursor.length > 100)) throw invalid("Invalid catalog cursor.");
  return { q, exclusiveOnly: mode === "exclusive", limit, cursor };
}

/**
 * One page of the connection's available products ordered by title, optionally searched by title and optionally limited to
 * products secured to Customer Tags. Only titles, ids and a tag COUNT leave the server; security metadata and tag ids never do.
 */
export async function listCommerce7Catalog(db: CatalogDb, brandId: string, connectionId: string, query: { q: string; exclusiveOnly: boolean; limit: number; cursor: string | null }) {
  const rows = await db.connectedCommerceProduct.findMany({
    where: { ...availableOf(brandId, connectionId), ...(query.q ? { title: { contains: query.q, mode: "insensitive" as const } } : {}),
      // The database narrows to Tag-secured products; the same validator the claim path uses decides which ones count.
      ...(query.exclusiveOnly ? { providerMetadata: { path: ["security", "availableTo"], equals: COMMERCE7_EXCLUSIVE_SECURITY_AVAILABLE_TO } } : {}) },
    select: { id: true, externalId: true, title: true, providerMetadata: true }, orderBy: [{ title: "asc" }, { id: "asc" }], take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, query.limit);
  const products = page.flatMap((row) => {
    if (!query.exclusiveOnly) return [{ externalId: row.externalId, title: row.title }];
    const tagCount = commerce7ExclusiveSecurity(row.providerMetadata)?.tagIds.length ?? 0;
    return tagCount ? [{ externalId: row.externalId, title: row.title, tagCount }] : [];
  });
  return { products, nextCursor: rows.length > query.limit ? page[page.length - 1].id : null };
}

/** Products an offer already references, by direct id lookup, so they resolve whatever their position in the catalog. */
export async function referencedCommerce7Products(db: CatalogDb, brandId: string, connectionIds: string[], externalIds: string[]) {
  if (!connectionIds.length || !externalIds.length) return [];
  return db.connectedCommerceProduct.findMany({
    where: { brandId, provider: "COMMERCE7", connectionId: { in: connectionIds }, externalId: { in: externalIds } },
    select: { connectionId: true, externalId: true, title: true, isAvailable: true, providerMetadata: true },
  });
}

/** Available products whose Product Security has never been read, counted over the whole connection in the database. */
export async function countCommerce7SecurityUnknown(db: CatalogDb, brandId: string, connectionId: string) {
  const where = availableOf(brandId, connectionId);
  // Unknown = no `security` object was ever read. Counted over the whole connection in the database.
  const [total, known] = await Promise.all([
    db.connectedCommerceProduct.count({ where }),
    db.connectedCommerceProduct.count({ where: { ...where, providerMetadata: { path: ["security"], not: Prisma.DbNull } } }),
  ]);
  return total - known;
}

/** Other available products secured by the same Customer Tag: granting it may unlock them too. Counted over the whole catalog. */
export async function sharedCommerce7ExclusiveProducts(db: CatalogDb, brandId: string, connectionId: string, tagId: string, exceptProductId: string) {
  const rows = await db.connectedCommerceProduct.findMany({
    where: { ...availableOf(brandId, connectionId), externalId: { not: exceptProductId }, providerMetadata: { path: ["security", "availableToObjectIds"], array_contains: [tagId] } },
    select: { externalId: true, title: true, providerMetadata: true }, orderBy: [{ title: "asc" }, { id: "asc" }],
  });
  return rows.filter((row) => commerce7ExclusiveSecurity(row.providerMetadata)?.tagIds.includes(tagId)).map((row) => ({ externalId: row.externalId, title: row.title }));
}

export const COMMERCE7_OFFER_PAGE_SIZE = 50;

/** `offersCursor` is an offer id; `offersLimit` is 1..100 (default 50). Offers are listed newest first. */
export function parseCommerce7OfferQuery(params: URLSearchParams | null) {
  const rawLimit = params?.get("offersLimit") ?? null;
  const limit = rawLimit === null ? COMMERCE7_OFFER_PAGE_SIZE : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw invalid(`offersLimit must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
  const cursor = params?.get("offersCursor") ?? null;
  if (cursor !== null && (cursor.length === 0 || cursor.length > 100)) throw invalid("Invalid offers cursor.");
  return { limit, cursor };
}

type OfferDb = Pick<PrismaClient, "brandRewardOffer">;

/** One page of this brand's Commerce7 offers (the caller's brand only), with the next cursor and the total. */
export async function listCommerce7Offers(db: OfferDb, brandId: string, query: { limit: number; cursor: string | null }) {
  const where = { brandId, provider: "COMMERCE7" as const };
  // The cursor must be one of THIS brand's offers: another brand's id never positions a page.
  if (query.cursor && !(await db.brandRewardOffer.findFirst({ where: { ...where, id: query.cursor }, select: { id: true } }))) throw invalid("Invalid offers cursor.");
  const [rows, totalCount] = await Promise.all([
    db.brandRewardOffer.findMany({
      where, include: { products: true, _count: { select: { redemptions: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    }),
    db.brandRewardOffer.count({ where }),
  ]);
  const offers = rows.slice(0, query.limit);
  return { offers, nextCursor: rows.length > query.limit ? offers[offers.length - 1].id : null, totalCount };
}
