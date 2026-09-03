import { extractFacebookHashtags, mapHashtagsToCourse } from "./hashtags";
import {
  FACEBOOK_POST_SCHEMA_VERSION,
  type FacebookPostDoc,
  type GraphFacebookPost,
  type GraphPostInsights,
} from "./models";

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function reachFromInsights(insights: GraphPostInsights | null | undefined): number | null {
  const metric = insights?.data?.find((row) => row.name === "post_impressions_unique");
  const value = metric?.values?.at(-1)?.value;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function mapFacebookPost(
  post: GraphFacebookPost,
  insights: GraphPostInsights | null,
  now = new Date(),
  previous?: Pick<FacebookPostDoc, "adIds" | "engagement"> | null
): FacebookPostDoc | null {
  const postId = post.id?.trim();
  const createdTime = post.created_time ? new Date(post.created_time) : null;
  if (!postId || !createdTime || Number.isNaN(createdTime.getTime())) return null;

  const message = typeof post.message === "string" ? post.message : null;
  const hashtags = extractFacebookHashtags(message);
  const mapped = mapHashtagsToCourse(hashtags);
  return {
    _id: postId,
    postId,
    message,
    hashtags,
    courseCode: mapped.courseCode,
    createdTime,
    permalink: typeof post.permalink_url === "string" ? post.permalink_url : null,
    engagement: {
      reactions: nonNegative(post.reactions?.summary?.total_count),
      comments: nonNegative(post.comments?.summary?.total_count),
      shares: nonNegative(post.shares?.count),
      reach: reachFromInsights(insights) ?? previous?.engagement.reach ?? 0,
    },
    adIds: [...new Set(previous?.adIds ?? [])],
    unmapped: mapped.unmapped,
    fetchedAt: now,
    updatedAt: now,
    schemaVersion: FACEBOOK_POST_SCHEMA_VERSION,
  };
}
