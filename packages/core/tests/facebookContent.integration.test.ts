import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  closeClient,
  ensureIndexes,
  getDb,
  resolvePendingFacebookAttributions,
  syncFacebookPosts,
  type CustomerDoc,
  type FacebookGraphPort,
  type FacebookPostDoc,
} from "../src";
import type { Db } from "mongodb";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const prefix = `fbcontent_${Date.now()}_${Math.random().toString(16).slice(2)}`;
let db: Db;
const now = new Date("2026-09-03T00:00:00Z");

function customer(suffix: string, adId: string | null, adOrOrganic: "ad" | "organic" = "ad"): CustomerDoc {
  const id = `${prefix}_${suffix}`;
  return {
    _id: id, status: "active", mergedInto: null, title: null, heardFrom: "Facebook", displayName: suffix,
    nickname: null, fullNameEn: null, birthYear: null, lineDisplayName: null, pictureUrl: null,
    facebook: null, instagram: null, phone: null, email: null, customerStatus: "lead", tags: [],
    source: { channel: "facebook_lead", campaign: null }, sources: ["facebook_lead"], consent: null,
    profileRef: null, pendingMerge: null,
    leadAttribution: { pageId: "page", formId: "form", adId, courseCode: null, campaignName: null, adOrOrganic, attributionPending: true, capturedAt: now },
    sheetSync: { dirty: false, rowKey: id, syncedAt: now, lockedAt: null, attempts: 0 },
    aiSync: { dirty: false, syncedAt: now, lockedAt: null, attempts: 0 }, counters: { milestones: 0, formSubmits: 0 },
    firstInteractionAt: now, lastInteractionAt: now, createdAt: now, updatedAt: now, schemaVersion: 1,
  };
}

async function cleanup(): Promise<void> {
  await Promise.all([
    db.collection<CustomerDoc>(COLLECTIONS.customers).deleteMany({ _id: { $regex: `^${prefix}` } }),
    db.collection<FacebookPostDoc>(COLLECTIONS.facebookPosts).deleteMany({ _id: { $regex: `^${prefix}` } }),
  ]);
}

beforeAll(async () => {
  if (!runIntegration) return;
  db = await getDb();
  await ensureIndexes(db);
});
beforeEach(async () => { if (runIntegration) await cleanup(); });
afterAll(async () => { if (runIntegration) await cleanup(); await closeClient(); });

describe.runIf(runIntegration)("Facebook attribution DB", () => {
  it("อัปเดตเฉพาะ lead ที่ resolve ได้ ส่วน unknown/organic ยัง pending", async () => {
    const post: FacebookPostDoc = {
      _id: `${prefix}_post`, postId: `${prefix}_story`, message: "#Inner", hashtags: ["#Inner"],
      courseCode: "INNER", createdTime: now, permalink: "https://facebook.example/post", engagement: { reactions: 1, comments: 2, shares: 3, reach: 10 },
      adIds: [], unmapped: false, fetchedAt: now, updatedAt: now, schemaVersion: 1,
    };
    await db.collection<FacebookPostDoc>(COLLECTIONS.facebookPosts).insertOne(post);
    await db.collection<CustomerDoc>(COLLECTIONS.customers).insertMany([
      customer("resolved", `${prefix}_ad`), customer("unknown", `${prefix}_unknown`), customer("organic", null, "organic"),
    ]);
    const result = await resolvePendingFacebookAttributions(db, async (adId) => adId === `${prefix}_ad` ? post.postId : null, now);
    expect(result).toMatchObject({ considered: 3, resolved: 1, unresolved: 1, organicSkipped: 1, byPost: 1 });
    expect(await db.collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: `${prefix}_resolved` })).toMatchObject({
      leadAttribution: { courseCode: "INNER", attributionPending: false }, sheetSync: { dirty: true }, aiSync: { dirty: true },
    });
    expect((await db.collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: `${prefix}_unknown` }))?.leadAttribution?.attributionPending).toBe(true);
    expect((await db.collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: `${prefix}_organic` }))?.leadAttribution?.attributionPending).toBe(true);
    expect((await db.collection<FacebookPostDoc>(COLLECTIONS.facebookPosts).findOne({ _id: post._id }))?.adIds).toContain(`${prefix}_ad`);
  });

  it("รอบแรกย้อนหลัง 365 วัน รอบถัดไป 90 วัน และดึง ad post ที่ไม่อยู่ใน /posts ตาม id", async () => {
    await db.collection<CustomerDoc>(COLLECTIONS.customers).insertOne(customer("dark-post", `${prefix}_dark-ad`));
    const sinceValues: Date[] = [];
    const client: FacebookGraphPort = {
      async listPosts(since) { sinceValues.push(since); return []; },
      async resolveAdPostId() { return `${prefix}_dark-story`; },
      async getPost(postId) {
        return { id: postId, message: "โฆษณาเฉพาะกลุ่ม #Communication", created_time: "2026-08-30T00:00:00Z" };
      },
      async getPostInsights() { return { data: [{ name: "post_impressions_unique", values: [{ value: 50 }] }] }; },
    };
    const first = await syncFacebookPosts(db, client, { now });
    const second = await syncFacebookPosts(db, client, { now });
    expect(first).toMatchObject({ days: 365, stored: 1, attribution: { resolved: 1, byPost: 1 } });
    expect(second.days).toBe(90);
    expect(Math.round((now.getTime() - sinceValues[0]!.getTime()) / 86_400_000)).toBe(365);
    expect(Math.round((now.getTime() - sinceValues[1]!.getTime()) / 86_400_000)).toBe(90);
    expect(await db.collection(COLLECTIONS.facebookPosts).findOne({ postId: `${prefix}_dark-story` })).toMatchObject({ courseCode: "COMMU", engagement: { reach: 50 } });
  });
});
