import { MongoClient, type AnyBulkWriteOperation, type Db, type Document, type Filter } from "mongodb";
import {
  ackLegacyAiSync,
  AI_COLLECTIONS,
  claimLegacyAiSync,
  ensureAiIndexes,
  legacyMirrorCountsOk,
  scrubLegacyEnrollment,
  scrubLegacyPayment,
  scrubLegacyPerson,
} from "../packages/core/src/index";
import { ensureLegacyIndexes } from "../packages/core/src/legacy/indexes";
import { LEGACY_COLLECTIONS, type LegacyEnrollmentDoc, type LegacyPaymentDoc, type LegacyPersonDoc } from "../packages/core/src/legacy/models";
import type { LegacyAiAckItem, LegacyAiPendingRow } from "../packages/core/src/legacy/aiQueue";
import type {
  ScrubbedLegacyEnrollment,
  ScrubbedLegacyPayment,
  ScrubbedLegacyPerson,
} from "../packages/core/src/ai/scrubLegacy";

function arg(name: string, fallback?: string): string | undefined {
  const equals = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1]!.startsWith("--")) {
    return process.argv[index + 1];
  }
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

const sensitiveKeys = new Set(["raw", "socialHandle", "sourceRefs", "slipNo", "ageAtImport", "courseLabel"]);
const fullPhone = /0[689]\d{8}/;
const fullEmail = /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function scrubbedPayloadIsSafe(value: unknown): boolean {
  const walk = (node: unknown, key = ""): boolean => {
    if (key === "nameKeys" && Array.isArray(node)) {
      return node.every((value) => typeof value === "string" && /^[0-9a-f]{12}$/.test(value));
    }
    if (typeof node === "string" && key !== "phoneHash" && key !== "emailHash" && key !== "slipGroupId") {
      if (fullPhone.test(node) || fullEmail.test(node)) return false;
    }
    if (!node || typeof node !== "object") return true;
    for (const [key, child] of Object.entries(node)) {
      if (sensitiveKeys.has(key) || !walk(child, key)) return false;
    }
    return true;
  };
  return walk(value);
}

async function setAllDirty(db: Db): Promise<void> {
  for (const collectionName of [LEGACY_COLLECTIONS.persons, LEGACY_COLLECTIONS.payments, LEGACY_COLLECTIONS.enrollments]) {
    await db.collection(collectionName).updateMany(
      { updatedAt: { $exists: false } },
      [{ $set: { updatedAt: "$createdAt" } }]
    );
    await db.collection(collectionName).updateMany(
      {},
      {
        $set: { "aiSync.dirty": true, "aiSync.lockedAt": null, "aiSync.attempts": 0 },
        $unset: { "aiSync.claimId": "" },
      }
    );
  }
}

async function upsert<T extends Document & { _id: string }>(db: Db, collectionName: string, docs: T[]): Promise<void> {
  if (docs.length === 0) return;
  const operations: AnyBulkWriteOperation<T>[] = docs.map((doc) => ({
    replaceOne: { filter: { _id: doc._id } as Filter<T>, replacement: doc, upsert: true },
  }));
  await db.collection<T>(collectionName).bulkWrite(operations, { ordered: false });
}

async function ackError<T extends LegacyPersonDoc | LegacyPaymentDoc | LegacyEnrollmentDoc>(db: Db, collectionName: string, rows: LegacyAiPendingRow<T>[]): Promise<void> {
  const items: LegacyAiAckItem[] = rows.map((row) => ({ _id: row.doc._id, claimId: row.claimId, status: "error", error: "scrub batch failed" }));
  await ackLegacyAiSync(db, collectionName, items);
}

async function syncPersons(legacyDb: Db, aiDb: Db, batchSize: number): Promise<number> {
  let synced = 0;
  while (true) {
    const claim = await claimLegacyAiSync<LegacyPersonDoc>(legacyDb, LEGACY_COLLECTIONS.persons, batchSize);
    if (!claim.rows.length) return synced;
    try {
      const ids = claim.rows.map((row) => row.doc._id);
      const payments = await legacyDb.collection<LegacyPaymentDoc>(LEGACY_COLLECTIONS.payments).find({ personId: { $in: ids } }).toArray();
      const byPerson = new Map<string, LegacyPaymentDoc[]>();
      for (const payment of payments) (byPerson.get(payment.personId) ?? byPerson.set(payment.personId, []).get(payment.personId)!).push(payment);
      const docs = claim.rows.map((row) => scrubLegacyPerson(row.doc, byPerson.get(row.doc._id) ?? []));
      await upsert<ScrubbedLegacyPerson>(aiDb, AI_COLLECTIONS.legacyPersonsScrubbed, docs);
      await ackLegacyAiSync(legacyDb, LEGACY_COLLECTIONS.persons, claim.rows.map((row) => ({ _id: row.doc._id, claimId: row.claimId, status: "ok" })));
      synced += docs.length;
    } catch (error) {
      await ackError(legacyDb, LEGACY_COLLECTIONS.persons, claim.rows);
      throw error;
    }
  }
}

async function syncPayments(legacyDb: Db, aiDb: Db, batchSize: number): Promise<number> {
  let synced = 0;
  while (true) {
    const claim = await claimLegacyAiSync<LegacyPaymentDoc>(legacyDb, LEGACY_COLLECTIONS.payments, batchSize);
    if (!claim.rows.length) return synced;
    try {
      const docs = claim.rows.map((row) => scrubLegacyPayment(row.doc));
      await upsert< ScrubbedLegacyPayment>(aiDb, AI_COLLECTIONS.legacyPaymentsScrubbed, docs);
      await ackLegacyAiSync(legacyDb, LEGACY_COLLECTIONS.payments, claim.rows.map((row) => ({ _id: row.doc._id, claimId: row.claimId, status: "ok" })));
      synced += docs.length;
    } catch (error) {
      await ackError(legacyDb, LEGACY_COLLECTIONS.payments, claim.rows);
      throw error;
    }
  }
}

async function syncEnrollments(legacyDb: Db, aiDb: Db, batchSize: number): Promise<number> {
  let synced = 0;
  while (true) {
    const claim = await claimLegacyAiSync<LegacyEnrollmentDoc>(legacyDb, LEGACY_COLLECTIONS.enrollments, batchSize);
    if (!claim.rows.length) return synced;
    try {
      const docs = claim.rows.map((row) => scrubLegacyEnrollment(row.doc));
      await upsert<ScrubbedLegacyEnrollment>(aiDb, AI_COLLECTIONS.legacyEnrollmentsScrubbed, docs);
      await ackLegacyAiSync(legacyDb, LEGACY_COLLECTIONS.enrollments, claim.rows.map((row) => ({ _id: row.doc._id, claimId: row.claimId, status: "ok" })));
      synced += docs.length;
    } catch (error) {
      await ackError(legacyDb, LEGACY_COLLECTIONS.enrollments, claim.rows);
      throw error;
    }
  }
}

/**
 * ลบ doc ฝั่ง AI ที่ต้นทางไม่มีแล้ว
 *
 * คิว aiSync รู้จักแค่ "มีของใหม่/ของแก้" ไม่รู้จัก "ของถูกลบ" — พอ regen ฐาน legacy
 * (ซึ่งได้ ULID ชุดใหม่) ของเดิมจะค้างใน AI DB ตลอดไปแล้วทำให้ analytics นับเกิน
 * ต้องสั่งด้วย --prune เท่านั้น ไม่ทำอัตโนมัติ เพราะการลบต้องเป็นความตั้งใจเสมอ
 */
async function prune(legacyDb: Db, aiDb: Db): Promise<void> {
  const plans = [
    [LEGACY_COLLECTIONS.persons, AI_COLLECTIONS.legacyPersonsScrubbed],
    [LEGACY_COLLECTIONS.payments, AI_COLLECTIONS.legacyPaymentsScrubbed],
    [LEGACY_COLLECTIONS.enrollments, AI_COLLECTIONS.legacyEnrollmentsScrubbed],
  ] as const;

  for (const [legacyName, aiName] of plans) {
    const alive = new Set<string>(
      (await legacyDb.collection(legacyName).find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id))
    );
    const orphans: string[] = [];
    for await (const doc of aiDb.collection(aiName).find({}, { projection: { _id: 1 } })) {
      const id = String(doc._id);
      if (!alive.has(id)) orphans.push(id);
    }
    // _id ของเราเป็น ULID string ไม่ใช่ ObjectId — ต้องบอก type ให้ driver ไม่งั้นมันพยายาม cast
    const target = aiDb.collection<{ _id: string }>(aiName);
    for (let i = 0; i < orphans.length; i += 500) {
      await target.deleteMany({ _id: { $in: orphans.slice(i, i + 500) } });
    }
    console.log(`🧹 ${aiName.padEnd(30)} ลบของกำพร้า ${orphans.length}`);
  }
}

async function verify(legacyDb: Db, aiDb: Db): Promise<void> {
  const plans = [
    [LEGACY_COLLECTIONS.persons, AI_COLLECTIONS.legacyPersonsScrubbed],
    [LEGACY_COLLECTIONS.payments, AI_COLLECTIONS.legacyPaymentsScrubbed],
    [LEGACY_COLLECTIONS.enrollments, AI_COLLECTIONS.legacyEnrollmentsScrubbed],
  ] as const;
  let safe = true;
  const counts: { source: number; scrubbed: number; dirty: number }[] = [];
  for (const [legacyName, aiName] of plans) {
    const sourceCount = await legacyDb.collection(legacyName).countDocuments();
    const scrubbed = await aiDb.collection(aiName).find({}).toArray();
    const dirty = await legacyDb.collection(legacyName).countDocuments({ "aiSync.dirty": true });
    counts.push({ source: sourceCount, scrubbed: scrubbed.length, dirty });
    safe = scrubbed.every(scrubbedPayloadIsSafe) && safe;
    console.log(`${legacyName.padEnd(22)} ${String(sourceCount).padStart(4)}  → scrubbed ${String(scrubbed.length).padStart(4)}   dirty เหลือ ${dirty}`);
  }

  const personRows = await aiDb.collection(AI_COLLECTIONS.legacyPersonsScrubbed).find({}, { projection: { phoneHash: 1, emailHash: 1 } }).toArray() as { phoneHash?: string | null; emailHash?: string | null }[];
  const customerRows = await aiDb.collection(AI_COLLECTIONS.customersScrubbed).find({}, { projection: { phoneHash: 1, emailHash: 1 } }).toArray() as { phoneHash?: string | null; emailHash?: string | null }[];
  const phoneHashes = new Set(customerRows.map((row) => row.phoneHash).filter((value): value is string => Boolean(value)));
  const emailHashes = new Set(customerRows.map((row) => row.emailHash).filter((value): value is string => Boolean(value)));
  const phoneMatches = personRows.filter((row) => row.phoneHash !== null && row.phoneHash !== undefined && phoneHashes.has(row.phoneHash)).length;
  const emailMatches = personRows.filter((row) => row.emailHash !== null && row.emailHash !== undefined && emailHashes.has(row.emailHash)).length;
  console.log(`ตรวจ PII ในฉบับ scrub: ${safe ? "ไม่พบเบอร์เต็ม / อีเมลเต็ม / raw / socialHandle  ✅" : "พบข้อมูลที่ไม่ปลอดภัย  ❌"}`);
  console.log(`join ได้กับ customers_scrubbed: phoneHash ตรงกัน ${phoneMatches} คน · emailHash ตรงกัน ${emailMatches} คน`);
  const countsOk = legacyMirrorCountsOk(counts);
  if (!safe || !countsOk) {
    // เขียนสาเหตุออกมาให้เห็น — ถ้ารู้ได้แค่จาก exit code คนอ่าน terminal จะเลื่อนผ่านแล้วนึกว่าผ่าน
    if (!countsOk) console.error("❌ mirror ไม่ครบ: จำนวนต้นทาง/ปลายทางไม่เท่ากัน หรือยังมี dirty ค้าง");
    if (!safe) console.error("❌ พบ PII หรือ field ต้องห้ามในฉบับ scrub");
    process.exitCode = 1;
  }
}

async function main() {
  const verifyOnly = process.argv.includes("--verify");
  const all = process.argv.includes("--all");
  const doPrune = process.argv.includes("--prune");
  if (verifyOnly && all) throw new Error("ใช้ --verify หรือ --all อย่างใดอย่างหนึ่ง");
  const legacyUri = requiredArg("legacy-uri", "LEGACY_MONGODB_URI");
  const aiUri = requiredArg("ai-uri", "MONGODB_MIRROR_URI");
  const legacyDbName = arg("legacy-db", process.env.LEGACY_MONGODB_DB ?? "line_crm_legacy")!;
  const aiDbName = arg("ai-db", process.env.AI_MONGODB_DB ?? "line_crm_ai")!;
  const batchSize = positiveInt("batch", 500);
  const legacyClient = new MongoClient(legacyUri, { appName: "line-crm-legacy-scrub", serverSelectionTimeoutMS: 8_000 });
  const aiClient = new MongoClient(aiUri, { appName: "line-crm-legacy-ai-scrub", serverSelectionTimeoutMS: 8_000 });

  try {
    await Promise.all([legacyClient.connect(), aiClient.connect()]);
    const legacyDb = legacyClient.db(legacyDbName);
    const aiDb = aiClient.db(aiDbName);
    if (verifyOnly) {
      await verify(legacyDb, aiDb);
      return;
    }

    await ensureLegacyIndexes(legacyDb);
    await ensureAiIndexes(aiDb);
    if (all) await setAllDirty(legacyDb);
    const persons = await syncPersons(legacyDb, aiDb, batchSize);
    const payments = await syncPayments(legacyDb, aiDb, batchSize);
    const enrollments = await syncEnrollments(legacyDb, aiDb, batchSize);
    if (doPrune) await prune(legacyDb, aiDb);
    console.log(`✅ legacy scrub เสร็จ: persons ${persons} · payments ${payments} · enrollments ${enrollments}`);
  } finally {
    await Promise.allSettled([legacyClient.close(), aiClient.close()]);
  }
}

main().catch((error) => {
  console.error("❌ legacy scrub ล้มเหลว:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
