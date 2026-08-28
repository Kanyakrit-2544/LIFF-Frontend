import type { Collection, Db, Filter } from "mongodb";
import { newId } from "../ids";

export const LEGACY_AI_LEASE_MS = 5 * 60 * 1000;
export const LEGACY_AI_MAX_ATTEMPTS = 5;

export interface LegacyAiSyncState {
  dirty: boolean;
  syncedAt: Date | null;
  lockedAt: Date | null;
  attempts: number;
  claimId?: string;
}

export interface LegacyAiSyncDoc {
  _id: string;
  updatedAt: Date;
  aiSync: LegacyAiSyncState;
}

export interface LegacyAiPendingRow<T extends LegacyAiSyncDoc> {
  doc: T;
  attempts: number;
  claimId: string;
}

export interface LegacyAiAckItem {
  _id: string;
  status: "ok" | "error";
  claimId: string;
  error?: string;
}

function collection(db: Db, name: string): Collection<LegacyAiSyncDoc> {
  return db.collection<LegacyAiSyncDoc>(name);
}

export async function claimLegacyAiSync<T extends LegacyAiSyncDoc>(
  db: Db,
  collectionName: string,
  limit = 500,
  now = new Date()
): Promise<{ claimId: string; rows: LegacyAiPendingRow<T>[] }> {
  const c = collection(db, collectionName);
  const staleBefore = new Date(now.getTime() - LEGACY_AI_LEASE_MS);
  await c.updateMany(
    { "aiSync.dirty": true, "aiSync.lockedAt": { $ne: null, $lte: staleBefore } } as Filter<LegacyAiSyncDoc>,
    { $set: { "aiSync.lockedAt": null }, $unset: { "aiSync.claimId": "" } }
  );

  const candidates = await c
    .find(
      { "aiSync.dirty": true, "aiSync.lockedAt": null, "aiSync.attempts": { $lt: LEGACY_AI_MAX_ATTEMPTS } } as Filter<LegacyAiSyncDoc>,
      { projection: { _id: 1 }, limit, sort: { updatedAt: 1 } }
    )
    .toArray();
  if (candidates.length === 0) return { claimId: "", rows: [] };

  const claimId = newId("job");
  const result = await c.updateMany(
    { _id: { $in: candidates.map((candidate) => candidate._id) }, "aiSync.dirty": true, "aiSync.lockedAt": null } as Filter<LegacyAiSyncDoc>,
    { $set: { "aiSync.lockedAt": now, "aiSync.claimId": claimId } }
  );
  if (result.modifiedCount === 0) return { claimId: "", rows: [] };

  const docs = await c.find({ "aiSync.claimId": claimId } as Filter<LegacyAiSyncDoc>).toArray() as unknown as T[];
  return {
    claimId,
    rows: docs.map((doc) => ({ doc, attempts: doc.aiSync.attempts, claimId })),
  };
}

export async function ackLegacyAiSync(
  db: Db,
  collectionName: string,
  items: readonly LegacyAiAckItem[],
  now = new Date()
): Promise<{ ok: number; failed: number; dead: number }> {
  const c = collection(db, collectionName);
  let ok = 0;
  let failed = 0;
  let dead = 0;

  for (const item of items) {
    const filter = { _id: item._id, "aiSync.claimId": item.claimId } as Filter<LegacyAiSyncDoc>;
    if (item.status === "ok") {
      const result = await c.updateOne(
        { ...filter, $expr: { $lte: ["$updatedAt", "$aiSync.lockedAt"] } },
        {
          $set: { "aiSync.dirty": false, "aiSync.syncedAt": now, "aiSync.lockedAt": null, "aiSync.attempts": 0 },
          $unset: { "aiSync.claimId": "" },
        }
      );
      if (result.modifiedCount === 1) ok++;
      else await c.updateOne(filter, { $set: { "aiSync.lockedAt": null }, $unset: { "aiSync.claimId": "" } });
      continue;
    }

    const result = await c.findOneAndUpdate(
      filter,
      {
        $inc: { "aiSync.attempts": 1 },
        $set: { "aiSync.lockedAt": null },
        $unset: { "aiSync.claimId": "" },
      },
      { returnDocument: "after", projection: { aiSync: 1 } }
    );
    if (!result) continue;
    failed++;
    if (result.aiSync.attempts >= LEGACY_AI_MAX_ATTEMPTS) dead++;
  }

  return { ok, failed, dead };
}
