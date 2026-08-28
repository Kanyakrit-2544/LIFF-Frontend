import type { ClientSession, Db, Filter } from "mongodb";
import { COLLECTIONS } from "../db/models";
import type { CustomerIntentDoc } from "./models";

function compareIntent(a: CustomerIntentDoc, b: CustomerIntentDoc): number {
  const time = b.observedAt.getTime() - a.observedAt.getTime();
  if (time !== 0) return time;
  if (a.source !== b.source) return a.source === "staff" ? -1 : 1;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  const created = b.createdAt.getTime() - a.createdAt.getTime();
  if (created !== 0) return created;
  return b._id.localeCompare(a._id);
}

export function currentIntent(rows: readonly CustomerIntentDoc[]): CustomerIntentDoc | null {
  return rows.filter((row) => row.customerId !== null && row.voidedAt === null).sort(compareIntent)[0] ?? null;
}

export async function intentRejectionReason(
  db: Db,
  draft: Pick<CustomerIntentDoc, "customerId" | "courseCode" | "source" | "observedAt">,
  excludeSourceEventId?: string,
  session?: ClientSession
): Promise<string | null> {
  if (!draft.customerId || draft.source !== "ai") return null;
  const rows = await db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents).find({
    customerId: draft.customerId,
    courseCode: draft.courseCode,
    voidedAt: null,
    ...(excludeSourceEventId ? { sourceEventId: { $ne: excludeSourceEventId } } : {}),
  }, { session }).toArray();
  const current = currentIntent(rows);
  if (!current || current.source !== "staff") return null;
  if (current.lock === "sticky") return "staff_sticky";
  return draft.observedAt.getTime() <= current.observedAt.getTime() ? "staff_decided" : null;
}

export async function recomputeIntentCurrent(
  db: Db,
  customerId: string,
  courseCode: string | null,
  now = new Date(),
  session?: ClientSession
): Promise<string | null> {
  const collection = db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents);
  const rows = await collection.find({ customerId, courseCode }, { session }).toArray();
  const winner = currentIntent(rows);

  const staleNullIds = rows
    .filter((row) => row.supersededAt === null && (!winner || row._id !== winner._id))
    .map((row) => row._id);
  if (staleNullIds.length > 0) {
    await collection.updateMany(
      { _id: { $in: staleNullIds } } as Filter<CustomerIntentDoc>,
      { $set: { supersededAt: now, updatedAt: now, "aiSync.dirty": true } },
      { session }
    );
  }
  if (winner && winner.supersededAt !== null) {
    await collection.updateOne(
      { _id: winner._id },
      { $set: { supersededAt: null, updatedAt: now, "aiSync.dirty": true } },
      { session }
    );
  }
  return winner?._id ?? null;
}
