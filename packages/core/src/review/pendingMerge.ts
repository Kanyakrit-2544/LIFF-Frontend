import { ObjectId, type Db } from "mongodb";
import { getClient, getDb } from "../db/client";
import {
  COLLECTIONS,
  type AuditLogDoc,
  type CustomerDoc,
  type StaffReviewDecisionDoc,
} from "../db/models";
import { mergeCustomers, pickWinner } from "../identity/merge";

export function mergePairKey(left: string, right: string): string {
  return [left, right].sort().join(":");
}

export async function isMergePairRejected(db: Db, left: string, right: string): Promise<boolean> {
  return Boolean(await db.collection<StaffReviewDecisionDoc>(COLLECTIONS.staffReviewDecisions).findOne(
    { kind: "pending_merge", subjectKey: mergePairKey(left, right), decision: "rejected" },
    { projection: { _id: 1 } }
  ));
}

export async function rejectPendingMerge(input: {
  customerId: string;
  candidateId: string;
  actor: string;
  reason?: string | null;
  now?: Date;
}): Promise<void> {
  const db = await getDb();
  const client = await getClient();
  const session = client.startSession();
  const now = input.now ?? new Date();
  const subjectKey = mergePairKey(input.customerId, input.candidateId);

  try {
    await session.withTransaction(async () => {
      const current = await db.collection<CustomerDoc>(COLLECTIONS.customers).findOne(
        { _id: input.customerId },
        { projection: { pendingMerge: 1 }, session }
      );
      if (current?.pendingMerge?.candidateId !== input.candidateId) {
        throw new Error("pending_merge_changed");
      }

      const decision: StaffReviewDecisionDoc = {
        _id: `merge:${subjectKey}`,
        kind: "pending_merge",
        subjectKey,
        customerIds: [input.customerId, input.candidateId],
        decision: "rejected",
        decidedBy: "staff",
        actor: input.actor,
        reason: input.reason?.trim() || null,
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      };
      await db.collection<StaffReviewDecisionDoc>(COLLECTIONS.staffReviewDecisions).replaceOne(
        { kind: decision.kind, subjectKey }, decision, { upsert: true, session }
      );
      await db.collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
        { _id: input.customerId, "pendingMerge.candidateId": input.candidateId },
        { $set: { pendingMerge: null, updatedAt: now } },
        { session }
      );
      await db.collection<AuditLogDoc>(COLLECTIONS.auditLogs).insertOne({
        _id: new ObjectId(),
        actor: input.actor,
        action: "customer.merge_rejected",
        customerId: input.customerId,
        before: { candidateId: input.candidateId },
        after: { remembered: true },
        reason: input.reason?.trim() || null,
        at: now,
      }, { session });
    });
  } finally {
    await session.endSession();
  }
}

export async function confirmPendingMerge(input: {
  customerId: string;
  candidateId: string;
  actor: string;
  reason?: string | null;
}): Promise<{ winnerId: string; loserId: string }> {
  const db = await getDb();
  const customers = db.collection<CustomerDoc>(COLLECTIONS.customers);
  const [customer, candidate] = await Promise.all([
    customers.findOne({ _id: input.customerId }),
    customers.findOne({ _id: input.candidateId }),
  ]);
  if (!customer || !candidate || customer.pendingMerge?.candidateId !== candidate._id) {
    throw new Error("pending_merge_changed");
  }
  if (customer.status !== "active" || candidate.status !== "active") {
    throw new Error("pending_merge_customer_inactive");
  }

  const { winner, loser } = await pickWinner(customer, candidate);
  await mergeCustomers(
    winner._id,
    loser._id,
    input.reason?.trim() || "เจ้าหน้าที่ยืนยันว่าเป็นลูกค้าคนเดียวกัน",
    input.actor
  );
  await customers.updateMany(
    { _id: { $in: [winner._id, loser._id] } },
    { $set: { pendingMerge: null } }
  );
  return { winnerId: winner._id, loserId: loser._id };
}
