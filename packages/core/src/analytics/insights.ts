import type { Db } from "mongodb";
import { AI_COLLECTIONS } from "../db/models";
import { newId } from "../ids";
import type { AnalyticsQuery, AnalyticsResult } from "./query";

/**
 * บันทึกทุกคำตอบไว้ตรวจย้อนหลัง (D40)
 *
 * เก็บ params คู่กับ result เสมอ — เวลามีคนถามว่า "ตัวเลขนี้มาจากไหน"
 * ต้องรันซ้ำด้วย params เดิมแล้วได้ผลเดิม ไม่ใช่เดาว่าตอนนั้นถามอะไร
 */

export interface InsightDoc {
  _id: string; // ins_<ULID>
  question: string | null;
  params: AnalyticsQuery;
  result: AnalyticsResult;
  answer: string | null;
  /** ผ่าน verifyAnswerNumbers ไหม — false = LLM แต่งตัวเลข ไม่ควรเชื่อข้อความนั้น */
  answerVerified: boolean;
  invented: string[];
  model: string | null;
  promptVersion: string;
  runAt: Date;
  elapsedMs: number;
}

export async function saveInsight(db: Db, doc: Omit<InsightDoc, "_id">): Promise<string> {
  const _id = newId("insight");
  await db.collection<InsightDoc>(AI_COLLECTIONS.insights).insertOne({ _id, ...doc });
  return _id;
}

export async function ensureInsightIndexes(db: Db): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  if (!existing.has(AI_COLLECTIONS.insights)) await db.createCollection(AI_COLLECTIONS.insights);
  const col = db.collection(AI_COLLECTIONS.insights);
  await col.createIndex({ runAt: -1 }, { name: "ix_runAt" });
  await col.createIndex({ "params.metric": 1, runAt: -1 }, { name: "ix_metric" });
}
