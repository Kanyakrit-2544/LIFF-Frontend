import type { Db } from "mongodb";
import { courseByCode } from "../legacy/courses";
import { newId } from "../ids";
import type { LeadgenNotification } from "./types";

/**
 * แปลง id ของโฆษณา/ฟอร์ม → คอร์สและแคมเปญ
 *
 * D34: ห้ามเดาคอร์สจากชื่อแอด — ต้องมีคนเติมตารางนี้เอง
 * ไม่มี mapping = เก็บ id ดิบไว้แล้วติดธง attributionPending รอเติมทีหลัง
 */

export const LEAD_COLLECTIONS = { formMappings: "lead_form_mappings" } as const;

export type LeadMatchOn = "adId" | "formId" | "pageId";

export interface LeadFormMappingDoc {
  _id: string; // lfm_<ULID>
  matchOn: LeadMatchOn;
  matchValue: string;
  courseCode: string | null;
  campaignName: string | null;
  adOrOrganic: "ad" | "organic" | "unknown";
  hashtags: string[];
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeadAttribution {
  pageId: string | null;
  formId: string | null;
  adId: string | null;
  courseCode: string | null;
  campaignName: string | null;
  adOrOrganic: "ad" | "organic" | "unknown";
  attributionPending: boolean;
  capturedAt: Date;
}

/** อันที่เจาะจงกว่าชนะ — โฆษณาชิ้นหนึ่งเจาะจงกว่าฟอร์ม ซึ่งเจาะจงกว่าเพจ */
const PRECEDENCE: LeadMatchOn[] = ["adId", "formId", "pageId"];

/** เลือก mapping ที่ตรงที่สุด — pure ทดสอบได้โดยไม่ต้องต่อ DB */
export function pickMapping(
  notification: LeadgenNotification,
  mappings: readonly LeadFormMappingDoc[]
): LeadFormMappingDoc | null {
  for (const level of PRECEDENCE) {
    const value = notification[level];
    if (!value) continue;
    const hit = mappings.find((m) => m.matchOn === level && m.matchValue === value);
    if (hit) return hit;
  }
  return null;
}

export function buildAttribution(
  notification: LeadgenNotification,
  mapping: LeadFormMappingDoc | null,
  now = new Date()
): LeadAttribution {
  return {
    pageId: notification.pageId,
    formId: notification.formId,
    adId: notification.adId,
    courseCode: mapping?.courseCode ?? null,
    campaignName: mapping?.campaignName ?? null,
    adOrOrganic: mapping?.adOrOrganic ?? "unknown",
    attributionPending: mapping === null,
    capturedAt: now,
  };
}

export async function loadMappings(db: Db): Promise<LeadFormMappingDoc[]> {
  return db.collection<LeadFormMappingDoc>(LEAD_COLLECTIONS.formMappings).find({}).toArray();
}

export interface UpsertMappingInput {
  matchOn: LeadMatchOn;
  matchValue: string;
  courseCode?: string | null;
  campaignName?: string | null;
  adOrOrganic?: "ad" | "organic" | "unknown";
  hashtags?: string[];
  note?: string | null;
}

/** courseCode ต้องมีจริงใน courses.ts — พิมพ์ผิดแล้วรายงานจะหาไม่เจอตลอดกาล */
export async function upsertLeadMapping(db: Db, input: UpsertMappingInput, now = new Date()): Promise<void> {
  if (input.courseCode && !courseByCode(input.courseCode)) {
    throw new Error(`courseCode "${input.courseCode}" ไม่มีใน courses.ts — เติมพจนานุกรมก่อน`);
  }
  await db.collection<LeadFormMappingDoc>(LEAD_COLLECTIONS.formMappings).updateOne(
    { matchOn: input.matchOn, matchValue: input.matchValue },
    {
      $set: {
        courseCode: input.courseCode ?? null,
        campaignName: input.campaignName ?? null,
        adOrOrganic: input.adOrOrganic ?? "unknown",
        hashtags: input.hashtags ?? [],
        note: input.note ?? null,
        updatedAt: now,
      },
      $setOnInsert: { _id: newId("leadMapping"), matchOn: input.matchOn, matchValue: input.matchValue, createdAt: now },
    },
    { upsert: true }
  );
}

export async function ensureLeadIndexes(db: Db): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  if (!existing.has(LEAD_COLLECTIONS.formMappings)) await db.createCollection(LEAD_COLLECTIONS.formMappings);
  await db.collection(LEAD_COLLECTIONS.formMappings).createIndex({ matchOn: 1, matchValue: 1 }, { name: "ux_match", unique: true });
}
