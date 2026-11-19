import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

type RequestRow = {
  status: "PENDING" | "APPROVED" | "REJECTED";
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toApplicantView(row: RequestRow | null) {
  if (!row) return null;
  return {
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    // While PENDING, `reason` holds the applicant's own signup payload, not a
    // decision. Only a decided request carries an applicant-facing reason.
    reason: row.status === "PENDING" ? null : row.reason,
    decidedAt: row.status === "PENDING" ? null : row.updatedAt.toISOString(),
  };
}

const select = {
  status: true,
  reason: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [creator, brand] = await Promise.all([
    prisma.creatorRequest.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select,
    }),
    prisma.brandRequest.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select,
    }),
  ]);

  return NextResponse.json(
    {
      data: {
        creator: toApplicantView(creator),
        brand: toApplicantView(brand),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
