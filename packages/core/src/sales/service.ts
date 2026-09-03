import type { Db, Filter } from "mongodb";
import { AI_COLLECTIONS, COLLECTIONS, type CustomerDoc, type CustomerLinkDoc } from "../db/models";
import { LEGACY_COLLECTIONS, type LegacyPersonDoc } from "../legacy/models";
import type { PurchaseDoc, PurchaseItemDoc } from "../partner/models";
import {
  buildSalesReport,
  type LegacySalesSummary,
  type SalesReport,
} from "./report";

export interface SalesReportRange {
  from?: Date;
  to?: Date;
}

/** อ่านข้อมูลรายงานแบบ batch และเปิดทางไป legacy เฉพาะ confirmed links ตาม D23 */
export async function listSalesReport(
  mainDb: Db,
  aiDb: Db,
  legacyDb: Db,
  range?: SalesReportRange
): Promise<SalesReport> {
  const paidAt: { $gte?: Date; $lte?: Date } = {};
  if (range?.from) paidAt.$gte = range.from;
  if (range?.to) paidAt.$lte = range.to;
  const purchaseFilter: Filter<PurchaseDoc> = {
    status: "active",
    customerId: { $type: "string" },
    ...(Object.keys(paidAt).length ? { paidAt } : {}),
  };
  const purchases = await mainDb.collection<PurchaseDoc>(COLLECTIONS.purchases)
    .find(purchaseFilter)
    .toArray();
  if (purchases.length === 0) return buildSalesReport({
    customers: [], purchases: [], purchaseItems: [], confirmedLinks: [], legacySummaryByPerson: new Map(),
  });

  const customerIds = [...new Set(purchases.flatMap((purchase) => purchase.customerId ? [purchase.customerId] : []))];
  const purchaseIds = purchases.map((purchase) => purchase._id);
  const [customers, purchaseItems, confirmedLinks] = await Promise.all([
    mainDb.collection<CustomerDoc>(COLLECTIONS.customers)
      .find({ _id: { $in: customerIds } })
      .toArray(),
    mainDb.collection<PurchaseItemDoc>(COLLECTIONS.purchaseItems)
      .find({ purchaseId: { $in: purchaseIds } })
      .toArray(),
    aiDb.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks)
      .find({ customerId: { $in: customerIds }, status: "confirmed" })
      .toArray(),
  ]);

  const legacyPersonIds = [...new Set(confirmedLinks.map((link) => link.legacyPersonId))];
  const legacyPeople = legacyPersonIds.length
    ? await legacyDb.collection<LegacyPersonDoc>(LEGACY_COLLECTIONS.persons)
      .find({ _id: { $in: legacyPersonIds } }, { projection: { totalPaid: 1, lastPaidAt: 1 } })
      .toArray()
    : [];
  const legacySummaryByPerson = new Map<string, LegacySalesSummary>(legacyPeople.map((person) => [
    person._id,
    { totalPaid: person.totalPaid, lastPaidAt: person.lastPaidAt },
  ]));

  return buildSalesReport({ customers, purchases, purchaseItems, confirmedLinks, legacySummaryByPerson });
}
