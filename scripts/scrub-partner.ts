import { MongoClient, type AnyBulkWriteOperation, type Db, type Document, type Filter } from "mongodb";
import {
  ackLegacyAiSync,
  AI_COLLECTIONS,
  claimLegacyAiSync,
  COLLECTIONS,
  ensureAiIndexes,
  ensureIndexes,
  scrubCustomerIntent,
  scrubPurchase,
  scrubPurchaseItem,
  verifyAiIndexes,
  type CustomerIntentDoc,
  type LegacyAiAckItem,
  type LegacyAiPendingRow,
  type PurchaseDoc,
  type PurchaseItemDoc,
  type ScrubbedCustomerIntent,
  type ScrubbedPurchase,
  type ScrubbedPurchaseItem,
} from "../packages/core/src/index";

function arg(name: string, fallback?: string): string | undefined {
  const equals = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1]!.startsWith("--")) return process.argv[index + 1];
  return fallback;
}

function requiredArg(name: string, envName: string): string {
  const value = arg(name, process.env[envName]);
  if (!value) throw new Error(`ไม่พบ ${name} — ใส่ --${name} หรือ ${envName}`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} ต้องเป็นจำนวนเต็มบวก`);
  return value;
}

async function upsert<T extends Document & { _id: string }>(db: Db, name: string, docs: T[]): Promise<void> {
  if (docs.length === 0) return;
  const operations: AnyBulkWriteOperation<T>[] = docs.map((doc) => ({
    replaceOne: { filter: { _id: doc._id } as Filter<T>, replacement: doc, upsert: true },
  }));
  await db.collection<T>(name).bulkWrite(operations, { ordered: false });
}

async function ackError<T extends PurchaseDoc | CustomerIntentDoc>(db: Db, name: string, rows: LegacyAiPendingRow<T>[]) {
  const items: LegacyAiAckItem[] = rows.map((row) => ({ _id: row.doc._id, claimId: row.claimId, status: "error", error: "scrub batch failed" }));
  await ackLegacyAiSync(db, name, items);
}

async function syncPurchases(source: Db, ai: Db, batchSize: number): Promise<{ purchases: number; items: number }> {
  let purchaseCount = 0;
  let itemCount = 0;
  while (true) {
    const claim = await claimLegacyAiSync<PurchaseDoc>(source, COLLECTIONS.purchases, batchSize);
    if (claim.rows.length === 0) return { purchases: purchaseCount, items: itemCount };
    try {
      const ids = claim.rows.map((row) => row.doc._id);
      const items = await source.collection<PurchaseItemDoc>(COLLECTIONS.purchaseItems).find({ purchaseId: { $in: ids } }).toArray();
      await upsert<ScrubbedPurchase>(ai, AI_COLLECTIONS.purchasesScrubbed, claim.rows.map((row) => scrubPurchase(row.doc)));
      for (const purchaseId of ids) {
        await ai.collection(AI_COLLECTIONS.purchaseItemsScrubbed).deleteMany({ purchaseId });
      }
      const scrubbedItems = items.map((item) => scrubPurchaseItem(item));
      await upsert<ScrubbedPurchaseItem>(ai, AI_COLLECTIONS.purchaseItemsScrubbed, scrubbedItems);
      await ackLegacyAiSync(source, COLLECTIONS.purchases, claim.rows.map((row) => ({ _id: row.doc._id, claimId: row.claimId, status: "ok" })));
      purchaseCount += claim.rows.length;
      itemCount += scrubbedItems.length;
    } catch (error) {
      await ackError(source, COLLECTIONS.purchases, claim.rows);
      throw error;
    }
  }
}

async function syncIntents(source: Db, ai: Db, batchSize: number): Promise<number> {
  let count = 0;
  while (true) {
    const claim = await claimLegacyAiSync<CustomerIntentDoc>(source, COLLECTIONS.customerIntents, batchSize);
    if (claim.rows.length === 0) return count;
    try {
      const docs = claim.rows.map((row) => scrubCustomerIntent(row.doc));
      await upsert<ScrubbedCustomerIntent>(ai, AI_COLLECTIONS.customerIntentsScrubbed, docs);
      await ackLegacyAiSync(source, COLLECTIONS.customerIntents, claim.rows.map((row) => ({ _id: row.doc._id, claimId: row.claimId, status: "ok" })));
      count += docs.length;
    } catch (error) {
      await ackError(source, COLLECTIONS.customerIntents, claim.rows);
      throw error;
    }
  }
}

async function setAllDirty(db: Db): Promise<void> {
  for (const name of [COLLECTIONS.purchases, COLLECTIONS.customerIntents]) {
    await db.collection(name).updateMany({}, {
      $set: { "aiSync.dirty": true, "aiSync.lockedAt": null, "aiSync.attempts": 0 },
      $unset: { "aiSync.claimId": "" },
    });
  }
}

const fullPhone = /(?:\+66|0)[689]\d{8}/;
const fullEmail = /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const forbidden = new Set(["raw", "externalPaymentId", "sourceEventId", "courseLabel", "fullName", "phone", "email"]);

function safe(value: unknown): boolean {
  const walk = (node: unknown): boolean => {
    if (typeof node === "string" && (fullPhone.test(node) || fullEmail.test(node))) return false;
    if (!node || typeof node !== "object") return true;
    return Object.entries(node as Record<string, unknown>).every(([key, child]) => !forbidden.has(key) && walk(child));
  };
  return walk(value);
}

async function verify(source: Db, ai: Db): Promise<void> {
  const plans = [
    [COLLECTIONS.purchases, AI_COLLECTIONS.purchasesScrubbed, true],
    [COLLECTIONS.purchaseItems, AI_COLLECTIONS.purchaseItemsScrubbed, false],
    [COLLECTIONS.customerIntents, AI_COLLECTIONS.customerIntentsScrubbed, true],
  ] as const;
  let ok = true;
  for (const [sourceName, aiName, hasQueue] of plans) {
    const sourceCount = await source.collection(sourceName).countDocuments();
    const rows = await ai.collection(aiName).find({}).toArray();
    const dirty = hasQueue ? await source.collection(sourceName).countDocuments({ "aiSync.dirty": true }) : 0;
    const rowSafe = rows.every(safe);
    console.log(`${sourceName.padEnd(22)} ${String(sourceCount).padStart(4)} → scrubbed ${String(rows.length).padStart(4)} · dirty ${dirty} · PII ${rowSafe ? "ไม่พบ" : "พบ"}`);
    if (sourceCount !== rows.length || dirty !== 0 || !rowSafe) ok = false;
  }
  const indexes = await verifyAiIndexes(ai).catch(() => ({ ok: false, missing: ["อ่าน index ไม่สำเร็จ"] }));
  console.log(`indexes ${indexes.ok ? "ครบ" : `ขาด ${indexes.missing.join(", ")}`}`);
  if (!indexes.ok) ok = false;
  if (!ok) process.exitCode = 1;
}

async function prune(source: Db, ai: Db): Promise<void> {
  const plans = [
    [COLLECTIONS.purchases, AI_COLLECTIONS.purchasesScrubbed],
    [COLLECTIONS.purchaseItems, AI_COLLECTIONS.purchaseItemsScrubbed],
    [COLLECTIONS.customerIntents, AI_COLLECTIONS.customerIntentsScrubbed],
  ] as const;
  for (const [sourceName, aiName] of plans) {
    const alive = new Set((await source.collection(sourceName).find({}, { projection: { _id: 1 } }).toArray()).map((row) => String(row._id)));
    const orphaned: string[] = [];
    for await (const row of ai.collection(aiName).find({}, { projection: { _id: 1 } })) {
      if (!alive.has(String(row._id))) orphaned.push(String(row._id));
    }
    for (let index = 0; index < orphaned.length; index += 500) {
      await ai.collection<{ _id: string }>(aiName).deleteMany({ _id: { $in: orphaned.slice(index, index + 500) } });
    }
    console.log(`${aiName.padEnd(30)} ลบของกำพร้า ${orphaned.length}`);
  }
}

async function main() {
  const verifyOnly = process.argv.includes("--verify");
  const all = process.argv.includes("--all");
  const doPrune = process.argv.includes("--prune");
  if (verifyOnly && (all || doPrune)) throw new Error("--verify ใช้ร่วมกับ --all/--prune ไม่ได้");
  const sourceUri = requiredArg("source-uri", "MONGODB_URI");
  const aiUri = requiredArg("ai-uri", "MONGODB_MIRROR_URI");
  const sourceDbName = arg("source-db", process.env.MONGODB_DB ?? "line_crm_dev")!;
  const aiDbName = arg("ai-db", process.env.AI_MONGODB_DB ?? "line_crm_ai")!;
  const batch = positiveInt("batch", 500);
  const sourceClient = new MongoClient(sourceUri, { appName: "line-crm-partner-scrub", serverSelectionTimeoutMS: 8_000 });
  const aiClient = new MongoClient(aiUri, { appName: "line-crm-partner-ai-scrub", serverSelectionTimeoutMS: 8_000 });
  try {
    await Promise.all([sourceClient.connect(), aiClient.connect()]);
    const source = sourceClient.db(sourceDbName);
    const ai = aiClient.db(aiDbName);
    if (verifyOnly) return await verify(source, ai);
    await ensureIndexes(source);
    await ensureAiIndexes(ai);
    if (all) await setAllDirty(source);
    const purchases = await syncPurchases(source, ai, batch);
    const intents = await syncIntents(source, ai, batch);
    if (doPrune) await prune(source, ai);
    console.log(`partner scrub เสร็จ: purchases ${purchases.purchases} · items ${purchases.items} · intents ${intents}`);
  } finally {
    await Promise.allSettled([sourceClient.close(), aiClient.close()]);
  }
}

main().catch((error) => {
  console.error("partner scrub ล้มเหลว:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});

