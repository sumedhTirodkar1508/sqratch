import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getBrandContextFailure, getBrandManagementContext } from "@/lib/brand-auth";
import { getAllCommerceConnectionsForBrand, isConnectionUsable, type CommerceConnectionListResult } from "@/lib/commerce/connection-service";

const PROVIDERS = ["SHOPIFY", "COMMERCE7"] as const;
type Provider = (typeof PROVIDERS)[number];
type Presence = { getContext: typeof getBrandManagementContext; getConnections(brandId: string): Promise<CommerceConnectionListResult>; countByProvider(brandId: string): Promise<{ offers: Record<string, number>; claims: Record<string, number> }> };

const DEFAULTS: Presence = {
  getContext: getBrandManagementContext,
  getConnections: (brandId) => getAllCommerceConnectionsForBrand(brandId),
  async countByProvider(brandId) {
    const [offers, claims] = await Promise.all([
      prisma.brandRewardOffer.groupBy({ by: ["provider"], where: { brandId }, _count: { _all: true } }),
      prisma.commerceRewardRedemption.groupBy({ by: ["provider"], where: { brandId }, _count: { _all: true } }),
    ]);
    return { offers: Object.fromEntries(offers.map((row) => [row.provider, row._count._all])), claims: Object.fromEntries(claims.map((row) => [row.provider, row._count._all])) };
  },
};

/**
 * Brand-only, read-only: which rewards providers this Brand can open. A provider is listed when it has any connection (in any
 * state), offer or claim, so a disconnected store keeps its history. Nothing here ever chooses a provider for the Brand.
 */
export async function GET() { return providersGetImpl(); }
export async function providersGetImpl(overrides: Partial<Presence> = {}) {
  const deps = { ...DEFAULTS, ...overrides };
  try {
    const context = await deps.getContext();
    if (!context?.membership?.brand) { const failure = getBrandContextFailure(context); return NextResponse.json({ error: failure.error }, { status: failure.status }); }
    const brandId = context.membership.brand.id;
    const [list, counts] = await Promise.all([deps.getConnections(brandId), deps.countByProvider(brandId)]);
    const providers = PROVIDERS.map((provider: Provider) => {
      const rows = list.connections.filter((connection) => connection.provider === provider);
      // The usable connection wins; otherwise the newest known one explains why the provider is read-only.
      const connection = rows.find(isConnectionUsable) ?? [...rows].sort((a, b) => (b.installedAt?.getTime() ?? 0) - (a.installedAt?.getTime() ?? 0))[0] ?? null;
      const offerCount = counts.offers[provider] ?? 0; const claimCount = counts.claims[provider] ?? 0;
      return {
        provider, offerCount, claimCount,
        connection: connection ? { status: connection.status, displayName: connection.displayName, usable: isConnectionUsable(connection) } : null,
        // A provider whose connection read failed is kept visible: an unknown state must never hide a workspace.
        visible: !!connection || offerCount > 0 || claimCount > 0 || list.failedProviders.includes(provider),
      };
    });
    return NextResponse.json({ providers, complete: list.complete });
  } catch {
    return NextResponse.json({ error: "Failed to load rewards providers." }, { status: 500 });
  }
}
