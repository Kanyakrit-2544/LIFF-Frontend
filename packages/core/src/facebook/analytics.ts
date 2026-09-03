import { courseByCode } from "../legacy/courses";
import type { FacebookPostDoc } from "./models";

export interface PostAnalyticsRange {
  from: Date;
  to: Date;
}

export interface PostAnalyticsRow {
  key: string;
  courseCode: string | null;
  label: string;
  postCount: number;
  reactions: { total: number; average: number };
  comments: { total: number; average: number };
  shares: { total: number; average: number };
  engagement: { total: number; average: number };
  reach: { total: number; average: number };
}

export interface PostAnalyticsResult {
  rows: PostAnalyticsRow[];
  summary: {
    totalPosts: number;
    mappedPosts: number;
    unmappedPosts: number;
    totalEngagement: number;
    totalReach: number;
  };
  chartMaxEngagement: number;
  meta: {
    from: string;
    to: string;
    containsSynthetic: boolean;
    generatedAt: string;
  };
}

interface MutablePostAnalytics {
  courseCode: string | null;
  postCount: number;
  reactions: number;
  comments: number;
  shares: number;
  reach: number;
}

const average = (total: number, count: number) => count > 0 ? Math.round((total / count) * 100) / 100 : 0;

export function buildPostAnalytics(
  posts: readonly FacebookPostDoc[],
  range: PostAnalyticsRange,
  generatedAt = new Date()
): PostAnalyticsResult {
  const selected = posts.filter((post) => post.createdTime >= range.from && post.createdTime <= range.to);
  const grouped = new Map<string, MutablePostAnalytics>();
  for (const post of selected) {
    const key = post.courseCode ?? "UNMAPPED";
    const row = grouped.get(key) ?? {
      courseCode: post.courseCode,
      postCount: 0,
      reactions: 0,
      comments: 0,
      shares: 0,
      reach: 0,
    };
    row.postCount++;
    row.reactions += post.engagement.reactions;
    row.comments += post.engagement.comments;
    row.shares += post.engagement.shares;
    row.reach += post.engagement.reach;
    grouped.set(key, row);
  }

  const rows = [...grouped.entries()].map(([key, row]): PostAnalyticsRow => {
    const engagement = row.reactions + row.comments + row.shares;
    return {
      key,
      courseCode: row.courseCode,
      label: row.courseCode ? courseByCode(row.courseCode)?.nameTh ?? row.courseCode : "ยังไม่ map hashtag",
      postCount: row.postCount,
      reactions: { total: row.reactions, average: average(row.reactions, row.postCount) },
      comments: { total: row.comments, average: average(row.comments, row.postCount) },
      shares: { total: row.shares, average: average(row.shares, row.postCount) },
      engagement: { total: engagement, average: average(engagement, row.postCount) },
      reach: { total: row.reach, average: average(row.reach, row.postCount) },
    };
  }).sort((left, right) => right.engagement.total - left.engagement.total || left.key.localeCompare(right.key));

  const totalEngagement = rows.reduce((sum, row) => sum + row.engagement.total, 0);
  return {
    rows,
    summary: {
      totalPosts: selected.length,
      mappedPosts: selected.filter((post) => !post.unmapped && post.courseCode !== null).length,
      unmappedPosts: selected.filter((post) => post.unmapped).length,
      totalEngagement,
      totalReach: rows.reduce((sum, row) => sum + row.reach.total, 0),
    },
    chartMaxEngagement: Math.max(1, ...rows.map((row) => row.engagement.total)),
    meta: {
      from: range.from.toISOString().slice(0, 10),
      to: range.to.toISOString().slice(0, 10),
      containsSynthetic: selected.some((post) => post.synthetic === true),
      generatedAt: generatedAt.toISOString(),
    },
  };
}
