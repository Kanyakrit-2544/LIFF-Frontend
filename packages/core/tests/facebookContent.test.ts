import { describe, expect, it } from "vitest";
import {
  buildMarketingSheetSnapshot,
  buildPostAnalytics,
  courseCodeFromHashtag,
  extractFacebookHashtags,
  mapFacebookPost,
  mapHashtagsToCourse,
  resolveContentAttribution,
  type CustomerDoc,
  type FacebookPostDoc,
} from "../src";

const now = new Date("2026-09-03T00:00:00.000Z");

function post(over: Partial<FacebookPostDoc> = {}): FacebookPostDoc {
  return {
    _id: "fbp_1",
    postId: "1_1",
    message: "เปิดรอบ #InnerMakeover",
    hashtags: ["#InnerMakeover"],
    courseCode: "INNER",
    createdTime: new Date("2026-08-10T03:00:00.000Z"),
    permalink: "https://facebook.example/posts/1",
    engagement: { reactions: 10, comments: 4, shares: 2, reach: 100 },
    adIds: [],
    unmapped: false,
    fetchedAt: now,
    updatedAt: now,
    schemaVersion: 1,
    ...over,
  };
}

function customer(over: Partial<CustomerDoc> = {}): CustomerDoc {
  return {
    _id: "cus_1", status: "active", mergedInto: null, title: null, heardFrom: "Facebook",
    displayName: "ลูกค้าทดสอบ", nickname: null, fullNameEn: null, birthYear: null,
    lineDisplayName: null, pictureUrl: null, facebook: null, instagram: null,
    phone: "+66812345678", email: "test@example.test", customerStatus: "lead", tags: [],
    source: { channel: "facebook_lead", campaign: null }, sources: ["facebook_lead"],
    consent: null, profileRef: null, pendingMerge: null,
    leadAttribution: {
      pageId: "page", formId: "form", adId: "ad-1", courseCode: "INNER",
      campaignName: null, adOrOrganic: "ad", attributionPending: false, capturedAt: now,
    },
    sheetSync: { dirty: false, rowKey: "cus_1", syncedAt: now, lockedAt: null, attempts: 0 },
    aiSync: { dirty: false, syncedAt: now, lockedAt: null, attempts: 0 },
    counters: { milestones: 0, formSubmits: 0 }, firstInteractionAt: now,
    lastInteractionAt: now, createdAt: now, updatedAt: now, schemaVersion: 1,
    ...over,
  };
}

describe("Facebook hashtags", () => {
  it("แกะ hashtag และ map alias เป็นรหัสคอร์ส", () => {
    expect(extractFacebookHashtags("เรียน #Inner_Makeover แล้วต่อ #Communication")).toEqual(["#Inner_Makeover", "#Communication"]);
    expect(courseCodeFromHashtag("#inner-makeover")).toBe("INNER");
    expect(courseCodeFromHashtag("#ไม่รู้จัก")).toBeNull();
  });

  it("hashtag ไม่รู้จักยังเก็บเป็น unmapped และหลายคอร์สไม่เดา", () => {
    expect(mapHashtagsToCourse(["#Inner", "#ข่าวสาร"])).toMatchObject({ courseCode: "INNER", unmapped: true, unknownHashtags: ["#ข่าวสาร"] });
    expect(mapHashtagsToCourse(["#Inner", "#Communication"])).toMatchObject({ courseCode: null, unmapped: true, ambiguous: true });
    expect(mapHashtagsToCourse([])).toMatchObject({ courseCode: null, unmapped: true });
  });

  it("แปลง Graph post เป็น document โดยคงโพสต์ unmapped ไว้", () => {
    const mapped = mapFacebookPost({
      id: "page_post", message: "ข่าวใหม่ #UnknownCampaign", created_time: "2026-08-10T03:00:00Z",
      reactions: { summary: { total_count: 7 } }, comments: { summary: { total_count: 3 } }, shares: { count: 1 },
    }, { data: [{ name: "post_impressions_unique", values: [{ value: 88 }] }] }, now);
    expect(mapped).toMatchObject({ postId: "page_post", courseCode: null, unmapped: true, engagement: { reactions: 7, comments: 3, shares: 1, reach: 88 } });
  });
});

describe("Facebook content attribution", () => {
  it("โพสต์ที่ map แล้วชนะ fallback", () => {
    expect(resolveContentAttribution({
      adId: "ad-1", adOrOrganic: "ad", resolvedPostId: "1_1", post: post(),
      fallback: { courseCode: "COMMU", campaignName: "fallback" },
    })).toMatchObject({ status: "resolved", source: "post", courseCode: "INNER", postId: "1_1" });
  });

  it("ใช้ fallback ที่คนกำหนดเมื่อหาโพสต์ไม่ได้", () => {
    expect(resolveContentAttribution({
      adId: "ad-2", adOrOrganic: "ad", resolvedPostId: null, post: null,
      fallback: { courseCode: "PRESENT", campaignName: "manual" },
    })).toMatchObject({ status: "resolved", source: "fallback", courseCode: "PRESENT" });
  });

  it("resolve ไม่ได้ไม่เดา และ organic ถูกข้าม", () => {
    expect(resolveContentAttribution({ adId: "ad-3", adOrOrganic: "ad", resolvedPostId: null, post: null, fallback: null }).status).toBe("unresolved");
    expect(resolveContentAttribution({ adId: null, adOrOrganic: "organic", resolvedPostId: null, post: null, fallback: null }).status).toBe("skipped_organic");
  });
});

describe("Facebook post analytics", () => {
  it("คืนจำนวน รวม ค่าเฉลี่ย สเกลกราฟ และ unmapped จาก core", () => {
    const result = buildPostAnalytics([
      post(),
      post({ _id: "fbp_2", postId: "1_2", engagement: { reactions: 6, comments: 2, shares: 0, reach: 60 }, synthetic: true }),
      post({ _id: "fbp_3", postId: "1_3", courseCode: null, hashtags: ["#unknown"], unmapped: true, engagement: { reactions: 1, comments: 0, shares: 0, reach: 20 } }),
    ], { from: new Date("2026-08-01T00:00:00Z"), to: new Date("2026-08-31T23:59:59Z") }, now);
    expect(result.summary).toEqual({ totalPosts: 3, mappedPosts: 2, unmappedPosts: 1, totalEngagement: 25, totalReach: 180 });
    expect(result.rows[0]).toMatchObject({ courseCode: "INNER", postCount: 2, engagement: { total: 24, average: 12 }, reach: { total: 160, average: 80 } });
    expect(result.chartMaxEngagement).toBe(24);
    expect(result.meta.containsSynthetic).toBe(true);
  });
});

describe("Marketing sheet snapshot", () => {
  it("แยก 3 tab, ผูก lead กับ permalink และไม่มีข้อความแชท", () => {
    const snapshot = buildMarketingSheetSnapshot([customer()], [post({ adIds: ["ad-1"] })]);
    expect(snapshot.tabs.map((tab) => tab.name)).toEqual(["Customers", "FB Leads", "FB Posts"]);
    expect(snapshot.counts).toEqual({ customers: 1, leads: 1, posts: 1, unmappedPosts: 0 });
    expect(snapshot.tabs[1]!.values[1]!.join(" ")).toContain("facebook.example/posts/1");
    expect(JSON.stringify(snapshot)).not.toContain("ข้อความแชทลับ");
  });
});
