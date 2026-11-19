import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";

/**
 * Full brand-membership list for ONE user. The admin user lists only preview
 * the first three memberships plus a total; this backs the "show all" expand.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await getAdminContext();
    if (!admin) {
      return NextResponse.json({ error: "Admins only." }, { status: 403 });
    }

    const { id } = await context.params;
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        brandMembers: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            role: true,
            brand: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    return NextResponse.json({
      data: {
        userId: user.id,
        brandMembershipCount: user.brandMembers.length,
        brands: user.brandMembers.map((member) => ({
          id: member.brand.id,
          name: member.brand.name,
          slug: member.brand.slug,
          membershipRole: member.role,
        })),
      },
    });
  } catch (error) {
    console.error("[admin/users/[id]/memberships][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load memberships." },
      { status: 500 },
    );
  }
}
