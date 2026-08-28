import type { Db } from "mongodb";
import { AI_COLLECTIONS } from "../db/models";

export const AI_INDEX_SPECS: Record<string, { name: string; key: Record<string, 1 | -1>; sparse?: boolean }[]> = {
  [AI_COLLECTIONS.customersScrubbed]: [
    { name: "ix_phoneHash", key: { phoneHash: 1 }, sparse: true },
    { name: "ix_emailHash", key: { emailHash: 1 }, sparse: true },
  ],
  [AI_COLLECTIONS.legacyPersonsScrubbed]: [
    { name: "ix_phoneHash", key: { phoneHash: 1 }, sparse: true },
    { name: "ix_emailHash", key: { emailHash: 1 }, sparse: true },
    { name: "ix_lastPaid", key: { lastPaidAt: -1 } },
  ],
  [AI_COLLECTIONS.legacyPaymentsScrubbed]: [
    { name: "ix_person", key: { personId: 1 } },
    { name: "ix_yearMonth", key: { year: 1, month: 1 } },
  ],
  [AI_COLLECTIONS.legacyEnrollmentsScrubbed]: [
    { name: "ix_courseSession", key: { courseCode: 1, sessionStart: 1, countsAsSeat: 1 } },
    { name: "ix_person", key: { personId: 1 } },
  ],
};

export async function ensureAiIndexes(db: Db): Promise<{ collection: string; created: string[] }[]> {
  const out: { collection: string; created: string[] }[] = [];
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name));
  for (const [name, specs] of Object.entries(AI_INDEX_SPECS)) {
    if (!existing.has(name)) await db.createCollection(name);
    const created: string[] = [];
    for (const spec of specs) {
      await db.collection(name).createIndex(spec.key, {
        name: spec.name,
        ...(spec.sparse ? { sparse: true } : {}),
      });
      created.push(spec.name);
    }
    out.push({ collection: name, created });
  }
  return out;
}

export async function verifyAiIndexes(db: Db): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const [name, specs] of Object.entries(AI_INDEX_SPECS)) {
    const have = new Set((await db.collection(name).indexes()).map((item) => item.name));
    for (const spec of specs) if (!have.has(spec.name)) missing.push(`${name}.${spec.name}`);
  }
  return { ok: missing.length === 0, missing };
}
