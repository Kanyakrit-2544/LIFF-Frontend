import type { Db } from "mongodb";
import { COLLECTIONS, type CustomerDoc } from "../db/models";
import { HEADERS, toSheetRow } from "../customers/toSheetRow";
import type { FacebookPostDoc } from "./models";

export const MARKETING_SHEET_TABS = {
  customers: "Customers",
  leads: "FB Leads",
  posts: "FB Posts",
} as const;

export const MARKETING_LEAD_HEADERS = ["ชื่อ", "เบอร์", "คอร์ส", "มาจากโพสต์ไหน", "วันที่"] as const;
export const MARKETING_POST_HEADERS = [
  "คอร์ส", "วันที่", "Reactions", "Comments", "Shares", "Engagement", "Reach", "Permalink", "สถานะ",
] as const;
export type MarketingSheetCell = string | number;

export interface MarketingSheetTab {
  name: string;
  values: MarketingSheetCell[][];
}

export interface MarketingSheetSnapshot {
  tabs: MarketingSheetTab[];
  counts: { customers: number; leads: number; posts: number; unmappedPosts: number };
}

const date = (value: Date | null | undefined) => value ? value.toISOString().slice(0, 10) : "";

function postLabel(post: FacebookPostDoc | undefined): string {
  if (!post) return "";
  const title = post.message?.trim().split(/\r?\n/)[0]?.slice(0, 90) ?? "";
  return [title, post.permalink].filter(Boolean).join(" | ");
}

export function buildMarketingSheetSnapshot(
  customers: readonly CustomerDoc[],
  posts: readonly FacebookPostDoc[]
): MarketingSheetSnapshot {
  const sortedCustomers = [...customers].sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  const sortedPosts = [...posts].sort((left, right) => right.createdTime.getTime() - left.createdTime.getTime());
  const postByAdId = new Map<string, FacebookPostDoc>();
  for (const post of sortedPosts) {
    for (const adId of post.adIds) if (!postByAdId.has(adId)) postByAdId.set(adId, post);
  }
  const leads = sortedCustomers.filter((customer) =>
    customer.source.channel === "facebook_lead" || customer.sources.includes("facebook_lead")
  );

  return {
    tabs: [
      {
        name: MARKETING_SHEET_TABS.customers,
        values: [HEADERS, ...sortedCustomers.map((customer) => [...toSheetRow(customer), ""])],
      },
      {
        name: MARKETING_SHEET_TABS.leads,
        values: [[...MARKETING_LEAD_HEADERS], ...leads.map((customer): MarketingSheetCell[] => {
          const erased = customer.status === "erased";
          const attribution = customer.leadAttribution;
          const post = attribution?.adId ? postByAdId.get(attribution.adId) : undefined;
          return [
            erased ? "" : customer.displayName ?? customer.lineDisplayName ?? "",
            erased ? "" : customer.phone ?? "",
            attribution?.courseCode ?? "",
            postLabel(post),
            date(attribution?.capturedAt ?? customer.firstInteractionAt),
          ];
        })],
      },
      {
        name: MARKETING_SHEET_TABS.posts,
        values: [[...MARKETING_POST_HEADERS], ...sortedPosts.map((post): MarketingSheetCell[] => [
          post.courseCode ?? "",
          date(post.createdTime),
          post.engagement.reactions,
          post.engagement.comments,
          post.engagement.shares,
          post.engagement.reactions + post.engagement.comments + post.engagement.shares,
          post.engagement.reach,
          post.permalink ?? "",
          post.unmapped ? "⚠️ ยังไม่ map" : "",
        ])],
      },
    ],
    counts: {
      customers: sortedCustomers.length,
      leads: leads.length,
      posts: sortedPosts.length,
      unmappedPosts: sortedPosts.filter((post) => post.unmapped).length,
    },
  };
}

export async function loadMarketingSheetSnapshot(db: Db): Promise<MarketingSheetSnapshot> {
  const [customers, posts] = await Promise.all([
    db.collection<CustomerDoc>(COLLECTIONS.customers).find({}).toArray(),
    db.collection<FacebookPostDoc>(COLLECTIONS.facebookPosts).find({}).toArray(),
  ]);
  return buildMarketingSheetSnapshot(customers, posts);
}
