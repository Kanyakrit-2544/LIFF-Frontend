import type { Db } from "mongodb";
import {
  AI_COLLECTIONS,
  COLLECTIONS,
  type CustomerDoc,
  type CustomerLinkDoc,
  type RecommendationReviewDoc,
} from "../db/models";
import { LEGACY_COLLECTIONS, type LegacyEnrollmentDoc } from "../legacy/models";
import type { CustomerIntentDoc, PurchaseDoc, PurchaseItemDoc } from "../partner/models";
import {
  buildFollowUpRecommendations,
  type FollowUpIntent,
  type FollowUpReco,
  type RecommendationCustomer,
} from "./followUp";
import {
  buildCompletedByCustomer,
  buildUpsellRecommendations,
  type CourseHistoryRow,
  type UpsellReco,
} from "./upsell";

type Synthetic<T> = T & { synthetic?: boolean };

export interface SalesOpportunities {
  followUps: FollowUpReco[];
  upsells: UpsellReco[];
}

function groupSet(rows: readonly CourseHistoryRow[]): Map<string, ReadonlySet<string>> {
  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    const current = result.get(row.customerId) ?? new Set<string>();
    current.add(row.courseCode.trim().toUpperCase());
    result.set(row.customerId, current);
  }
  return result;
}

/**
 * อ่านข้อมูลสำหรับหน้าโอกาสการขายแบบ batch
 * D23: legacy enrollment เข้ามาได้ผ่าน customer_links ที่ confirmed เท่านั้น
 */
export async function listSalesOpportunities(
  mainDb: Db,
  aiDb: Db,
  legacyDb: Db,
  now = new Date()
): Promise<SalesOpportunities> {
  const [intents, purchases, confirmedLinks] = await Promise.all([
    mainDb.collection<Synthetic<CustomerIntentDoc>>(COLLECTIONS.customerIntents).find({
      status: "hesitant",
      customerId: { $type: "string" },
      courseCode: { $type: "string" },
      supersededAt: null,
      voidedAt: null,
    }).toArray(),
    mainDb.collection<Synthetic<PurchaseDoc>>(COLLECTIONS.purchases).find({
      status: "active",
      customerId: { $type: "string" },
    }).toArray(),
    aiDb.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks).find({ status: "confirmed" }).toArray(),
  ]);

  const purchaseIds = purchases.map((row) => row._id);
  const legacyPersonIds = [...new Set(confirmedLinks.map((row) => row.legacyPersonId))];
  const [partnerItems, legacyEnrollments] = await Promise.all([
    purchaseIds.length
      ? mainDb.collection<Synthetic<PurchaseItemDoc>>(COLLECTIONS.purchaseItems)
        .find({ purchaseId: { $in: purchaseIds } }).toArray()
      : Promise.resolve([]),
    legacyPersonIds.length
      ? legacyDb.collection<LegacyEnrollmentDoc>(LEGACY_COLLECTIONS.enrollments)
        .find({ personId: { $in: legacyPersonIds } }).toArray()
      : Promise.resolve([]),
  ]);

  const purchaseById = new Map(purchases.map((row) => [row._id, row]));
  const customersByLegacyPerson = new Map<string, string[]>();
  for (const link of confirmedLinks) {
    const customerIds = customersByLegacyPerson.get(link.legacyPersonId) ?? [];
    customerIds.push(link.customerId);
    customersByLegacyPerson.set(link.legacyPersonId, customerIds);
  }

  const history: CourseHistoryRow[] = [];
  for (const item of partnerItems) {
    const purchase = purchaseById.get(item.purchaseId);
    if (!purchase?.customerId) continue;
    history.push({
      customerId: purchase.customerId,
      courseCode: item.courseCode,
      countsAsSeat: item.countsAsSeat,
      sessionStart: item.sessionStart,
      source: "partner",
      synthetic: item.synthetic === true || purchase.synthetic === true,
    });
  }
  for (const enrollment of legacyEnrollments) {
    for (const customerId of customersByLegacyPerson.get(enrollment.personId) ?? []) {
      history.push({
        customerId,
        courseCode: enrollment.courseCode,
        countsAsSeat: enrollment.countsAsSeat,
        sessionStart: enrollment.sessionStart,
        source: "legacy",
        synthetic: enrollment.synthetic,
      });
    }
  }

  const customerIds = [...new Set([
    ...intents.flatMap((row) => row.customerId ? [row.customerId] : []),
    ...history.map((row) => row.customerId),
  ])];
  const customers = customerIds.length
    ? await mainDb.collection<Synthetic<CustomerDoc>>(COLLECTIONS.customers)
      .find({ _id: { $in: customerIds }, status: "active" }).toArray()
    : [];
  const customersById = new Map<string, RecommendationCustomer>(customers.map((row) => [row._id, row]));

  const followUps = buildFollowUpRecommendations(
    intents as FollowUpIntent[],
    customersById,
    groupSet(history)
  );
  const upsells = buildUpsellRecommendations(buildCompletedByCustomer(history, now), customersById);
  const recoIds = [...followUps, ...upsells].map((row) => row.recoId);
  if (recoIds.length === 0) return { followUps, upsells };

  const reviewed = await mainDb.collection<RecommendationReviewDoc>(COLLECTIONS.recommendationReviews)
    .find({ _id: { $in: recoIds } }, { projection: { _id: 1 } }).toArray();
  const reviewedIds = new Set(reviewed.map((row) => row._id));
  return {
    followUps: followUps.filter((row) => !reviewedIds.has(row.recoId)),
    upsells: upsells.filter((row) => !reviewedIds.has(row.recoId)),
  };
}
