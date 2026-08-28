import type { Db } from "mongodb";
import { COLLECTIONS } from "../db/models";
import { resolvePartnerSubject } from "./identity";
import { recomputeIntentCurrent } from "./intents";
import type { CustomerIntentDoc, PartnerEventDoc, PartnerSubject, PurchaseDoc } from "./models";

export interface PartnerReconcileReport {
  scanned: number;
  resolved: number;
  stillPending: number;
  ambiguous: number;
}

function subjectFrom(event: PartnerEventDoc): PartnerSubject | null {
  const value = event.raw.subject;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const get = (key: string) => typeof row[key] === "string" && row[key] ? String(row[key]) : null;
  const subject = { lineUserId: get("lineUserId"), phone: get("phone"), email: get("email"), fullName: get("fullName") };
  return Object.values(subject).some(Boolean) ? subject : null;
}

export async function reconcilePartnerIdentities(
  db: Db,
  options: { dryRun?: boolean } = {}
): Promise<PartnerReconcileReport> {
  const [purchases, intents] = await Promise.all([
    db.collection<PurchaseDoc>(COLLECTIONS.purchases).find({ customerId: null }, { projection: { partnerId: 1, sourceEventId: 1 } }).toArray(),
    db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents).find({ customerId: null }, { projection: { partnerId: 1, sourceEventId: 1 } }).toArray(),
  ]);
  const refs = new Map<string, { partnerId: string; eventId: string }>();
  for (const row of [...purchases, ...intents]) refs.set(`${row.partnerId}\0${row.sourceEventId}`, { partnerId: row.partnerId, eventId: row.sourceEventId });

  const report: PartnerReconcileReport = { scanned: refs.size, resolved: 0, stillPending: 0, ambiguous: 0 };
  for (const ref of refs.values()) {
    const event = await db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents).findOne({ partnerId: ref.partnerId, eventId: ref.eventId });
    const subject = event ? subjectFrom(event) : null;
    if (!event || !subject) {
      report.stillPending++;
      continue;
    }
    const identity = await resolvePartnerSubject(db, subject, { createMissingLine: false });
    if (identity.ambiguous) {
      report.ambiguous++;
      continue;
    }
    if (!identity.customerId) {
      report.stillPending++;
      continue;
    }
    report.resolved++;
    if (options.dryRun) continue;

    const now = new Date();
    const purchaseRows = await db.collection<PurchaseDoc>(COLLECTIONS.purchases)
      .find({ partnerId: ref.partnerId, sourceEventId: ref.eventId, customerId: null }).toArray();
    for (const purchase of purchaseRows) {
      await db.collection<PurchaseDoc>(COLLECTIONS.purchases).updateOne(
        { _id: purchase._id, customerId: null },
        { $set: { customerId: identity.customerId, updatedAt: now, "aiSync.dirty": true, "aiSync.lockedAt": null } }
      );
      await db.collection(COLLECTIONS.purchaseItems).updateMany(
        { purchaseId: purchase._id, customerId: null },
        { $set: { customerId: identity.customerId } }
      );
    }

    const intentRows = await db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents)
      .find({ partnerId: ref.partnerId, sourceEventId: ref.eventId, customerId: null }).toArray();
    for (const intent of intentRows) {
      await db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents).updateOne(
        { _id: intent._id, customerId: null },
        { $set: { customerId: identity.customerId, updatedAt: now, "aiSync.dirty": true, "aiSync.lockedAt": null } }
      );
      await recomputeIntentCurrent(db, identity.customerId, intent.courseCode, now);
    }

    await db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents).updateOne(
      { _id: event._id },
      { $set: { customerId: identity.customerId, status: "accepted", reason: identity.evidence } }
    );
  }
  return report;
}

