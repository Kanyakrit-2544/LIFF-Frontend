import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getDb, closeClient } from "../src/db/client";
import { ensureIndexes } from "../src/db/indexes";
import { enqueueEvents, claimPending, ackEvents, failEvent, queueStats, releaseStaleClaims } from "../src/events/inbox";
import { COLLECTIONS } from "../src/db/models";

/**
 * Integration test — ต้องมี MongoDB จริง (npm run db:test:up)
 * unique index กับ race condition พิสูจน์ด้วย mock ไม่ได้ ต้องยิงของจริงเท่านั้น
 */
let available = false;
const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const runId = `vitest-inbox-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const provider = runId;
const eventId = (id: string) => `${runId}-${id}`;

beforeAll(async () => {
  if (!runIntegration) {
    console.warn("\n⚠️  ข้าม integration test — ตั้ง RUN_MONGO_INTEGRATION=true เพื่อยิง MongoDB จริง\n");
    return;
  }
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    await ensureIndexes(db);
    available = true;
  } catch (e) {
    throw new Error(`เชื่อมต่อ MongoDB สำหรับ integration test ไม่สำเร็จ: ${(e as Error).message}`);
  }
}, 30_000);

afterAll(async () => {
  if (available) await cleanup();
  await closeClient();
});

beforeEach(async () => {
  if (available) await cleanup();
});

async function cleanup() {
  await (await getDb()).collection(COLLECTIONS.inboundEvents).deleteMany({ provider, eventId: { $regex: `^${runId}-` } });
}

const channelId = `${runId}-channel`;
const ev = (id: string) => ({ eventId: eventId(id), provider, channelId, raw: { type: "follow", webhookEventId: eventId(id) } });

describe.runIf(runIntegration)("inbound outbox", () => {
  it("enqueue event ใหม่", async () => {
    const r = await enqueueEvents([ev("E1"), ev("E2")]);
    expect(r.accepted).toBe(2);
    expect(r.duplicated).toBe(0);
    const doc = await (await getDb()).collection(COLLECTIONS.inboundEvents).findOne({ eventId: eventId("E1"), provider });
    expect(doc?.channelId).toBe(channelId);
  });

  it("ยิง payload เดิมซ้ำ 3 ครั้ง → มี record เดียว (idempotent ที่ระดับ database)", async () => {
    await enqueueEvents([ev("E1")]);
    await enqueueEvents([ev("E1")]);
    const third = await enqueueEvents([ev("E1")]);
    expect(third.accepted).toBe(0);
    expect(third.duplicated).toBe(1);
    expect((await queueStats(provider)).pending).toBe(1);
  });

  it("ชุดที่มีทั้งซ้ำและใหม่ → ตัวใหม่ต้องเข้าได้ (ordered:false)", async () => {
    await enqueueEvents([ev("E1"), ev("E2")]);
    const r = await enqueueEvents([ev("E1"), ev("E3"), ev("E2"), ev("E4")]);
    expect(r.accepted).toBe(2);
    expect(r.duplicated).toBe(2);
    expect((await queueStats(provider)).pending).toBe(4);
  });

  it("ยิงพร้อมกันหลาย request ด้วย eventId เดียว → เข้าได้ตัวเดียว", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => enqueueEvents([ev("RACE")])));
    expect(results.reduce((s, r) => s + r.accepted, 0)).toBe(1);
    expect((await queueStats(provider)).pending).toBe(1);
  });

  it("enqueue ชุดว่างไม่พัง", async () => {
    expect((await enqueueEvents([])).accepted).toBe(0);
  });

  it("claim แล้วสถานะเปลี่ยนเป็น processing", async () => {
    await enqueueEvents([ev("E1"), ev("E2")]);
    const claimed = await claimPending({ limit: 10, provider });
    expect(claimed).toHaveLength(2);
    expect(claimed.every((c) => c.status === "processing" && c.claimId)).toBe(true);
    expect(claimed.every((c) => c.channelId === channelId)).toBe(true);
    expect((await queueStats(provider)).pending).toBe(0);
  });

  it("worker สองตัว claim พร้อมกัน → ไม่ได้งานชิ้นเดียวกัน", async () => {
    await enqueueEvents(Array.from({ length: 20 }, (_, i) => ev(`E${i}`)));
    const [a, b] = await Promise.all([claimPending({ limit: 20, provider }), claimPending({ limit: 20, provider })]);
    const ids = [...a.map((d) => d.eventId), ...b.map((d) => d.eventId)];
    expect(new Set(ids).size).toBe(ids.length); // ไม่ทับกันเลย
    expect(ids.length).toBe(20);
  });

  it("claim เคารพ limit", async () => {
    await enqueueEvents(Array.from({ length: 10 }, (_, i) => ev(`E${i}`)));
    expect(await claimPending({ limit: 3, provider })).toHaveLength(3);
  });

  it("olderThanSec กันไม่ให้ reconciler แย่งงานที่เพิ่งเข้ามา", async () => {
    await enqueueEvents([ev("FRESH")]);
    expect(await claimPending({ olderThanSec: 60, provider })).toHaveLength(0);
    expect(await claimPending({ olderThanSec: 0, provider })).toHaveLength(1);
  });

  it("ack แล้วสถานะเป็น done และไม่ถูก claim อีก", async () => {
    await enqueueEvents([ev("E1")]);
    await claimPending({ provider });
    expect(await ackEvents([eventId("E1")], provider)).toBe(1);
    expect((await queueStats(provider)).done).toBe(1);
    expect(await claimPending({ provider })).toHaveLength(0);
  });

  it("fail → กลับเป็น pending พร้อม backoff ที่โตขึ้น", async () => {
    await enqueueEvents([ev("E1")]);
    await claimPending({ provider });

    const c = (await getDb()).collection(COLLECTIONS.inboundEvents);
    expect(await failEvent(eventId("E1"), "n8n timeout", provider)).toBe("pending");

    const doc = await c.findOne({ eventId: eventId("E1") });
    expect(doc?.attempts).toBe(1);
    expect(doc?.lastError).toBe("n8n timeout");
    expect(doc!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now()); // ไม่ให้ยิงรัวทันที

    await failEvent(eventId("E1"), "อีกรอบ", provider);
    const after2 = await c.findOne({ eventId: eventId("E1") });
    expect(after2!.nextAttemptAt.getTime()).toBeGreaterThan(doc!.nextAttemptAt.getTime());
  });

  it("fail ครบ 5 ครั้ง → เข้า dead letter ไม่วนซ้ำไม่รู้จบ", async () => {
    await enqueueEvents([ev("E1")]);
    let status = "pending";
    for (let i = 0; i < 5; i++) status = await failEvent(eventId("E1"), `รอบ ${i}`, provider);
    expect(status).toBe("dead");
    expect((await queueStats(provider)).dead).toBe(1);
    expect(await claimPending({ olderThanSec: 0, provider })).toHaveLength(0);
  });

  it("event ที่ nextAttemptAt ยังไม่ถึงเวลา จะยังไม่ถูก claim", async () => {
    await enqueueEvents([ev("E1")]);
    await failEvent(eventId("E1"), "ยังไม่ถึงเวลา", provider);
    expect(await claimPending({ olderThanSec: 0, provider })).toHaveLength(0);
  });

  it("งานที่ค้าง processing เกิน lease ถูกปลดกลับมาทำใหม่ (worker ตายกลางคัน)", async () => {
    await enqueueEvents([ev("E1")]);
    await claimPending({ provider });
    const c = (await getDb()).collection(COLLECTIONS.inboundEvents);
    await c.updateOne({ eventId: eventId("E1") }, { $set: { claimedAt: new Date(Date.now() - 10 * 60 * 1000) } });

    expect(await releaseStaleClaims(provider)).toBe(1);
    expect(await claimPending({ olderThanSec: 0, provider })).toHaveLength(1);
  });

  it("ack eventId ที่ไม่มีอยู่ ไม่พัง", async () => {
    expect(await ackEvents(["ไม่มีจริง"])).toBe(0);
    expect(await ackEvents([])).toBe(0);
  });
});
