import type { Db } from "mongodb";
import { AI_COLLECTIONS, COLLECTIONS, type CustomerDoc, type CustomerLinkDoc } from "../db/models";
import { courseByCode } from "../legacy/courses";
import {
  LEGACY_COLLECTIONS,
  type LegacyEnrollmentDoc,
  type LegacyPaymentDoc,
} from "../legacy/models";
import type { PurchaseDoc, PurchaseItemDoc } from "../partner/models";

export interface CustomerPurchaseRow {
  source: "partner" | "legacy";
  paidAt: string | null;
  amount: number | null;
  saleRep: string | null;
  courses: Array<{
    courseCode: string;
    courseNameTh: string;
    kind: string;
    countsAsSeat: boolean;
    sessionLabel: string | null;
  }>;
}

export interface CustomerProfile {
  customerId: string;
  displayName: string | null;
  phone: string | null;
  email: string | null;
  heardFrom: string | null;
  customerStatus: string;
  status: string;
  totalPaid: number;
  paymentCount: number;
  seatCount: number;
  firstPaidAt: string | null;
  lastPaidAt: string | null;
  courseCodes: string[];
  purchases: CustomerPurchaseRow[];
  linkedLegacyPersonIds: string[];
  hasUnconfirmedLinks: boolean;
  legacyHidden: boolean;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function course(code: string, label: string, kind: string, countsAsSeat: boolean, sessionLabel: string | null) {
  return {
    courseCode: code,
    courseNameTh: courseByCode(code)?.nameTh ?? label,
    kind,
    countsAsSeat,
    sessionLabel,
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    const list = grouped.get(value) ?? [];
    list.push(row);
    grouped.set(value, list);
  }
  return grouped;
}

/**
 * รวมประวัติซื้อรายบุคคลสำหรับหน้า admin แบบ read-only
 *
 * D23: legacyPersonId ที่ออกจากฟังก์ชันนี้มาจาก confirmed links เท่านั้น
 * D44: ยอดเงินอยู่ที่ payment/purchase และถูกบวกครั้งเดียวต่อการชำระ
 */
export async function getCustomerProfile(
  mainDb: Db,
  aiDb: Db,
  legacyDb: Db,
  customerId: string
): Promise<CustomerProfile | null> {
  const customer = await mainDb.collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: customerId });
  if (!customer) return null;

  const [partnerPurchases, confirmedLinks, unconfirmedCount] = await Promise.all([
    mainDb.collection<PurchaseDoc>(COLLECTIONS.purchases)
      .find({ customerId, status: "active" })
      .sort({ paidAt: -1 })
      .toArray(),
    aiDb.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks)
      .find({ customerId, status: "confirmed" })
      .toArray(),
    aiDb.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks)
      .countDocuments({ customerId, status: { $in: ["auto", "needs_review"] } }),
  ]);

  const partnerPurchaseIds = partnerPurchases.map((row) => row._id);
  const linkedLegacyPersonIds = [...new Set(confirmedLinks.map((row) => row.legacyPersonId))];

  const [partnerItems, legacyPayments, legacyEnrollments] = await Promise.all([
    partnerPurchaseIds.length
      ? mainDb.collection<PurchaseItemDoc>(COLLECTIONS.purchaseItems)
        .find({ purchaseId: { $in: partnerPurchaseIds } })
        .toArray()
      : Promise.resolve([]),
    linkedLegacyPersonIds.length
      ? legacyDb.collection<LegacyPaymentDoc>(LEGACY_COLLECTIONS.payments)
        .find({ personId: { $in: linkedLegacyPersonIds } })
        .sort({ paidAt: -1 })
        .toArray()
      : Promise.resolve([]),
    linkedLegacyPersonIds.length
      ? legacyDb.collection<LegacyEnrollmentDoc>(LEGACY_COLLECTIONS.enrollments)
        .find({ personId: { $in: linkedLegacyPersonIds } })
        .toArray()
      : Promise.resolve([]),
  ]);

  const partnerItemsByPurchase = groupBy(partnerItems, (row) => row.purchaseId);
  const legacyEnrollmentsByPayment = groupBy(legacyEnrollments, (row) => row.paymentId);

  const purchases: CustomerPurchaseRow[] = [
    ...partnerPurchases.map((payment) => ({
      source: "partner" as const,
      paidAt: iso(payment.paidAt),
      amount: payment.amount,
      saleRep: payment.saleRep,
      courses: (partnerItemsByPurchase.get(payment._id) ?? []).map((item) =>
        course(item.courseCode, item.courseLabel, item.kind, item.countsAsSeat, item.sessionLabel)
      ),
    })),
    ...legacyPayments.map((payment) => ({
      source: "legacy" as const,
      paidAt: iso(payment.paidAt),
      amount: payment.amount,
      saleRep: payment.saleRep,
      courses: (legacyEnrollmentsByPayment.get(payment._id) ?? []).map((item) =>
        course(item.courseCode, item.courseLabel, item.kind, item.countsAsSeat, item.sessionLabel)
      ),
    })),
  ].sort((left, right) => (right.paidAt ?? "").localeCompare(left.paidAt ?? ""));

  const paidDates = purchases.flatMap((row) => row.paidAt ? [row.paidAt] : []).sort();
  const hasUnconfirmedLinks = unconfirmedCount > 0;
  const erased = customer.status === "erased";

  return {
    customerId: customer._id,
    displayName: erased ? null : customer.displayName ?? customer.lineDisplayName,
    phone: erased ? null : customer.phone,
    email: erased ? null : customer.email,
    heardFrom: erased ? null : customer.heardFrom,
    customerStatus: customer.customerStatus,
    status: customer.status,
    totalPaid: purchases.reduce((sum, row) => sum + (row.amount ?? 0), 0),
    paymentCount: purchases.length,
    seatCount: purchases.reduce(
      (sum, row) => sum + row.courses.filter((item) => item.countsAsSeat).length,
      0
    ),
    firstPaidAt: paidDates[0] ?? null,
    lastPaidAt: paidDates.at(-1) ?? null,
    courseCodes: [...new Set(purchases.flatMap((row) => row.courses.map((item) => item.courseCode)))].sort(),
    purchases,
    linkedLegacyPersonIds,
    hasUnconfirmedLinks,
    legacyHidden: hasUnconfirmedLinks,
  };
}
