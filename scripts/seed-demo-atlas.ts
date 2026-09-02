import { MongoClient, type Document } from "mongodb";
import {
  COLLECTIONS,
  ensureIndexes,
  type CustomerDoc,
  type CustomerIntentDoc,
  type PurchaseDoc,
  type PurchaseItemDoc,
} from "../packages/core/src/index";

const SEED_TAG = "sales-demo";
const PARTNER_ID = "sales-demo";

interface SeedMeta {
  seedTag: typeof SEED_TAG;
  synthetic: true;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function assertAtlas(uri: string): void {
  if (!hasFlag("confirm-atlas")) {
    throw new Error("ปฏิเสธการเขียน Atlas: ต้องใส่ --confirm-atlas ทุกครั้ง");
  }
  const parsed = new URL(uri);
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("seed:demo-atlas ใช้กับ Atlas เท่านั้น ไม่รับ URI localhost");
  }
}

async function replaceMany<T extends Document & { _id: string }>(db: import("mongodb").Db, collection: string, docs: T[]) {
  await db.collection<T>(collection).bulkWrite(docs.map((doc) => ({
    replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
  })) as never[], { ordered: false });
}

async function cleanup(db: import("mongodb").Db): Promise<Record<string, number>> {
  const collections = [
    COLLECTIONS.recommendationReviews,
    COLLECTIONS.customerIntents,
    COLLECTIONS.purchaseItems,
    COLLECTIONS.purchases,
    COLLECTIONS.customers,
  ];
  const counts: Record<string, number> = {};
  for (const name of collections) {
    const result = await db.collection(name).deleteMany({ seedTag: SEED_TAG });
    counts[name] = result.deletedCount;
  }
  return counts;
}

function customer(id: string, name: string, now: Date): CustomerDoc & SeedMeta {
  return {
    _id: id,
    status: "active",
    mergedInto: null,
    title: null,
    heardFrom: "ข้อมูลจำลองสำหรับฝ่ายขาย",
    displayName: name,
    nickname: null,
    fullNameEn: null,
    birthYear: null,
    lineDisplayName: null,
    pictureUrl: null,
    facebook: null,
    instagram: null,
    phone: null,
    email: null,
    customerStatus: "prospect",
    tags: ["sales-demo"],
    source: { channel: "sales_demo", campaign: null },
    sources: ["sales_demo"],
    consent: { dataProcessing: true, marketing: true, version: "sales-demo", grantedAt: now, ip: null, userAgent: null },
    profileRef: null,
    pendingMerge: null,
    erasedAt: null,
    eraseReason: null,
    leadAttribution: null,
    sheetSync: { dirty: false, rowKey: id, syncedAt: now, lockedAt: null, attempts: 0 },
    aiSync: { dirty: false, syncedAt: now, lockedAt: null, attempts: 0 },
    counters: { milestones: 0, formSubmits: 0 },
    firstInteractionAt: now,
    firstMessageAt: now,
    lastInteractionAt: now,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
    seedTag: SEED_TAG,
    synthetic: true,
  };
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI?.trim();
  const dbName = process.env.MONGODB_DB?.trim() || "line_crm_dev";
  if (!uri) throw new Error("ไม่พบ MONGODB_URI");
  assertAtlas(uri);

  const client = new MongoClient(uri, { appName: "line-crm-sales-demo-seed", serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const db = client.db(dbName);
  try {
    await ensureIndexes(db);
    const removed = await cleanup(db);
    if (hasFlag("cleanup")) {
      console.log("ลบ sales-demo แล้ว (ไม่แตะ document ที่ไม่มี seedTag นี้)");
      for (const [name, count] of Object.entries(removed)) console.log(`  ${name}: ${count}`);
      return;
    }

    const now = new Date();
    const completedAt = new Date(now.getTime() - 45 * 86_400_000);
    const meta: SeedMeta = { seedTag: SEED_TAG, synthetic: true };
    const customers = [
      customer("cus_SALES_DEMO_FOLLOW_001", "ลูกค้าจำลอง ลังเลเรื่องงบ", now),
      customer("cus_SALES_DEMO_FOLLOW_002", "ลูกค้าจำลอง เวลาไม่ลงตัว", now),
      customer("cus_SALES_DEMO_FOLLOW_003", "ลูกค้าจำลอง รอตามผล", now),
      customer("cus_SALES_DEMO_UPSELL_001", "ผู้เรียนจำลอง หนึ่ง", now),
      customer("cus_SALES_DEMO_UPSELL_002", "ผู้เรียนจำลอง สอง", now),
      customer("cus_SALES_DEMO_UPSELL_003", "ผู้เรียนจำลอง สาม", now),
    ];
    const sync = { dirty: false, syncedAt: now, lockedAt: null, attempts: 0 };
    const intentData = [
      [customers[0]!._id, "COMMU", "budget", 0.87],
      [customers[1]!._id, "PRESENT", "timing_conflict", 0.73],
      [customers[2]!._id, "TTRT", null, 0.64],
    ] as const;
    const intents: Array<CustomerIntentDoc & SeedMeta> = intentData.map(([customerId, courseCode, reason, confidence], index) => ({
      _id: `int_SALES_DEMO_${index + 1}`,
      customerId,
      courseCode,
      status: "hesitant",
      hesitationReason: reason,
      confidence,
      belowThreshold: false,
      source: "ai",
      lock: "soft",
      model: "sales-demo-unvalidated",
      observedAt: new Date(now.getTime() - index * 60_000),
      supersededAt: null,
      voidedAt: null,
      partnerId: PARTNER_ID,
      sourceEventId: `sales-demo-intent-${index + 1}`,
      aiSync: { ...sync },
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
      ...meta,
    }));
    const upsellCustomers = customers.slice(3);
    const purchases: Array<PurchaseDoc & SeedMeta> = upsellCustomers.map((row, index) => ({
      _id: `pur_SALES_DEMO_${index + 1}`,
      customerId: row._id,
      partnerId: PARTNER_ID,
      externalPaymentId: `SALES-DEMO-${index + 1}`,
      amount: 15900,
      currency: "THB",
      paidAt: completedAt,
      year: completedAt.getUTCFullYear(),
      month: completedAt.getUTCMonth() + 1,
      saleRep: "พนักงานจำลอง",
      attribution: null,
      status: "active",
      sourceEventId: `sales-demo-purchase-${index + 1}`,
      aiSync: { ...sync },
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
      ...meta,
    }));
    const items: Array<PurchaseItemDoc & SeedMeta> = purchases.map((purchase, index) => ({
      _id: `pit_SALES_DEMO_${index + 1}`,
      purchaseId: purchase._id,
      customerId: purchase.customerId,
      courseCode: "INNER",
      courseLabel: "Inner Makeover",
      kind: "enrolled",
      countsAsSeat: true,
      sessionLabel: "Sales demo",
      sessionStart: completedAt,
      sessionYear: completedAt.getUTCFullYear(),
      createdAt: now,
      schemaVersion: 1,
      ...meta,
    }));

    await replaceMany(db, COLLECTIONS.customers, customers);
    await replaceMany(db, COLLECTIONS.customerIntents, intents);
    await replaceMany(db, COLLECTIONS.purchases, purchases);
    await replaceMany(db, COLLECTIONS.purchaseItems, items);
    console.log("เพิ่ม sales-demo ลง Atlas dev แล้ว");
    console.log(`  customers ${customers.length} · hesitant ${intents.length} · completed ${items.length}`);
    console.log("  คาดว่ากล่องตามผล >= 3 · upsell >= 9 (INNER แนะนำ 3 คอร์สต่อคน)");
    console.log("  ทุก document ติด seedTag:sales-demo และ synthetic:true");
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("seed:demo-atlas ล้มเหลว:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
