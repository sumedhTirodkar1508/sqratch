import { NextResponse } from "next/server";
import { CommerceProvider } from "@prisma/client";
import { getAdminContext } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";
import {
  getActiveCommerceConnectionsForBrands,
  getAllCommerceConnectionsForBrands,
} from "@/lib/commerce/connection-service";

export async function GET() {
  try {
    const context = await getAdminContext();

    if (!context) {
      return NextResponse.json({ error: "Admins only." }, { status: 403 });
    }

    const brands = await prisma.brand.findMany({
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        name: true,
        slug: true,
        bio: true,
        websiteUrl: true,
        logoUrl: true,
        isActive: true,
        createdAt: true,
        members: {
          orderBy: {
            createdAt: "asc",
          },
          select: {
            id: true,
            role: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
                isActive: true,
              },
            },
          },
        },
        campaigns: {
          orderBy: {
            updatedAt: "desc",
          },
          select: {
            id: true,
            name: true,
            slug: true,
            isActive: true,
          },
        },
      },
    });

    // CANONICAL — one batched CommerceConnection query for every brand in
    // this list, never one query per brand (see connection-service.ts).
    const brandIds = brands.map((brand) => brand.id);
    const [connectionsByBrand, allConnections] = await Promise.all([
      getActiveCommerceConnectionsForBrands(brandIds, CommerceProvider.SHOPIFY),
      getAllCommerceConnectionsForBrands(brandIds),
    ]);

    return NextResponse.json({
      data: brands.map((brand) => ({
        ...brand,
        shopifyShopDomain: connectionsByBrand.get(brand.id)?.externalAccountId ?? null,
        connectionsComplete: allConnections.complete,
        connections: (allConnections.byBrand.get(brand.id) ?? []).map(
          (connection) => ({
            id: connection.id,
            provider: connection.provider,
            status: connection.status,
            isPrimary: connection.isPrimary,
            externalAccountLabel:
              connection.displayName || connection.externalAccountId,
            externalAccountId: connection.externalAccountId,
          }),
        ),
      })),
    });
  } catch (error) {
    console.error("[admin/brands][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load brands." },
      { status: 500 },
    );
  }
}
