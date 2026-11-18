import { NextRequest, NextResponse } from "next/server";
import { getCreatorContext } from "@/lib/creator-auth";
import prisma from "@/lib/prisma";
import { resolveCommerceClickAnalyticsDateRange } from "@/lib/commerce/commerce-click-analytics";
import { buildReportMeta, requestedFilterNames } from "@/lib/report-meta";

export async function GET(request: NextRequest) {
  return creatorAnalyticsGetImpl(request, getCreatorContext);
}

export async function creatorAnalyticsGetImpl(
  request: NextRequest,
  getContext: typeof getCreatorContext,
) {
  try {
    const creator = await getContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const experienceId = request.nextUrl.searchParams.get("experienceId");
    // The same strict UTC resolver the click and conversion panels use: valid
    // YYYY-MM-DD only, UTC calendar days, last 30 days when no dates are
    // given, and at most the shared maximum range. A malformed date is a 400,
    // not a 500 or a silently different period.
    const resolved = resolveCommerceClickAnalyticsDateRange({
      dateFrom: request.nextUrl.searchParams.get("dateFrom"),
      dateTo: request.nextUrl.searchParams.get("dateTo"),
      now: new Date(),
    });
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }
    const { start, end } = resolved.range;

    // Every experience this creator owns. The selector is built from this
    // list, so choosing one experience never removes the others from it.
    const ownedExperiences = await prisma.experience.findMany({
      where: { creatorId: creator.creatorProfile.id },
      orderBy: { title: "asc" },
      select: {
        id: true,
        title: true,
        slug: true,
      },
    });
    // The filter narrows the metrics, never the options. An id the creator
    // does not own matches nothing, exactly as before.
    const experiences = experienceId
      ? ownedExperiences.filter((experience) => experience.id === experienceId)
      : ownedExperiences;

    const experienceIds = experiences.map((experience) => experience.id);

    // The creator's own activity is never learner activity. Anonymous rows
    // (null user) stay in; `userId <> owner` alone would drop them.
    const notOwner = [{ userId: null }, { userId: { not: creator.userId } }];

    const analyticsWhere = {
      experienceId: {
        in: experienceIds,
      },
      createdAt: { gte: start, lte: end },
      OR: notOwner,
    };

    const questionWhere = {
      experienceId: {
        in: experienceIds,
      },
      createdAt: { gte: start, lte: end },
      // The creator's own questions are not learner activity.
      askedById: { not: creator.userId },
    };

    const [
      experienceViews,
      lessonStarts,
      lessonCompletions,
      questionCounts,
      completedInPeriod,
      currentlyCompleted,
      completionDateUnavailable,
    ] = await Promise.all([
      experienceIds.length
        ? prisma.analyticsEvent.groupBy({
            by: ["experienceId"],
            where: {
              ...analyticsWhere,
              name: "experience_view",
            },
            _count: {
              _all: true,
            },
          })
        : [],
      experienceIds.length
        ? prisma.analyticsEvent.groupBy({
            by: ["experienceId"],
            where: {
              ...analyticsWhere,
              name: "lesson_started",
            },
            _count: {
              _all: true,
            },
          })
        : [],
      experienceIds.length
        ? prisma.analyticsEvent.groupBy({
            by: ["experienceId"],
            where: {
              ...analyticsWhere,
              name: "lesson_completed",
            },
            _count: {
              _all: true,
            },
          })
        : [],
      experienceIds.length
        ? prisma.question.groupBy({
            by: ["experienceId"],
            where: questionWhere,
            _count: {
              _all: true,
            },
          })
        : [],
      // Completion is counted from `completedAt`, written once. Rows completed
      // before it existed have no recorded time and are reported separately.
      ...(["inPeriod", "current", "unrecorded"] as const).map((kind) =>
        experienceIds.length
          ? prisma.lessonProgress.count({
              where: {
                isCompleted: true,
                lesson: { course: { experienceId: { in: experienceIds } } },
                OR: notOwner,
                ...(kind === "inPeriod" ? { completedAt: { gte: start, lte: end } } : {}),
                ...(kind === "unrecorded" ? { completedAt: null } : {}),
              },
            })
          : 0,
      ),
    ]);

    const viewMap = new Map(
      experienceViews.map((row) => [row.experienceId, row._count._all]),
    );
    const lessonStartMap = new Map(
      lessonStarts.map((row) => [row.experienceId, row._count._all]),
    );
    const lessonCompletionMap = new Map(
      lessonCompletions.map((row) => [row.experienceId, row._count._all]),
    );
    const questionMap = new Map(
      questionCounts.map((row) => [row.experienceId, row._count._all]),
    );

    const byExperience = experiences.map((experience) => ({
      id: experience.id,
      title: experience.title,
      slug: experience.slug,
      views: viewMap.get(experience.id) || 0,
      lessonStarts: lessonStartMap.get(experience.id) || 0,
      lessonCompletions: lessonCompletionMap.get(experience.id) || 0,
      questions: questionMap.get(experience.id) || 0,
    }));

    return NextResponse.json({
      data: {
        filters: {
          experienceId: experienceId || null,
          dateFrom: start.toISOString(),
          dateTo: end.toISOString(),
        },
        // The period actually applied (UTC), including when the request named
        // no dates and the default window was used.
        range: { start: start.toISOString(), end: end.toISOString() },
        meta: buildReportMeta({
          period: { start, end },
          dateBasis: "event",
          scope: experienceId ? "experience" : "creator",
          appliedFilters: experienceId ? { experienceId } : {},
          unsupportedFilters: requestedFilterNames(request.nextUrl.searchParams, ["campaignId"]),
        }),
        experiences,
        options: { experiences: ownedExperiences },
        totals: {
          views: byExperience.reduce((total, row) => total + row.views, 0),
          lessonStarts: byExperience.reduce(
            (total, row) => total + row.lessonStarts,
            0,
          ),
          lessonCompletions: byExperience.reduce(
            (total, row) => total + row.lessonCompletions,
            0,
          ),
          questions: byExperience.reduce((total, row) => total + row.questions, 0),
          // Distinct measures: first completed in the period (from the immutable
          // completedAt), complete right now, and complete with no recorded date.
          lessonsCompletedInPeriod: completedInPeriod,
          lessonsCurrentlyComplete: currentlyCompleted,
          completionDateNotRecorded: completionDateUnavailable,
        },
        byExperience,
      },
    });
  } catch (error) {
    console.error("[creator/analytics][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load creator analytics." },
      { status: 500 },
    );
  }
}
