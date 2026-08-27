import type { Db, IndexDescription } from "mongodb";
import { env } from "../env";
import { log } from "../logger";
import { COLLECTIONS } from "./models";

/**
 * แหล่งความจริงเดียวของ index ทั้งระบบ (docs/02)
 * รันซ้ำได้ — createIndexes เป็น idempotent เมื่อ spec เหมือนเดิม
 */

type Spec = { collection: string; indexes: IndexDescription[] };

const YEARS_2 = 63_072_000;
const DAYS_30 = 2_592_000;

export const INDEX_SPECS: Spec[] = [
  {
    collection: COLLECTIONS.customers,
    indexes: [
      { key: { phoneHash: 1 }, name: "ix_phoneHash", sparse: true },
      { key: { emailHash: 1 }, name: "ix_emailHash", sparse: true },
      { key: { "sheetSync.dirty": 1, "sheetSync.lockedAt": 1 }, name: "ix_sheetSyncQueue" },
      { key: { customerStatus: 1, createdAt: -1 }, name: "ix_statusCreated" },
      { key: { mergedInto: 1 }, name: "ix_mergedInto", sparse: true },
      { key: { updatedAt: -1 }, name: "ix_updatedAt" },
      { key: { firstMessageAt: 1 }, name: "ix_firstMessageAt", sparse: true },
    ],
  },
  {
    collection: COLLECTIONS.identities,
    indexes: [
      { key: { provider: 1, channelId: 1, externalId: 1 }, name: "uq_identity", unique: true },
      { key: { customerId: 1 }, name: "ix_customerId" },
    ],
  },
  {
    collection: COLLECTIONS.customerProfiles,
    indexes: [
      { key: { customerId: 1, revision: -1 }, name: "ix_customerRevision" },
      { key: { idempotencyKey: 1 }, name: "uq_idempotencyKey", unique: true },
      { key: { formId: 1, formVersion: 1, createdAt: -1 }, name: "ix_form" },
    ],
  },
  {
    collection: COLLECTIONS.interactions,
    indexes: [
      { key: { customerId: 1, occurredAt: -1 }, name: "ix_customerOccurred" },
      { key: { sourceEventId: 1 }, name: "uq_sourceEventId", unique: true, sparse: true },
      { key: { type: 1, occurredAt: -1 }, name: "ix_typeOccurred" },
      { key: { occurredAt: 1 }, name: "ttl_occurredAt", expireAfterSeconds: YEARS_2 },
    ],
  },
  {
    collection: COLLECTIONS.inboundEvents,
    indexes: [
      { key: { eventId: 1, provider: 1 }, name: "uq_event", unique: true },
      { key: { status: 1, nextAttemptAt: 1 }, name: "ix_queue" },
      { key: { provider: 1, channelId: 1, status: 1 }, name: "ix_providerChannelStatus" },
      { key: { receivedAt: 1 }, name: "ttl_receivedAt", expireAfterSeconds: DAYS_30 },
    ],
  },
  {
    collection: COLLECTIONS.piiTokens,
    indexes: [
      { key: { jobId: 1 }, name: "ix_jobId" },
      { key: { expiresAt: 1 }, name: "ttl_expiresAt", expireAfterSeconds: 0 },
    ],
  },
  {
    collection: "rate_limits",
    indexes: [{ key: { expiresAt: 1 }, name: "ttl_expiresAt", expireAfterSeconds: 0 }],
  },
  {
    collection: COLLECTIONS.formSchemas,
    indexes: [{ key: { formId: 1, status: 1 }, name: "ix_formStatus" }],
  },
  {
    collection: COLLECTIONS.auditLogs,
    indexes: [
      { key: { customerId: 1, at: -1 }, name: "ix_customerAt" },
      { key: { action: 1, at: -1 }, name: "ix_actionAt" },
    ],
  },
];

/**
 * สร้าง collection พร้อม WiredTiger block compressor
 * zstd บีบได้ดีกว่า snappy (default ของ Atlas) ราว 20–30% แลกกับ CPU เล็กน้อย
 * ⚠️ shared tier (M0/M2/M5) อาจไม่อนุญาต → ไม่ให้พังทั้งสคริปต์ แค่เตือนแล้วสร้างแบบปกติ
 */
async function ensureCollection(db: Db, name: string, existing: Set<string>): Promise<"created" | "exists" | "created-default"> {
  if (existing.has(name)) return "exists";

  const compressor = env("db").MONGODB_BLOCK_COMPRESSOR;
  if (compressor === "none") {
    await db.createCollection(name);
    return "created-default";
  }

  try {
    await db.createCollection(name, {
      storageEngine: { wiredTiger: { configString: `block_compressor=${compressor}` } },
    });
    return "created";
  } catch (e) {
    const msg = (e as Error).message;
    if (/already exists/i.test(msg)) return "exists";
    log.warn("ตั้ง block compressor ไม่ได้ (น่าจะเป็น Atlas shared tier) — สร้างแบบ default แทน", {
      collection: name,
      compressor,
      reason: msg,
    });
    await db.createCollection(name).catch(() => undefined);
    return "created-default";
  }
}

export interface EnsureResult {
  collection: string;
  collectionState: "created" | "exists" | "created-default";
  indexesCreated: string[];
}

export async function ensureIndexes(db: Db): Promise<EnsureResult[]> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const results: EnsureResult[] = [];

  for (const spec of INDEX_SPECS) {
    const collectionState = await ensureCollection(db, spec.collection, existing);
    const created = await db.collection(spec.collection).createIndexes(spec.indexes);
    results.push({ collection: spec.collection, collectionState, indexesCreated: created });
  }
  return results;
}

/** ตรวจว่า index ที่ควรมี มีจริงบน production (docs/06 §6.8) */
export async function verifyIndexes(db: Db): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const spec of INDEX_SPECS) {
    const have = new Set((await db.collection(spec.collection).indexes()).map((i) => i.name));
    for (const idx of spec.indexes) {
      if (!have.has(idx.name!)) missing.push(`${spec.collection}.${idx.name}`);
    }
  }
  return { ok: missing.length === 0, missing };
}
