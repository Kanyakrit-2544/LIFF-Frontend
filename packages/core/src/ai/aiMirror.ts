import { getDb } from "../db/client";
import { COLLECTIONS, type CustomerDoc } from "../db/models";
import { newId } from "../ids";
import { log } from "../logger";
import { scrubCustomer, type ScrubbedCustomer } from "./scrubCustomer";

const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

async function col() {
  return (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers);
}

export interface AiMirrorPendingRow {
  customerId: string;
  attempts: number;
  customer: ScrubbedCustomer;
}

export async function claimAiMirrorCustomers(limit = 200): Promise<{ claimId: string; rows: AiMirrorPendingRow[] }> {
  const c = await col();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LEASE_MS);

  const released = await c.updateMany(
    { "aiSync.dirty": true, "aiSync.lockedAt": { $ne: null, $lte: staleBefore } },
    { $set: { "aiSync.lockedAt": null } }
  );
  if (released.modifiedCount > 0) log.warn("ปลด lock AI mirror ที่ค้าง", { count: released.modifiedCount });

  const filter = {
    "aiSync.dirty": true,
    "aiSync.lockedAt": null,
    "aiSync.attempts": { $lt: MAX_ATTEMPTS },
  };
  const candidates = await c.find(filter, { projection: { _id: 1 }, limit, sort: { updatedAt: 1 } }).toArray();
  if (candidates.length === 0) return { claimId: "", rows: [] };

  const claimId = newId("job");
  const r = await c.updateMany(
    { _id: { $in: candidates.map((x) => x._id) }, "aiSync.lockedAt": null },
    { $set: { "aiSync.lockedAt": now, "aiSync.claimId": claimId } }
  );
  if (r.modifiedCount === 0) return { claimId: "", rows: [] };

  const docs = await c.find({ "aiSync.claimId": claimId }).toArray();
  const scrubbedAt = new Date();
  return {
    claimId,
    rows: docs.map((doc) => ({
      customerId: doc._id,
      attempts: doc.aiSync?.attempts ?? 0,
      customer: scrubCustomer(doc, scrubbedAt),
    })),
  };
}

export interface AiMirrorAckItem {
  customerId: string;
  status: "ok" | "error";
  claimId?: string;
  error?: string;
}

export async function ackAiMirror(items: AiMirrorAckItem[]): Promise<{ ok: number; failed: number; dead: number }> {
  if (items.length === 0) return { ok: 0, failed: 0, dead: 0 };
  const c = await col();
  const now = new Date();

  let ok = 0;
  for (const item of items.filter((i) => i.status === "ok")) {
    const claimFilter = item.claimId ? { _id: item.customerId, "aiSync.claimId": item.claimId } : { _id: item.customerId };
    const r = await c.updateOne(
      {
        ...claimFilter,
        $expr: { $lte: ["$updatedAt", "$aiSync.lockedAt"] },
      },
      {
        $set: { "aiSync.dirty": false, "aiSync.syncedAt": now, "aiSync.lockedAt": null, "aiSync.attempts": 0 },
        $unset: { "aiSync.claimId": "" },
      }
    );
    if (r.modifiedCount === 1) {
      ok++;
    } else {
      await c.updateOne(claimFilter, { $set: { "aiSync.lockedAt": null }, $unset: { "aiSync.claimId": "" } });
    }
  }

  let failed = 0;
  let dead = 0;
  for (const item of items.filter((i) => i.status === "error")) {
    const claimFilter = item.claimId ? { _id: item.customerId, "aiSync.claimId": item.claimId } : { _id: item.customerId };
    const doc = await c.findOne(claimFilter, { projection: { aiSync: 1 } });
    if (!doc) continue;
    const attempts = (doc?.aiSync?.attempts ?? 0) + 1;
    await c.updateOne(
      claimFilter,
      { $set: { "aiSync.attempts": attempts, "aiSync.lockedAt": null }, $unset: { "aiSync.claimId": "" } }
    );
    failed++;
    if (attempts >= MAX_ATTEMPTS) {
      dead++;
      log.error("AI mirror ล้มเหลวครบเพดาน", { customerId: item.customerId, attempts, error: item.error?.slice(0, 120) });
    }
  }

  return { ok, failed, dead };
}

export async function aiMirrorStats(): Promise<{ dirty: number; locked: number; stuck: number }> {
  const c = await col();
  const [dirty, locked, stuck] = await Promise.all([
    c.countDocuments({ "aiSync.dirty": true }),
    c.countDocuments({ "aiSync.dirty": true, "aiSync.lockedAt": { $ne: null } }),
    c.countDocuments({ "aiSync.dirty": true, "aiSync.attempts": { $gte: MAX_ATTEMPTS } }),
  ]);
  return { dirty, locked, stuck };
}
