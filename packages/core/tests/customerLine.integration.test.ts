import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { closeClient, getDb } from "../src/db/client";
import { ensureIndexes } from "../src/db/indexes";
import { COLLECTIONS, type CustomerDoc, type IdentityDoc, type InteractionDoc } from "../src/db/models";
import { upsertFromLine } from "../src/customers/upsertFromLine";

let available = false;
const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const runId = `vitest-s3-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const eventId = (id: string) => `${runId}-${id}`;

beforeAll(async () => {
  if (!runIntegration) {
    console.warn("\n⚠️  ข้าม S3 integration test — ตั้ง RUN_MONGO_INTEGRATION=true เพื่อยิง MongoDB จริง\n");
    return;
  }
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    await ensureIndexes(db);
    available = true;
  } catch (e) {
    throw new Error(`เชื่อมต่อ MongoDB สำหรับ S3 integration test ไม่สำเร็จ: ${(e as Error).message}`);
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
  const db = await getDb();
  const identities = await db.collection(COLLECTIONS.identities).find({ channelId }).toArray();
  const customerIds = identities.map((i) => i.customerId);
  await Promise.all([
    customerIds.length ? db.collection(COLLECTIONS.customers).deleteMany({ _id: { $in: customerIds } }) : Promise.resolve(),
    db.collection(COLLECTIONS.identities).deleteMany({ channelId }),
    db.collection(COLLECTIONS.interactions).deleteMany({ sourceEventId: { $regex: `^${runId}-` } }),
  ]);
}

const channelId = `${runId}-line-channel-dev`;
const lineUserId = "U-test-user";

function at(iso: string) {
  return new Date(iso);
}

async function customers() {
  return (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers);
}

async function interactions() {
  return (await getDb()).collection<InteractionDoc>(COLLECTIONS.interactions);
}

describe.runIf(runIntegration)("S3 upsertFromLine", () => {
  it("follow ใหม่สร้าง customer, identity และ interaction แบบ idempotent", async () => {
    const occurredAt = at("2026-08-26T04:11:00.000Z");
    const first = await upsertFromLine({
      eventId: eventId("EV-FOLLOW-1"),
      channelId,
      lineUserId,
      eventType: "follow",
      occurredAt,
      profile: { displayName: "Somchai", pictureUrl: "https://example.test/p.png" },
    });
    const duplicate = await upsertFromLine({
      eventId: eventId("EV-FOLLOW-1"),
      channelId,
      lineUserId,
      eventType: "follow",
      occurredAt,
      profile: { displayName: "Somchai 2" },
    });

    expect(first.isNew).toBe(true);
    expect(first.interactionCreated).toBe(true);
    expect(duplicate.customerId).toBe(first.customerId);
    expect(duplicate.isNew).toBe(false);
    expect(duplicate.interactionCreated).toBe(false);

    const db = await getDb();
    expect(await db.collection(COLLECTIONS.identities).countDocuments({ provider: "line", channelId, externalId: lineUserId })).toBe(1);
    expect(await (await interactions()).countDocuments({ customerId: first.customerId, type: "follow" })).toBe(1);

    const customer = await (await customers()).findOne({ _id: first.customerId });
    expect(customer?.firstInteractionAt?.toISOString()).toBe(occurredAt.toISOString());
    expect(customer?.firstMessageAt).toBeUndefined();
    expect(customer?.sheetSync.dirty).toBe(true);
    expect(customer?.aiSync.dirty).toBe(true);
    expect(customer?.lineDisplayName).toBe("Somchai 2");
  });

  it("firstInteractionAt ใช้เวลาที่เก่าสุดแบบ atomic แม้ event มาทีหลัง", async () => {
    const messageAt = at("2026-08-26T04:10:00.000Z");
    const followAt = at("2026-08-26T04:11:00.000Z");

    const message = await upsertFromLine({
      eventId: eventId("EV-MSG-FIRST"),
      channelId,
      lineUserId,
      eventType: "message",
      occurredAt: messageAt,
      message: { type: "text" },
    });
    await upsertFromLine({
      eventId: eventId("EV-FOLLOW-LATER"),
      channelId,
      lineUserId,
      eventType: "follow",
      occurredAt: followAt,
    });

    const customer = await (await customers()).findOne({ _id: message.customerId });
    expect(customer?.firstInteractionAt?.toISOString()).toBe(messageAt.toISOString());
    expect(customer?.firstMessageAt?.toISOString()).toBe(messageAt.toISOString());
    expect(await (await interactions()).countDocuments({ customerId: message.customerId, type: "first_message" })).toBe(1);
    expect(await (await interactions()).countDocuments({ customerId: message.customerId, type: "follow" })).toBe(1);
  });

  it("ทักครั้งที่สองไม่สร้าง interaction และไม่ตั้ง dirty ใหม่ แต่ lastInteractionAt อัปเดต", async () => {
    const firstAt = at("2026-08-26T04:12:00.000Z");
    const secondAt = at("2026-08-26T04:13:00.000Z");
    const first = await upsertFromLine({
      eventId: eventId("EV-MSG-1"),
      channelId,
      lineUserId,
      eventType: "message",
      occurredAt: firstAt,
      message: { type: "text" },
    });
    await (await customers()).updateOne({
      _id: first.customerId,
    }, {
      $set: { "sheetSync.dirty": false, "aiSync.dirty": false, customerStatus: "customer" },
    });

    const second = await upsertFromLine({
      eventId: eventId("EV-MSG-2"),
      channelId,
      lineUserId,
      eventType: "message",
      occurredAt: secondAt,
      message: { type: "text" },
    });

    expect(second.interactionCreated).toBe(false);
    expect(second.milestone).toBeNull();
    expect(await (await interactions()).countDocuments({ customerId: first.customerId, type: "first_message" })).toBe(1);
    expect(await (await interactions()).countDocuments({ customerId: first.customerId, type: "message" as never })).toBe(0);

    const customer = await (await customers()).findOne({ _id: first.customerId });
    expect(customer?.firstMessageAt?.toISOString()).toBe(firstAt.toISOString());
    expect(customer?.lastInteractionAt?.toISOString()).toBe(secondAt.toISOString());
    expect(customer?.sheetSync.dirty).toBe(false);
    expect(customer?.aiSync.dirty).toBe(false);
    expect(customer?.customerStatus).toBe("customer");
  });

  it("ส่งหลายข้อความพร้อมกัน สร้าง first_message ได้แค่ 1 record", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        upsertFromLine({
          eventId: eventId(`EV-RACE-${i}`),
          channelId,
          lineUserId,
          eventType: "message",
          occurredAt: at(`2026-08-26T04:2${i}:00.000Z`),
          message: { type: "text" },
        })
      )
    );

    const customerIds = new Set(results.map((r) => r.customerId));
    expect(customerIds.size).toBe(1);
    expect(results.filter((r) => r.interactionCreated).length).toBe(1);

    const customerId = results[0]!.customerId;
    expect(await (await interactions()).countDocuments({ customerId, type: "first_message" })).toBe(1);
    expect(await (await interactions()).countDocuments({ customerId, type: "message" as never })).toBe(0);
    expect(await (await getDb()).collection(COLLECTIONS.identities).countDocuments({ provider: "line", channelId, externalId: lineUserId })).toBe(1);
  });

  it("sourceEventId ซ้ำไม่ error และไม่เพิ่ม counters", async () => {
    const first = await upsertFromLine({
      eventId: eventId("EV-IDEMPOTENT"),
      channelId,
      lineUserId,
      eventType: "follow",
      occurredAt: at("2026-08-26T04:30:00.000Z"),
    });
    await upsertFromLine({
      eventId: eventId("EV-IDEMPOTENT"),
      channelId,
      lineUserId,
      eventType: "follow",
      occurredAt: at("2026-08-26T04:30:00.000Z"),
    });

    const customer = await (await customers()).findOne({ _id: first.customerId });
    expect(customer?.counters.milestones).toBe(1);
    expect(await (await interactions()).countDocuments({ sourceEventId: eventId("EV-IDEMPOTENT") })).toBe(1);
  });
});

/**
 * Regression — บั๊กที่เจอตอนรีวิว S3
 * เดิม updateLineCustomer เขียนทั้ง lineDisplayName และ displayName จากโปรไฟล์ LINE
 * ทำให้ชื่อจริงที่ลูกค้ากรอกในฟอร์ม LIFF ถูกลบทิ้งเมื่อมี event จาก LINE เข้ามาทีหลัง
 */
describe.runIf(runIntegration)("ชื่อลูกค้าต้องไม่ถูกทับด้วยชื่อ LINE", () => {
  const userId = "Uregress0000000000000000000000001";
  const customers = async () => (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers);

  it("ข้อความและ follow ที่ตามมา ไม่ลบชื่อจริงที่ลูกค้ากรอกเอง", async () => {
    await upsertFromLine({
      eventId: eventId("rg1"), channelId, lineUserId: userId, eventType: "follow",
      occurredAt: new Date("2026-08-01T10:00:00Z"), profile: { displayName: "Somchai", pictureUrl: "https://x/a.jpg" },
    });

    const col = await customers();
    const identity = await (await getDb()).collection<IdentityDoc>(COLLECTIONS.identities).findOne({ externalId: userId });
    const created = await col.findOne({ _id: identity!.customerId });
    // ลูกค้ากรอกชื่อจริงผ่านฟอร์ม LIFF
    await col.updateOne({ _id: created!._id }, { $set: { displayName: "สมชาย ใจดี" } });

    for (const [i, type] of (["message", "message", "follow"] as const).entries()) {
      await upsertFromLine({
        eventId: eventId(`rg-after-${i}`), channelId, lineUserId: userId, eventType: type,
        occurredAt: new Date(`2026-08-0${i + 2}T10:00:00Z`),
        profile: { displayName: "Somchai", pictureUrl: "https://x/b.jpg" },
      });
      const after = await col.findOne({ _id: created!._id });
      expect(after?.displayName, `หลัง ${type} ครั้งที่ ${i + 1}`).toBe("สมชาย ใจดี");
    }

    // แต่ lineDisplayName ต้องยังตามค่าจาก LINE
    const final = await col.findOne({ _id: created!._id });
    expect(final?.lineDisplayName).toBe("Somchai");
    expect(final?.pictureUrl).toBe("https://x/b.jpg");
  });

  it("โปรไฟล์ที่ดึงได้ครั้งแรกตอนทัก ต้องถูกบันทึก (ตอน follow อาจโดน 404)", async () => {
    const uid = "Uregress0000000000000000000000002";
    await upsertFromLine({
      eventId: eventId("rg2a"), channelId, lineUserId: uid, eventType: "follow",
      occurredAt: new Date("2026-08-01T10:00:00Z"), profile: { displayName: null, pictureUrl: null },
    });
    await upsertFromLine({
      eventId: eventId("rg2b"), channelId, lineUserId: uid, eventType: "message",
      occurredAt: new Date("2026-08-02T10:00:00Z"), profile: { displayName: "ชื่อที่เพิ่งดึงได้", pictureUrl: "https://x/new.jpg" },
    });

    const col = await customers();
    const ids = await (await getDb()).collection(COLLECTIONS.identities).findOne({ externalId: uid });
    const doc = await col.findOne({ _id: ids!.customerId });
    expect(doc?.lineDisplayName).toBe("ชื่อที่เพิ่งดึงได้");
    expect(doc?.pictureUrl).toBe("https://x/new.jpg");
    // ยังว่างอยู่ → เติมให้ได้
    expect(doc?.displayName).toBe("ชื่อที่เพิ่งดึงได้");
  });
});
