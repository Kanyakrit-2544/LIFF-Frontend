import type { Db } from "mongodb";
import { COLLECTIONS, type CustomerDoc } from "../db/models";
import { courseByCode } from "../legacy/courses";
import { LEAD_COLLECTIONS, type LeadFormMappingDoc } from "../leads/attribution";
import { buildPostAnalytics, type PostAnalyticsResult } from "./analytics";
import { resolveContentAttribution } from "./attribution";
import type { FacebookGraphPort } from "./graph";
import { mapFacebookPost } from "./post";
import type { FacebookPostDoc, GraphFacebookPost, GraphPostInsights } from "./models";

export interface ResolveFacebookAttributionResult {
  considered: number;
  resolved: number;
  unresolved: number;
  organicSkipped: number;
  byPost: number;
  byFallback: number;
}

type LeadCustomer = Pick<CustomerDoc, "_id" | "leadAttribution" | "sources">;

export async function resolvePendingFacebookAttributions(
  db: Db,
  resolveAdPostId: (adId: string) => Promise<string | null>,
  now = new Date()
): Promise<ResolveFacebookAttributionResult> {
  const customers = await db.collection<LeadCustomer>(COLLECTIONS.customers).find({
    "leadAttribution.attributionPending": true,
    sources: "facebook_lead",
  }).toArray();
  const result: ResolveFacebookAttributionResult = {
    considered: customers.length,
    resolved: 0,
    unresolved: 0,
    organicSkipped: 0,
    byPost: 0,
    byFallback: 0,
  };
  if (customers.length === 0) return result;

  const mappings = await db.collection<LeadFormMappingDoc>(LEAD_COLLECTIONS.formMappings).find({ matchOn: "adId" }).toArray();
  const fallbackByAd = new Map(mappings.map((mapping) => [mapping.matchValue, mapping]));
  const postIdByAd = new Map<string, string | null>();
  const adIds = [...new Set(customers.flatMap((customer) => customer.leadAttribution?.adId ? [customer.leadAttribution.adId] : []))];
  await Promise.all(adIds.map(async (adId) => {
    const existing = await db.collection<FacebookPostDoc>(COLLECTIONS.facebookPosts).findOne(
      { adIds: adId },
      { projection: { postId: 1 } }
    );
    postIdByAd.set(adId, existing?.postId ?? await resolveAdPostId(adId));
  }));

  const postIds = [...new Set([...postIdByAd.values()].filter((value): value is string => Boolean(value)))];
  const posts = postIds.length
    ? await db.collection<FacebookPostDoc>(COLLECTIONS.facebookPosts).find({ postId: { $in: postIds } }).toArray()
    : [];
  const postById = new Map(posts.map((post) => [post.postId, post]));

  for (const customer of customers) {
    const attribution = customer.leadAttribution;
    if (!attribution) continue;
    if (!attribution.adId || attribution.adOrOrganic === "organic") {
      result.organicSkipped++;
      continue;
    }
    const postId = postIdByAd.get(attribution.adId) ?? null;
    const post = postId ? postById.get(postId) ?? null : null;
    const fallback = fallbackByAd.get(attribution.adId) ?? null;
    const resolution = resolveContentAttribution({
      adId: attribution.adId,
      adOrOrganic: attribution.adOrOrganic,
      resolvedPostId: postId,
      post,
      fallback,
    });

    if (post) {
      await db.collection<FacebookPostDoc>(COLLECTIONS.facebookPosts).updateOne(
        { _id: post._id },
        { $addToSet: { adIds: attribution.adId }, $set: { updatedAt: now } }
      );
    }
    if (resolution.status !== "resolved" || !courseByCode(resolution.courseCode)) {
      result.unresolved++;
      continue;
    }

    const set: Record<string, unknown> = {
      "leadAttribution.courseCode": resolution.courseCode,
      "leadAttribution.adOrOrganic": "ad",
      "leadAttribution.attributionPending": false,
      "sheetSync.dirty": true,
      "sheetSync.lockedAt": null,
      "sheetSync.attempts": 0,
      "aiSync.dirty": true,
      "aiSync.lockedAt": null,
      "aiSync.attempts": 0,
      updatedAt: now,
    };
    if (resolution.campaignName) set["leadAttribution.campaignName"] = resolution.campaignName;
    const changed = await db.collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
      { _id: customer._id, "leadAttribution.attributionPending": true },
      { $set: set }
    );
    if (changed.modifiedCount > 0) {
      result.resolved++;
      resolution.source === "post" ? result.byPost++ : result.byFallback++;
    }
  }
  return result;
}

export interface SyncFacebookPostsResult {
  configured: boolean;
  days: number;
  fetched: number;
  stored: number;
  invalid: number;
  insightFailures: number;
  attribution: ResolveFacebookAttributionResult;
}

async function loadInsights(
  client: FacebookGraphPort,
  posts: readonly GraphFacebookPost[]
): Promise<Map<string, GraphPostInsights | null>> {
  const output = new Map<string, GraphPostInsights | null>();
  for (let index = 0; index < posts.length; index += 5) {
    const batch = posts.slice(index, index + 5);
    await Promise.all(batch.map(async (post) => {
      if (!post.id) return;
      output.set(post.id, await client.getPostInsights(post.id));
    }));
  }
  return output;
}

export async function syncFacebookPosts(
  db: Db,
  client: FacebookGraphPort | null,
  options: { days?: number; now?: Date } = {}
): Promise<SyncFacebookPostsResult> {
  const emptyAttribution: ResolveFacebookAttributionResult = {
    considered: 0, resolved: 0, unresolved: 0, organicSkipped: 0, byPost: 0, byFallback: 0,
  };
  if (!client) return {
    configured: false, days: options.days ?? 90, fetched: 0, stored: 0,
    invalid: 0, insightFailures: 0, attribution: emptyAttribution,
  };
  const now = options.now ?? new Date();
  const existingCount = await db.collection(COLLECTIONS.facebookPosts).countDocuments({ synthetic: { $ne: true } });
  const days = options.days ?? (existingCount === 0 ? 365 : 90);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error("days ต้องอยู่ระหว่าง 1–366");
  const since = new Date(now.getTime() - days * 86_400_000);
  const graphPosts = await client.listPosts(since);
  const ids = graphPosts.flatMap((post) => post.id ? [post.id] : []);
  const previous = ids.length
    ? await db.collection<FacebookPostDoc>(COLLECTIONS.facebookPosts).find({ postId: { $in: ids } }).toArray()
    : [];
  const previousById = new Map(previous.map((post) => [post.postId, post]));
  const insights = await loadInsights(client, graphPosts);
  const mapped = graphPosts.map((post) => mapFacebookPost(
    post,
    post.id ? insights.get(post.id) ?? null : null,
    now,
    post.id ? previousById.get(post.id) : null
  ));
  const valid = mapped.filter((post): post is FacebookPostDoc => post !== null);
  if (valid.length > 0) {
    await db.collection<FacebookPostDoc>(COLLECTIONS.facebookPosts).bulkWrite(valid.map((post) => ({
      replaceOne: { filter: { _id: post._id }, replacement: post, upsert: true },
    })), { ordered: false });
  }

  const onDemandPosts = new Set<string>();
  let onDemandStored = 0;
  const attribution = await resolvePendingFacebookAttributions(db, async (adId) => {
    const postId = await client.resolveAdPostId(adId);
    if (!postId) return null;
    const exists = await db.collection<FacebookPostDoc>(COLLECTIONS.facebookPosts).findOne(
      { postId },
      { projection: { _id: 1 } }
    );
    if (!exists && !onDemandPosts.has(postId)) {
      onDemandPosts.add(postId);
      const graphPost = await client.getPost(postId);
      if (graphPost) {
        const document = mapFacebookPost(graphPost, await client.getPostInsights(postId), now);
        if (document) {
          await db.collection<FacebookPostDoc>(COLLECTIONS.facebookPosts).replaceOne(
            { _id: document._id },
            document,
            { upsert: true }
          );
          onDemandStored++;
        }
      }
    }
    return postId;
  }, now);
  return {
    configured: true,
    days,
    fetched: graphPosts.length,
    stored: valid.length + onDemandStored,
    invalid: graphPosts.length - valid.length,
    insightFailures: ids.filter((id) => insights.get(id) === null).length,
    attribution,
  };
}

export function postAnalyticsRange(from: string, to: string): { from: Date; to: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new Error("ช่วงวันที่โพสต์ไม่ถูกต้อง");
  }
  const start = new Date(`${from}T00:00:00+07:00`);
  const end = new Date(`${to}T23:59:59.999+07:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error("ช่วงวันที่โพสต์ไม่ถูกต้อง");
  return { from: start, to: end };
}

export async function listPostAnalytics(db: Db, range: { from: string; to: string }): Promise<PostAnalyticsResult> {
  const parsed = postAnalyticsRange(range.from, range.to);
  const posts = await db.collection<FacebookPostDoc>(COLLECTIONS.facebookPosts).find({
    createdTime: { $gte: parsed.from, $lte: parsed.to },
  }).toArray();
  return buildPostAnalytics(posts, parsed);
}
