export interface ContentAttributionPost {
  postId: string;
  courseCode: string | null;
  permalink: string | null;
}

export interface ContentFallbackMapping {
  courseCode: string | null;
  campaignName?: string | null;
}

export type ContentAttributionResolution =
  | { status: "resolved"; source: "post" | "fallback"; courseCode: string; postId: string | null; permalink: string | null; campaignName: string | null }
  | { status: "unresolved"; courseCode: null; postId: string | null; permalink: string | null; campaignName: null }
  | { status: "skipped_organic"; courseCode: null; postId: null; permalink: null; campaignName: null };

export function resolveContentAttribution(input: {
  adId: string | null;
  adOrOrganic: "ad" | "organic" | "unknown";
  resolvedPostId: string | null;
  post: ContentAttributionPost | null;
  fallback: ContentFallbackMapping | null;
}): ContentAttributionResolution {
  if (!input.adId || input.adOrOrganic === "organic") {
    return { status: "skipped_organic", courseCode: null, postId: null, permalink: null, campaignName: null };
  }
  if (input.post?.courseCode) {
    return {
      status: "resolved",
      source: "post",
      courseCode: input.post.courseCode,
      postId: input.post.postId,
      permalink: input.post.permalink,
      campaignName: input.fallback?.campaignName ?? null,
    };
  }
  if (input.fallback?.courseCode) {
    return {
      status: "resolved",
      source: "fallback",
      courseCode: input.fallback.courseCode,
      postId: input.post?.postId ?? input.resolvedPostId,
      permalink: input.post?.permalink ?? null,
      campaignName: input.fallback.campaignName ?? null,
    };
  }
  return {
    status: "unresolved",
    courseCode: null,
    postId: input.post?.postId ?? input.resolvedPostId,
    permalink: input.post?.permalink ?? null,
    campaignName: null,
  };
}
