import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { deleteFileFromStorage } from "@/lib/storage-upload";
import { sweepStagedAssets } from "@/lib/staged-assets";
import { timingSafeEqualString } from "@/lib/security/timing-safe-equal";

/**
 * Deletes lesson-video objects that were claimed for cleanup, and claims uploads
 * that were never attached within 24 hours. Not scheduled by this repository:
 * the owner must call it (POST with the x-cron-secret header) from an external
 * scheduler. See docs/lesson-video-uploads.md.
 */
export async function POST(req: Request) {
  if (!timingSafeEqualString(req.headers.get("x-cron-secret"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const result = await sweepStagedAssets(prisma, { deleteObject: deleteFileFromStorage });
    return NextResponse.json({ data: result });
  } catch (error) {
    console.error("[internal/asset-sweeper] Error:", error);
    return NextResponse.json({ error: "Sweep failed." }, { status: 500 });
  }
}
