import { MongoClient } from "mongodb";
import {
  COLLECTIONS,
  partnerSecretFor,
  signInternal,
  type PurchaseDoc,
  type PurchaseItemDoc,
} from "../packages/core/src/index";

const baseUrl = process.argv[2] ?? "http://localhost:3000";
const partnerId = process.env.PARTNER_SMOKE_ID ?? "tagger";
const secret = partnerSecretFor(partnerId);
const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB ?? "line_crm_dev";

if (!secret) throw new Error(`ไม่พบ HMAC secret สำหรับ partner ${partnerId}`);
if (!mongoUri) throw new Error("ไม่พบ MONGODB_URI");

const stamp = Date.now();
const sourceEventId = `smoke_partner_${stamp}`;
const event = {
  eventId: sourceEventId,
  type: "purchase",
  occurredAt: new Date().toISOString(),
  revision: 1,
  subject: { fullName: "Smoke Test" },
  payment: {
    externalPaymentId: `smoke-payment-${stamp}`,
    amount: 12345,
    currency: "THB",
    paidAt: new Date().toISOString().slice(0, 10),
    saleRep: "Smoke",
    lines: [
      { courseLabel: "Inner", kind: "enrolled" },
      { courseLabel: "Communication", kind: "relearn", countsAsSeat: true },
      { courseLabel: "Presentation", kind: "free" },
    ],
  },
};

function signedRequest(body: unknown, timestamp = Math.floor(Date.now() / 1000), signature?: string) {
  const raw = JSON.stringify(body);
  return fetch(`${baseUrl}/api/partner/intake`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-partner-id": partnerId,
      "x-timestamp": String(timestamp),
      "x-signature": signature ?? signInternal(raw, timestamp, secret!),
    },
    body: raw,
  });
}

async function main() {
  const client = new MongoClient(mongoUri!, { appName: "line-crm-partner-smoke", serverSelectionTimeoutMS: 8_000 });
  await client.connect();
  const db = client.db(dbName);
  let purchaseId: string | null = null;
  try {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 301;
    const oldResponse = await signedRequest({ events: [event] }, oldTimestamp);
    if (oldResponse.status !== 401) throw new Error(`timestamp เก่าควรได้ 401 แต่ได้ ${oldResponse.status}`);

    const responses = [];
    for (let index = 0; index < 10; index++) {
      const response = await signedRequest({ events: [event] });
      const json = await response.json() as { summary?: { duplicate?: number }; error?: unknown };
      if (!response.ok) throw new Error(`รอบ ${index + 1} ได้ HTTP ${response.status}`);
      responses.push(json);
    }

    const purchases = await db.collection<PurchaseDoc>(COLLECTIONS.purchases)
      .find({ partnerId, sourceEventId }).toArray();
    if (purchases.length !== 1) throw new Error(`event ซ้ำ 10 ครั้งเกิด purchase ${purchases.length} รายการ`);
    purchaseId = purchases[0]!._id;
    const items = await db.collection<PurchaseItemDoc>(COLLECTIONS.purchaseItems).find({ purchaseId }).toArray();
    if (items.length !== 3) throw new Error(`ควรมี 3 purchase items แต่พบ ${items.length}`);
    if (purchases.reduce((sum, row) => sum + (row.amount ?? 0), 0) !== event.payment.amount) {
      throw new Error("ยอดเงินใน purchases ไม่ตรงกับ payment ที่ส่ง");
    }
    if (items.some((item) => "amount" in item)) throw new Error("พบ amount ใน purchase_items");
    if (items.map((item) => item.countsAsSeat).join(",") !== "true,false,false") {
      throw new Error("countsAsSeat ไม่ได้คำนวณจาก kind ฝั่งระบบ");
    }
    const duplicateCount = responses.reduce((sum, row) => sum + (row.summary?.duplicate ?? 0), 0);
    if (duplicateCount !== 9) throw new Error(`ควรมี duplicate 9 รอบ แต่ได้ ${duplicateCount}`);

    console.log("smoke:partner ผ่าน");
    console.log("- HMAC และ replay window ถูกต้อง");
    console.log("- event เดิม 10 ครั้ง = 1 purchase + 3 items");
    console.log(`- ยอดรวม ${event.payment.amount} ${event.payment.currency} ไม่ถูกคูณตามจำนวนคอร์ส`);
  } finally {
    if (purchaseId) await db.collection(COLLECTIONS.purchaseItems).deleteMany({ purchaseId });
    await Promise.all([
      db.collection(COLLECTIONS.purchases).deleteMany({ partnerId, sourceEventId }),
      db.collection(COLLECTIONS.partnerEvents).deleteMany({ partnerId, eventId: sourceEventId }),
      db.collection(COLLECTIONS.partnerQuarantine).deleteMany({ partnerId, eventId: sourceEventId }),
    ]);
    await client.close();
  }
}

main().catch((error) => {
  console.error("smoke:partner ไม่ผ่าน:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
