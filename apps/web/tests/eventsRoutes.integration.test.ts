import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ackEvents, closeClient, COLLECTIONS, enqueueEvents, ensureIndexes, getDb, signInternal, type InboundEventDoc } from "@line-crm/core";
import { POST as pendingPost } from "../app/api/internal/events/pending/route";
import { POST as ackPost } from "../app/api/internal/events/ack/route";
import { POST as deadPost } from "../app/api/internal/events/dead/route";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const runId = `vitest-s4-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const provider = runId;
const channelId = `${runId}-channel`;

let available = false;

beforeAll(async () => {
  if (!runIntegration) {
    console.warn("\n⚠️  ข้าม S4 web integration test — ตั้ง RUN_MONGO_INTEGRATION=true เพื่อยิง MongoDB จริง\n");
    return;
  }
  const db = await getDb();
  await db.command({ ping: 1 });
  await ensureIndexes(db);
  available = true;
}, 30_000);

beforeEach(async () => {
  if (available) await cleanup();
});

afterAll(async () => {
  if (available) await cleanup();
  await closeClient();
});

async function cleanup() {
  const db = await getDb();
  await Promise.all([
    db.collection(COLLECTIONS.inboundEvents).deleteMany({ provider }),
    db.collection(COLLECTIONS.auditLogs).deleteMany({ actor: { $regex: `^n8n:${runId}` } }),
  ]);
}

function eventId(id: string) {
  return `${runId}-${id}`;
}

function lineRaw(id: string, opts: { type?: string; source?: Record<string, unknown>; messageType?: string; timestamp?: number } = {}) {
  const type = opts.type ?? "follow";
  return {
    type,
    webhookEventId: eventId(id),
    timestamp: opts.timestamp ?? Date.parse("2026-08-26T04:11:00.000Z"),
    source: opts.source ?? { type: "user", userId: `${runId}-user-${id}` },
    ...(type === "message" ? { message: { id: `M-${id}`, type: opts.messageType ?? "text" } } : {}),
  };
}

async function addEvent(id: string, opts: { channel?: string | null; raw?: Record<string, unknown> } = {}) {
  await enqueueEvents([
    {
      eventId: eventId(id),
      provider,
      channelId: opts.channel === undefined ? channelId : opts.channel,
      raw: opts.raw ?? lineRaw(id),
    },
  ]);
}

function signed(body: Record<string, unknown>, ts = Math.floor(Date.now() / 1000), secret = process.env.INTERNAL_HMAC_SECRET!) {
  const raw = JSON.stringify(body);
  return new Request("http://test.local/api/internal/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature": signInternal(raw, ts, secret),
      "x-timestamp": String(ts),
    },
    body: raw,
  });
}

function unsigned(body: Record<string, unknown>) {
  return new Request("http://test.local/api/internal/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function read(res: Response) {
  return { status: res.status, json: await res.json() };
}

async function inbound(id: string) {
  return (await getDb()).collection<InboundEventDoc>(COLLECTIONS.inboundEvents).findOne({ eventId: eventId(id), provider });
}

describe.runIf(runIntegration)("S4 internal event routes", () => {
  it("/events/pending ไม่มี HMAC → 401", async () => {
    const res = await read(await pendingPost(unsigned({ provider })));
    expect(res.status).toBe(401);
  });

  it("/events/pending timestamp เก่า 10 นาที → 401", async () => {
    const old = Math.floor(Date.now() / 1000) - 600;
    const res = await read(await pendingPost(signed({ provider }, old)));
    expect(res.status).toBe(401);
  });

  it("คิวว่าง → claimed 0", async () => {
    const res = await read(await pendingPost(signed({ provider })));
    expect(res.status).toBe(200);
    expect(res.json.claimed).toBe(0);
    expect(res.json.events).toEqual([]);
  });

  it("มี 3 event → map เป็น payload พร้อมใช้", async () => {
    await addEvent("a");
    await addEvent("b", { raw: lineRaw("b", { type: "message", messageType: "text" }) });
    await addEvent("c", { raw: lineRaw("c", { type: "unfollow" }) });

    const res = await read(await pendingPost(signed({ provider, limit: 50 })));
    expect(res.status).toBe(200);
    expect(res.json.claimed).toBe(3);
    expect(res.json.skipped).toEqual({ noChannelId: 0, notUserEvent: 0, unsupportedType: 0 });
    for (const event of res.json.events) {
      expect(event.channelId).toBe(channelId);
      expect(event.lineUserId).toMatch(runId);
      expect(["follow", "message", "unfollow"]).toContain(event.eventType);
      expect(event.occurredAt).toBe("2026-08-26T04:11:00.000Z");
    }
    expect(res.json.events.find((e: any) => e.eventId === eventId("b")).messageType).toBe("text");
  });

  it("channelId null → skipped และ fail/backoff", async () => {
    await addEvent("no-channel", { channel: null });
    const res = await read(await pendingPost(signed({ provider })));
    expect(res.status).toBe(200);
    expect(res.json.claimed).toBe(0);
    expect(res.json.skipped.noChannelId).toBe(1);
    const doc = await inbound("no-channel");
    expect(doc?.status).toBe("pending");
    expect(doc?.attempts).toBe(1);
  });

  it("event จากกลุ่ม → skipped และ done", async () => {
    await addEvent("group", { raw: lineRaw("group", { source: { type: "group", groupId: "G1" } }) });
    const res = await read(await pendingPost(signed({ provider })));
    expect(res.status).toBe(200);
    expect(res.json.skipped.notUserEvent).toBe(1);
    expect((await inbound("group"))?.status).toBe("done");
  });

  it("unsupported event type → skipped และ done", async () => {
    await addEvent("join", { raw: lineRaw("join", { type: "join" }) });
    const res = await read(await pendingPost(signed({ provider })));
    expect(res.status).toBe(200);
    expect(res.json.skipped.unsupportedType).toBe(1);
    expect((await inbound("join"))?.status).toBe("done");
  });

  it("เรียก pending ซ้ำทันที → รอบสองไม่มีงาน", async () => {
    await addEvent("once");
    expect((await read(await pendingPost(signed({ provider })))).json.claimed).toBe(1);
    expect((await read(await pendingPost(signed({ provider })))).json.claimed).toBe(0);
  });

  it("limit เกิน 200 ถูกบีบเหลือ 200", async () => {
    await enqueueEvents(
      Array.from({ length: 205 }, (_, i) => ({
        eventId: eventId(`many-${i}`),
        provider,
        channelId,
        raw: lineRaw(`many-${i}`),
      }))
    );
    const res = await read(await pendingPost(signed({ provider, limit: 999 })));
    expect(res.status).toBe(200);
    expect(res.json.events).toHaveLength(200);
  });

  it("/events/ack done → status done", async () => {
    await addEvent("done");
    const res = await read(await ackPost(signed({ provider, results: [{ eventId: eventId("done"), status: "done" }] })));
    expect(res.status).toBe(200);
    expect(res.json.done).toBe(1);
    expect((await inbound("done"))?.status).toBe("done");
  });

  it("/events/ack failed → pending พร้อม backoff", async () => {
    await addEvent("failed");
    const res = await read(await ackPost(signed({ provider, results: [{ eventId: eventId("failed"), status: "failed", error: "upsert 500" }] })));
    expect(res.status).toBe(200);
    expect(res.json.failed).toBe(1);
    const doc = await inbound("failed");
    expect(doc?.status).toBe("pending");
    expect(doc?.attempts).toBe(1);
    expect(doc!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("/events/ack failed ครบ 5 ครั้ง → dead", async () => {
    await addEvent("dead");
    for (let i = 0; i < 5; i++) {
      await ackPost(signed({ provider, results: [{ eventId: eventId("dead"), status: "failed", error: `round ${i}` }] }));
    }
    expect((await inbound("dead"))?.status).toBe("dead");
  });

  it("/events/ack eventId ไม่มีจริง → 200", async () => {
    const res = await read(await ackPost(signed({ provider, results: [{ eventId: eventId("missing"), status: "done" }] })));
    expect(res.status).toBe(200);
    expect(res.json.done).toBe(0);
  });

  it("/events/ack redact error ก่อนเขียน lastError", async () => {
    await addEvent("pii");
    await ackPost(signed({ provider, results: [{ eventId: eventId("pii"), status: "failed", error: "โทร 0812345678" }] }));
    const doc = await inbound("pii");
    expect(doc?.lastError).not.toContain("0812345678");
    expect(doc?.lastError).toContain("[PHONE]");
  });

  it("/events/dead คืน metadata และไม่มี raw", async () => {
    await addEvent("dead-list");
    for (let i = 0; i < 5; i++) {
      await ackPost(signed({ provider, results: [{ eventId: eventId("dead-list"), status: "failed", error: `round ${i}` }] }));
    }
    const res = await read(await deadPost(signed({ provider, limit: 10 })));
    expect(res.status).toBe(200);
    expect(res.json.count).toBe(1);
    expect(res.json.events[0].eventId).toBe(eventId("dead-list"));
    expect(res.json.events[0].raw).toBeUndefined();
  });
});
