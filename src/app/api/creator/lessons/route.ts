import { NextRequest, NextResponse } from "next/server";
import { getCreatorContext } from "@/lib/creator-auth";
import prisma from "@/lib/prisma";
import { createLessonOnce } from "@/lib/lesson-create";
import {
  deleteFileFromStorage,
  storageObjectExists,
  validateLessonVideoStorageObject,
  validateLessonVideoStorageUrl,
} from "@/lib/storage-upload";
import { createSignedLessonVideoUrl } from "@/lib/lesson-video-playback";
import { AssetUnavailableError, settleClaimedAssets } from "@/lib/staged-assets";
import { deleteLessonReleasingVideo, saveLessonWithVideo } from "@/lib/lesson-video-lifecycle";
import {
  resolveLessonVideoStorageReference,
  type LessonVideoStorageReference,
} from "@/lib/lesson-video-reference";
import { parseRewardPoints } from "@/lib/reward-points-input";
import {
  CANONICAL_ATTACHMENT_SELECT,
  projectCanonicalAttachment,
} from "@/lib/commerce/campaign-product-curation";

function normalizeVideoSource(value: unknown) {
  const normalized = String(value || "YOUTUBE")
    .trim()
    .toUpperCase();

  return normalized === "UPLOAD" ? "UPLOAD" : "YOUTUBE";
}

async function validateNewLessonVideoAsset(options: {
  videoAssetUrl: string;
  videoStorageBucket: string;
  videoStoragePath: string;
  courseId: string;
  experienceSlug: string;
}) {
  const parsed =
    options.videoStorageBucket || options.videoStoragePath
      ? validateLessonVideoStorageObject({
          bucket: options.videoStorageBucket,
          path: options.videoStoragePath,
          courseId: options.courseId,
          experienceSlug: options.experienceSlug,
        })
      : validateLessonVideoStorageUrl({
          url: options.videoAssetUrl,
          courseId: options.courseId,
          experienceSlug: options.experienceSlug,
        });

  if (!parsed) {
    return {
      ok: false as const,
      error: "The uploaded lesson video is not valid for this course.",
    };
  }

  const exists = await storageObjectExists(parsed);

  if (!exists) {
    return {
      ok: false as const,
      error: "The uploaded lesson video could not be found.",
    };
  }

  return { ok: true as const, reference: parsed };
}

const assetUnavailable = () =>
  NextResponse.json(
    { error: "The uploaded lesson video is no longer available. Please upload it again.", code: "ASSET_UNAVAILABLE" },
    { status: 409 },
  );

export async function GET(request: NextRequest) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const courseId = request.nextUrl.searchParams.get("courseId");

    if (!courseId) {
      return NextResponse.json(
        { error: "courseId is required." },
        { status: 400 },
      );
    }

    const course = await prisma.course.findFirst({
      where: {
        id: courseId,
        experience: {
          creator: {
            userId: creator.userId,
          },
        },
      },
      select: {
        id: true,
        title: true,
        access: true,
        experience: {
          select: {
            id: true,
            title: true,
            slug: true,
          },
        },
      },
    });

    if (!course) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }

    const lessons = await prisma.lesson.findMany({
      where: {
        courseId: course.id,
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        description: true,
        sortOrder: true,
        completionPointsReward: true,
        videoSource: true,
        youtubeUrl: true,
        videoUploadUrl: true,
        videoStorageBucket: true,
        videoStoragePath: true,
        // CANONICAL lesson product attachments. `isActive` is the only filter:
        // an attachment already made stays visible (and removable) even after
        // its underlying product becomes ineligible or unavailable — only NEW
        // attachments fail closed.
        campaignProducts: {
          where: { isActive: true },
          orderBy: [{ displayOrder: "asc" }, { createdAt: "desc" }],
          select: CANONICAL_ATTACHMENT_SELECT,
        },
      },
    });

    const lessonData = await Promise.all(
      lessons.map(async (lesson) => {
        const reference = resolveLessonVideoStorageReference({
          lesson,
          courseId: course.id,
          experienceSlug: course.experience.slug,
        });

        let videoAssetUrl: string | null = null;
        if (lesson.videoSource === "UPLOAD" && reference) {
          try { videoAssetUrl = await createSignedLessonVideoUrl(reference); }
          catch (error) { console.error("[creator/lessons][GET] Failed to sign lesson video.", error); }
        }
        return {
          id: lesson.id,
          title: lesson.title,
          description: lesson.description,
          sortOrder: lesson.sortOrder,
          completionPointsReward: lesson.completionPointsReward,
          videoSource: lesson.videoSource,
          youtubeUrl: lesson.youtubeUrl,
          videoAssetUrl,
          videoStorageBucket: reference?.bucket || null,
          videoStoragePath: reference?.path || null,
          // Canonical attachments carry no "stale snapshot" concept: every
          // display field is read live from the brand's own synced catalog, so
          // there is nothing to annotate as needing relinking.
          productLinks: lesson.campaignProducts.map(projectCanonicalAttachment),
        };
      }),
    );

    return NextResponse.json(
      {
        data: {
          course,
          lessons: lessonData,
        },
      },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    );
  } catch (error) {
    console.error("[creator/lessons][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load lessons." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const body = await request.json();
    const courseId = String(body?.courseId || "").trim();
    const title = String(body?.title || "").trim();
    const description = String(body?.description || "").trim();
    const sortOrder = Number(body?.sortOrder || 0);
    const videoSource = normalizeVideoSource(body?.videoSource);
    const youtubeUrl = String(body?.youtubeUrl || "").trim();
    const videoAssetUrl = String(body?.videoAssetUrl || "").trim();
    const videoStorageBucket = String(
      body?.videoStorageBucket || "",
    ).trim();
    const videoStoragePath = String(body?.videoStoragePath || "").trim();
    const reward = parseRewardPoints(
      body?.completionPointsReward,
      "Lesson completion points",
    );

    if (!courseId || !title) {
      return NextResponse.json(
        { error: "courseId and title are required." },
        { status: 400 },
      );
    }

    if (!reward.ok) {
      return NextResponse.json({ error: reward.error }, { status: 400 });
    }

    if (videoSource === "YOUTUBE" && !youtubeUrl) {
      return NextResponse.json(
        { error: "youtubeUrl is required for YouTube lessons." },
        { status: 400 },
      );
    }

    if (
      videoSource === "UPLOAD" &&
      !videoAssetUrl &&
      !videoStorageBucket &&
      !videoStoragePath
    ) {
      return NextResponse.json(
        { error: "videoAssetUrl is required for uploaded lessons." },
        { status: 400 },
      );
    }

    const course = await prisma.course.findFirst({
      where: {
        id: courseId,
        experience: {
          creator: {
            userId: creator.userId,
          },
        },
      },
      select: {
        id: true,
        experience: {
          select: {
            slug: true,
          },
        },
      },
    });

    if (!course) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }

    let videoReference: LessonVideoStorageReference | null = null;

    if (videoSource === "UPLOAD") {
      const validation = await validateNewLessonVideoAsset({
        videoAssetUrl,
        videoStorageBucket,
        videoStoragePath,
        courseId: course.id,
        experienceSlug: course.experience.slug,
      });

      if (!validation.ok) {
        return NextResponse.json(
          { error: validation.error },
          { status: 400 },
        );
      }

      videoReference = validation.reference;
    }

    const { lesson, created } = await createLessonOnce({
        courseId: course.id,
        title,
        description: description || null,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
        completionPointsReward: reward.value,
        videoSource,
        youtubeUrl: videoSource === "YOUTUBE" ? youtubeUrl : null,
        videoUploadUrl: null,
        videoStorageBucket: videoReference?.bucket || null,
        videoStoragePath: videoReference?.path || null,
      }, creator.userId);

    return NextResponse.json(
      {
        data: {
          ...lesson,
          videoAssetUrl: null,
        },
      },
      { status: created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof AssetUnavailableError) return assetUnavailable();
    console.error("[creator/lessons][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to create lesson." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const body = await request.json();
    const id = String(body?.id || "").trim();
    const title = String(body?.title || "").trim();
    const description = String(body?.description || "").trim();
    const sortOrder = Number(body?.sortOrder || 0);
    const videoSource = normalizeVideoSource(body?.videoSource);
    const youtubeUrl = String(body?.youtubeUrl || "").trim();
    const videoAssetUrl = String(body?.videoAssetUrl || "").trim();
    const videoStorageBucket = String(
      body?.videoStorageBucket || "",
    ).trim();
    const videoStoragePath = String(body?.videoStoragePath || "").trim();
    const reward = parseRewardPoints(
      body?.completionPointsReward,
      "Lesson completion points",
    );

    if (!id || !title) {
      return NextResponse.json(
        { error: "Lesson id and title are required." },
        { status: 400 },
      );
    }

    if (!reward.ok) {
      return NextResponse.json({ error: reward.error }, { status: 400 });
    }

    if (videoSource === "YOUTUBE" && !youtubeUrl) {
      return NextResponse.json(
        { error: "youtubeUrl is required for YouTube lessons." },
        { status: 400 },
      );
    }

    if (
      videoSource === "UPLOAD" &&
      !videoAssetUrl &&
      !videoStorageBucket &&
      !videoStoragePath
    ) {
      return NextResponse.json(
        { error: "videoAssetUrl is required for uploaded lessons." },
        { status: 400 },
      );
    }

    const existing = await prisma.lesson.findFirst({
      where: {
        id,
        course: {
          experience: {
            creator: {
              userId: creator.userId,
            },
          },
        },
      },
      select: {
        id: true,
        courseId: true,
        videoUploadUrl: true,
        videoStorageBucket: true,
        videoStoragePath: true,
        course: {
          select: {
            experience: {
              select: {
                slug: true,
              },
            },
          },
        },
      },
    });

    if (!existing) {
      return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
    }

    let videoReference: LessonVideoStorageReference | null = null;

    if (videoSource === "UPLOAD") {
      const validation = await validateNewLessonVideoAsset({
        videoAssetUrl,
        videoStorageBucket,
        videoStoragePath,
        courseId: existing.courseId,
        experienceSlug: existing.course.experience.slug,
      });

      if (!validation.ok) {
        return NextResponse.json(
          { error: validation.error },
          { status: 400 },
        );
      }

      videoReference = validation.reference;
    }

    const { lesson, claimedIds } = await saveLessonWithVideo(prisma, {
      lessonId: existing.id,
      courseId: existing.courseId,
      experienceSlug: existing.course.experience.slug,
      ownerUserId: creator.userId,
      videoReference,
      data: {
        title,
        description: description || null,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
        completionPointsReward: reward.value,
        videoSource,
        youtubeUrl: videoSource === "YOUTUBE" ? youtubeUrl : null,
      },
    });

    await settleClaimedAssets(prisma, claimedIds, deleteFileFromStorage).catch(() =>
      console.error("[creator/lessons][PATCH] Deferred lesson video cleanup."),
    );

    return NextResponse.json({
      data: {
        ...lesson,
        videoAssetUrl: null,
      },
    });
  } catch (error) {
    if (error instanceof AssetUnavailableError) return assetUnavailable();
    console.error("[creator/lessons][PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to update lesson." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const body = await request.json();
    const id = String(body?.id || "").trim();

    if (!id) {
      return NextResponse.json(
        { error: "Lesson id is required." },
        { status: 400 },
      );
    }

    const lesson = await prisma.lesson.findFirst({
      where: {
        id,
        course: {
          experience: {
            creator: {
              userId: creator.userId,
            },
          },
        },
      },
      select: {
        id: true,
        videoUploadUrl: true,
        videoStorageBucket: true,
        videoStoragePath: true,
        courseId: true,
        course: {
          select: {
            experience: {
              select: {
                slug: true,
              },
            },
          },
        },
      },
    });

    if (!lesson) {
      return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
    }

    const claimedIds = await deleteLessonReleasingVideo(prisma, {
      lessonId: lesson.id,
      courseId: lesson.courseId,
      experienceSlug: lesson.course.experience.slug,
      ownerUserId: creator.userId,
    });

    await settleClaimedAssets(prisma, claimedIds, deleteFileFromStorage).catch(() =>
      console.error("[creator/lessons][DELETE] Deferred lesson video cleanup."),
    );

    return NextResponse.json({ data: { id: lesson.id } });
  } catch (error) {
    console.error("[creator/lessons][DELETE] Error:", error);
    return NextResponse.json(
      { error: "Failed to delete lesson." },
      { status: 500 },
    );
  }
}
