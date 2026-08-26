import type { Collection } from "mongodb";
import { getDb } from "../db/client";
import { COLLECTIONS, type InboundEventDoc, type InboundEventStatus } from "../db/models";
import { newId } from "../ids";
import { log } from "../logger";

/**
 * Inbound Outbox (docs/00 RISK-3, RISK-8)
 *
 * LINE ต้องได้ 200 ภายในราว 1 วินาที และ retry มีเพดาน
 * ถ้าเส้นทางคือ LINE → Vercel → n8n → Mongo แบบ synchronous แล้ว n8n ล่ม = event หายถาวร
 *
 * จึงรับ event → เขียนลง inbound_events แบบ idempotent → ตอบ 200 ทันที
 * แล้วให้ n8n มาดึงไปทำ (pull mode) หรือรับ push ก็ได้ — event ไม่หายทั้งสองทาง
 */

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_SEC = 30;
const CLAIM_LEASE_MS = 5 * 60 * 1000;

async function col(): Promise<Collection<InboundEventDoc>> {
  return (await getDb()).collection<InboundEventDoc>(COLLECTIONS.inboundEvents);
}

export interface EnqueueInput {
  eventId: string;
  provider: string;
  channelId: string | null;
  raw: Record<string, unknown>;
}

export interface EnqueueResult {
  accepted: number;
  duplicated: number;
  eventIds: string[];
}

/**
 * เขียน event ลงคิว — ซ้ำก็ไม่เป็นไร
 * unique(eventId, provider) ทำให้ idempotency เกิดที่ระดับ database ไม่ใช่ที่ logic ของเรา
 * ordered:false เพื่อให้ตัวที่ไม่ซ้ำเข้าได้ครบ แม้บางตัวชน duplicate
 */
export async function enqueueEvents(items: EnqueueInput[]): Promise<EnqueueResult> {
  if (items.length === 0) return { accepted: 0, duplicated: 0, eventIds: [] };

  const now = new Date();
  const docs = items.map((i) => ({
    eventId: i.eventId,
    provider: i.provider,
    channelId: i.channelId,
    status: "pending" as InboundEventStatus,
    attempts: 0,
    nextAttemptAt: now,
    raw: i.raw,
    lastError: null,
    receivedAt: now,
    processedAt: null,
  }));

  try {
    const r = await (await col()).insertMany(docs as InboundEventDoc[], { ordered: false });
    return { accepted: r.insertedCount, duplicated: items.length - r.insertedCount, eventIds: items.map((i) => i.eventId) };
  } catch (e) {
    const err = e as { code?: number; writeErrors?: unknown[]; result?: { insertedCount?: number }; insertedCount?: number };
    const isDuplicateOnly =
      err.code === 11000 || (Array.isArray(err.writeErrors) && err.writeErrors.every((w) => (w as { code?: number }).code === 11000));

    if (!isDuplicateOnly) throw e;

    const accepted = err.result?.insertedCount ?? err.insertedCount ?? 0;
    return { accepted, duplicated: items.length - accepted, eventIds: items.map((i) => i.eventId) };
  }
}

export interface ClaimOptions {
  limit?: number;
  /** ดึงเฉพาะที่ค้างเกิน N วินาที — WF-D ใช้กันไม่ให้แย่งงานที่ WF-A กำลังทำอยู่ */
  olderThanSec?: number;
  provider?: string;
}

/**
 * จองงานแบบกันสองคนหยิบชิ้นเดียวกัน
 *
 * ทำสองขั้นเพราะ updateMany ไม่มี limit:
 *   1. find id ที่ยัง pending (limit)
 *   2. updateMany เฉพาะ id ชุดนั้น **ที่ยัง pending อยู่** → worker ที่มาทีหลังจะ match 0
 * แล้วอ่านกลับด้วย claimId ที่เพิ่งตีตรา — ได้เฉพาะที่ตัวเองจองสำเร็จจริง
 */
export async function claimPending(opts: ClaimOptions = {}): Promise<InboundEventDoc[]> {
  const { limit = 100, olderThanSec = 0, provider } = opts;
  const c = await col();
  const now = new Date();
  const cutoff = new Date(now.getTime() - olderThanSec * 1000);

  const filter = {
    status: "pending" as InboundEventStatus,
    nextAttemptAt: { $lte: now },
    receivedAt: { $lte: cutoff },
    ...(provider ? { provider } : {}),
  };

  const candidates = await c.find(filter, { projection: { _id: 1 }, limit, sort: { receivedAt: 1 } }).toArray();
  if (candidates.length === 0) return [];

  const claimId = newId("job");
  const r = await c.updateMany(
    { _id: { $in: candidates.map((d) => d._id) }, status: "pending" },
    { $set: { status: "processing", claimId, claimedAt: now } }
  );
  if (r.modifiedCount === 0) return [];

  return c.find({ claimId }).toArray();
}

/** ปลด lease ของงานที่ค้างสถานะ processing นานเกินไป (worker ตายกลางคัน) */
export async function releaseStaleClaims(provider?: string): Promise<number> {
  const cutoff = new Date(Date.now() - CLAIM_LEASE_MS);
  const r = await (await col()).updateMany(
    { status: "processing", claimedAt: { $lte: cutoff }, ...(provider ? { provider } : {}) },
    { $set: { status: "pending" }, $unset: { claimId: "", claimedAt: "" } }
  );
  if (r.modifiedCount > 0) log.warn("ปลด claim ที่ค้าง", { count: r.modifiedCount });
  return r.modifiedCount;
}

export async function ackEvents(eventIds: string[], provider = "line"): Promise<number> {
  if (eventIds.length === 0) return 0;
  const r = await (await col()).updateMany(
    { eventId: { $in: eventIds }, provider },
    { $set: { status: "done", processedAt: new Date(), lastError: null } }
  );
  return r.modifiedCount;
}

/** ล้มเหลว → นับ attempt + ตั้งเวลา retry แบบ exponential; ครบเพดานแล้วโยนเข้า dead letter */
export async function failEvent(eventId: string, error: string, provider = "line"): Promise<InboundEventStatus> {
  const c = await col();
  const doc = await c.findOne({ eventId, provider });
  if (!doc) return "dead";

  const attempts = doc.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await c.updateOne({ eventId, provider }, { $set: { status: "dead", attempts, lastError: error, processedAt: new Date() } });
    log.error("event เข้า dead letter", { eventId, provider, attempts });
    return "dead";
  }

  const delaySec = Math.min(BASE_BACKOFF_SEC * 2 ** (attempts - 1), 1800);
  await c.updateOne(
    { eventId, provider },
    { $set: { status: "pending", attempts, lastError: error, nextAttemptAt: new Date(Date.now() + delaySec * 1000) }, $unset: { claimId: "", claimedAt: "" } }
  );
  return "pending";
}

export async function queueStats(provider?: string): Promise<Record<InboundEventStatus, number>> {
  const pipeline = [
    ...(provider ? [{ $match: { provider } }] : []),
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ];
  const rows = await (await col())
    .aggregate<{ _id: InboundEventStatus; n: number }>(pipeline)
    .toArray();
  const out = { pending: 0, processing: 0, done: 0, failed: 0, dead: 0 } as Record<InboundEventStatus, number>;
  for (const r of rows) out[r._id] = r.n;
  return out;
}
