import { MongoClient } from "mongodb";
import { signInternal, signLineBody } from "../packages/core/src";

const BASE = process.argv[2] ?? "http://localhost:3000";
const runId = `smoke-s4-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const destination = `U${runId.replace(/[^a-zA-Z0-9]/g, "").padEnd(32, "0").slice(0, 32)}`;
const lineUserId = `U${runId.replace(/[^a-zA-Z0-9]/g, "").padEnd(32, "1").slice(0, 32)}`;
const eventId = `${runId}-follow`;

for (const key of ["LINE_CHANNEL_SECRET", "INTERNAL_HMAC_SECRET", "MONGODB_URI"] as const) {
  if (!process.env[key]) throw new Error(`ไม่พบ ${key}`);
}

const dbName = process.env.MONGODB_DB || "line_crm";
const lineSecret = process.env.LINE_CHANNEL_SECRET!;
const internalSecret = process.env.INTERNAL_HMAC_SECRET!;

function lineBody() {
  return JSON.stringify({
    destination,
    events: [
      {
        type: "follow",
        webhookEventId: eventId,
        deliveryContext: { isRedelivery: false },
        timestamp: Date.now(),
        source: { type: "user", userId: lineUserId },
        replyToken: `rt-${runId}`,
      },
    ],
  });
}

function internalRequest(path: string, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature": signInternal(raw, ts, internalSecret),
      "x-timestamp": String(ts),
    },
    body: raw,
  });
}

async function postLine(raw: string) {
  return fetch(`${BASE}/api/webhook/line`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": signLineBody(raw, lineSecret) },
    body: raw,
  });
}

async function readJson(res: Response) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

function step(name: string, passed: boolean, detail?: unknown) {
  console.log(`${passed ? "✅" : "❌"} ${name}${passed ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!passed) process.exitCode = 1;
}

async function main() {
  console.log(`S4 smoke: ${BASE}\n`);
  const client = new MongoClient(process.env.MONGODB_URI!, {
    compressors: ["zstd", "zlib"],
    serverSelectionTimeoutMS: 8_000,
  });
  await client.connect();
  const db = client.db(dbName);

  async function cleanup() {
    const identities = await db.collection("identities").find({ provider: "line", channelId: destination, externalId: lineUserId }).toArray();
    const customerIds = identities.map((i) => i.customerId);
    await Promise.all([
      db.collection("inbound_events").deleteMany({ provider: "line", eventId }),
      db.collection("interactions").deleteMany({ sourceEventId: eventId }),
      db.collection("identities").deleteMany({ provider: "line", channelId: destination, externalId: lineUserId }),
      customerIds.length ? db.collection("customers").deleteMany({ _id: { $in: customerIds } }) : Promise.resolve(),
    ]);
  }

  try {
    await cleanup();
    const unsafePending = await db.collection("inbound_events").countDocuments({
      provider: "line",
      eventId: { $ne: eventId },
      status: "pending",
    });
    const unsafeStaleProcessing = await db.collection("inbound_events").countDocuments({
      provider: "line",
      eventId: { $ne: eventId },
      status: "processing",
      claimedAt: { $lte: new Date(Date.now() - 5 * 60 * 1000) },
    });
    if (unsafePending || unsafeStaleProcessing) {
      step("ไม่เริ่ม smoke เพราะมี line events ค้างใน dev queue", false, { unsafePending, unsafeStaleProcessing });
      return;
    }

    const raw = lineBody();
    const webhook = await postLine(raw);
    const webhookJson = await readJson(webhook);
    step("1. webhook รับ follow event", webhook.status === 200 && webhookJson.accepted === 1, { status: webhook.status, webhookJson });

    const pending = await internalRequest("/api/internal/events/pending", { provider: "line", limit: 50, olderThanSec: 0 });
    const pendingJson = await readJson(pending);
    const event = pendingJson.events?.[0];
    step("2. pending คืน event พร้อม channelId", pending.status === 200 && pendingJson.claimed === 1 && event?.channelId === destination, {
      status: pending.status,
      pendingJson,
    });
    if (!event) return;

    const upsert = await internalRequest("/api/internal/customers/upsert-from-line", {
      eventId: event.eventId,
      channelId: event.channelId,
      lineUserId: event.lineUserId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      profile: { displayName: "S4 Smoke", pictureUrl: null },
      message: { type: event.messageType },
    });
    const upsertJson = await readJson(upsert);
    step("3. upsert สร้าง customer", upsert.status === 200 && upsertJson.ok === true && upsertJson.interactionCreated === true, {
      status: upsert.status,
      upsertJson,
    });

    const ack = await internalRequest("/api/internal/events/ack", {
      provider: "line",
      results: [{ eventId, status: "done", customerId: upsertJson.customerId }],
    });
    const ackJson = await readJson(ack);
    step("4. ack ปิด event", ack.status === 200 && ackJson.done === 1, { status: ack.status, ackJson });

    const [customers, identities, interactions, inbound] = await Promise.all([
      db.collection("customers").countDocuments({ _id: upsertJson.customerId }),
      db.collection("identities").countDocuments({ provider: "line", channelId: destination, externalId: lineUserId }),
      db.collection("interactions").countDocuments({ sourceEventId: eventId, type: "follow" }),
      db.collection("inbound_events").countDocuments({ provider: "line", eventId, status: "done" }),
    ]);
    step("5. Mongo มี customer/identity/interaction/inbound ครบ", customers === 1 && identities === 1 && interactions === 1 && inbound === 1, {
      customers,
      identities,
      interactions,
      inbound,
    });

    const duplicate = await postLine(raw);
    const duplicateJson = await readJson(duplicate);
    const [customerAfterDup, interactionAfterDup] = await Promise.all([
      db.collection("customers").countDocuments({ _id: upsertJson.customerId }),
      db.collection("interactions").countDocuments({ sourceEventId: eventId, type: "follow" }),
    ]);
    step(
      "6. webhook ซ้ำไม่สร้างลูกค้า/interaction เพิ่ม",
      duplicate.status === 200 && duplicateJson.duplicated === 1 && customerAfterDup === 1 && interactionAfterDup === 1,
      { status: duplicate.status, duplicateJson, customerAfterDup, interactionAfterDup }
    );
  } finally {
    await cleanup();
    await client.close();
  }
}

main().catch((e) => {
  console.error("❌ smoke:s4 ล้มเหลว", e.message);
  process.exit(1);
});
