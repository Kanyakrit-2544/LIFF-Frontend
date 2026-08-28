import type { Db } from "mongodb";
import { AI_COLLECTIONS } from "../db/models";

export interface AiIndexSpec {
  name: string;
  key: Record<string, 1 | -1>;
  sparse?: boolean;
  unique?: boolean;
}

export const AI_INDEX_SPECS: Record<string, AiIndexSpec[]> = {
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
  [AI_COLLECTIONS.customerLinks]: [
    { name: "ux_pair", key: { customerId: 1, legacyPersonId: 1 }, unique: true },
    { name: "ix_customer", key: { customerId: 1, status: 1 } },
    { name: "ix_legacy", key: { legacyPersonId: 1 } },
    { name: "ix_status", key: { status: 1, confidence: 1 } },
  ],
  [AI_COLLECTIONS.purchasesScrubbed]: [
    { name: "ix_customer", key: { customerId: 1 }, sparse: true },
    { name: "ix_yearMonth", key: { year: 1, month: 1 } },
    { name: "ix_statusPaidAt", key: { status: 1, paidAt: 1 } },
  ],
  [AI_COLLECTIONS.purchaseItemsScrubbed]: [
    { name: "ix_purchase", key: { purchaseId: 1 } },
    { name: "ix_customer", key: { customerId: 1 }, sparse: true },
    { name: "ix_courseSession", key: { courseCode: 1, sessionStart: 1, countsAsSeat: 1 } },
  ],
  [AI_COLLECTIONS.customerIntentsScrubbed]: [
    { name: "ix_current", key: { customerId: 1, courseCode: 1, supersededAt: 1 }, sparse: true },
    { name: "ix_funnel", key: { status: 1, hesitationReason: 1, observedAt: 1 } },
  ],
};

export function aiIndexMatchesSpec(
  actual: { key?: unknown; sparse?: boolean; unique?: boolean },
  spec: AiIndexSpec
): boolean {
  if (!actual.key || typeof actual.key !== "object") return false;
  const actualEntries = Object.entries(actual.key as Record<string, unknown>);
  const expectedEntries = Object.entries(spec.key);
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries)
    && Boolean(actual.unique) === Boolean(spec.unique)
    && Boolean(actual.sparse) === Boolean(spec.sparse);
}

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
        ...(spec.unique ? { unique: true } : {}),
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
    const have = new Map((await db.collection(name).indexes()).map((item) => [item.name, item]));
    for (const spec of specs) {
      const actual = have.get(spec.name);
      if (!actual || !aiIndexMatchesSpec(actual, spec)) missing.push(`${name}.${spec.name}`);
    }
  }
  return { ok: missing.length === 0, missing };
}
