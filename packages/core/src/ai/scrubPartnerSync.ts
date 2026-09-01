import type { AnyBulkWriteOperation, Db, Document, Filter } from "mongodb";
import { AI_COLLECTIONS, COLLECTIONS } from "../db/models";
import type { CustomerIntentDoc, PurchaseDoc, PurchaseItemDoc } from "../partner/models";
import { ackLegacyAiSync, claimLegacyAiSync, type LegacyAiPendingRow } from "../legacy/aiQueue";
import { log } from "../logger";
import { scrubCustomerIntent, scrubPurchase, scrubPurchaseItem, type ScrubbedCustomerIntent, type ScrubbedPurchase, type ScrubbedPurchaseItem } from "./scrubPartner";

/**
 * scrub partner (purchases/items/intents) จาก source → AI DB — orchestration กลาง
 * เรียกได้ทั้งจากสคริปต์ (partner:scrub) และ endpoint ที่ n8n ยิงมา
 * source ต้องเป็น connection ที่อ่าน line_crm_dev ได้ · ai ต้องเป็น mirror_user (เขียน line_crm_ai)
 */
export interface PartnerScrubResult { purchases: number; items: number; intents: number }

async function upsert<T extends Document & { _id: string }>(db: Db, name: string, docs: T[]): Promise<void> {
  if (docs.length === 0) return;
  const ops: AnyBulkWriteOperation<T>[] = docs.map((doc) => ({
    replaceOne: { filter: { _id: doc._id } as Filter<T>, replacement: doc, upsert: true },
  }));
  await db.collection<T>(name).bulkWrite(ops, { ordered: false });
}

async function ackError<T extends PurchaseDoc | CustomerIntentDoc>(db: Db, name: string, rows: LegacyAiPendingRow<T>[]): Promise<void> {
  await ackLegacyAiSync(db, name, rows.map((row) => ({ _id: row.doc._id, claimId: row.claimId, status: "error", error: "scrub batch failed" })));
}

export async function scrubPartnerToAi(source: Db, ai: Db, batchSize = 500): Promise<PartnerScrubResult> {
  const result: PartnerScrubResult = { purchases: 0, items: 0, intents: 0 };

  for (;;) {
    const claim = await claimLegacyAiSync<PurchaseDoc>(source, COLLECTIONS.purchases, batchSize);
    if (claim.rows.length === 0) break;
    try {
      const ids = claim.rows.map((r) => r.doc._id);
      const items = await source.collection<PurchaseItemDoc>(COLLECTIONS.purchaseItems).find({ purchaseId: { $in: ids } }).toArray();
      await upsert<ScrubbedPurchase>(ai, AI_COLLECTIONS.purchasesScrubbed, claim.rows.map((r) => scrubPurchase(r.doc)));
      for (const purchaseId of ids) await ai.collection(AI_COLLECTIONS.purchaseItemsScrubbed).deleteMany({ purchaseId });
      const scrubbed = items.map((i) => scrubPurchaseItem(i));
      await upsert<ScrubbedPurchaseItem>(ai, AI_COLLECTIONS.purchaseItemsScrubbed, scrubbed);
      await ackLegacyAiSync(source, COLLECTIONS.purchases, claim.rows.map((r) => ({ _id: r.doc._id, claimId: r.claimId, status: "ok" })));
      result.purchases += claim.rows.length;
      result.items += scrubbed.length;
    } catch (error) {
      await ackError(source, COLLECTIONS.purchases, claim.rows);
      throw error;
    }
  }

  for (;;) {
    const claim = await claimLegacyAiSync<CustomerIntentDoc>(source, COLLECTIONS.customerIntents, batchSize);
    if (claim.rows.length === 0) break;
    try {
      const docs = claim.rows.map((r) => scrubCustomerIntent(r.doc));
      await upsert<ScrubbedCustomerIntent>(ai, AI_COLLECTIONS.customerIntentsScrubbed, docs);
      await ackLegacyAiSync(source, COLLECTIONS.customerIntents, claim.rows.map((r) => ({ _id: r.doc._id, claimId: r.claimId, status: "ok" })));
      result.intents += docs.length;
    } catch (error) {
      await ackError(source, COLLECTIONS.customerIntents, claim.rows);
      throw error;
    }
  }

  log.info("scrub partner → AI", result as unknown as Record<string, unknown>);
  return result;
}
