import { getCreatorContext } from "@/lib/creator-auth";
import prisma from "@/lib/prisma";
import { createLessonVideoUploadHandler } from "@/lib/lesson-video-upload-handler";
import { createSignedUploadUrl } from "@/lib/storage-upload";
import { stageUpload } from "@/lib/staged-assets";

export const POST = createLessonVideoUploadHandler({
  getCreator: getCreatorContext,
  findOwnedCourse: (courseId, userId) =>
    prisma.course.findFirst({
      where: {
        id: courseId,
        experience: {
          creator: {
            userId,
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
    }),
  signUpload: createSignedUploadUrl,
  stageUpload: (input) => stageUpload(prisma, input),
});
