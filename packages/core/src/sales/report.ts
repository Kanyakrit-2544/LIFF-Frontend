export type SalesCustomerKind = "new" | "returning";

export interface SalesCustomerInput {
  _id: string;
  displayName?: string | null;
  lineDisplayName?: string | null;
  nickname?: string | null;
  customerStatus: string;
  createdAt: Date;
}

export interface SalesPurchaseInput {
  _id: string;
  customerId: string | null;
  amount: number | null;
  paidAt: Date | null;
  status: "active" | "voided";
  createdAt: Date;
}

export interface SalesPurchaseItemInput {
  purchaseId: string;
  courseCode: string;
  countsAsSeat: boolean;
}

export interface SalesConfirmedLinkInput {
  customerId: string;
  legacyPersonId: string;
  status: string;
}

export interface LegacySalesSummary {
  totalPaid: number;
  lastPaidAt: Date | null;
}

export interface SalesRow {
  customerId: string;
  name: string | null;
  kind: SalesCustomerKind;
  customerStatus: string;
  lastActivityAt: Date;
  newPurchaseTotal: number;
  newSeatCount: number;
  courses: string[];
  legacyContext?: LegacySalesSummary;
}

export interface SalesReport {
  rows: SalesRow[];
  summary: {
    totalCustomers: number;
    newCount: number;
    returningCount: number;
    revenue: number;
    seatCount: number;
  };
}

export interface BuildSalesReportInput {
  customers: readonly SalesCustomerInput[];
  purchases: readonly SalesPurchaseInput[];
  purchaseItems: readonly SalesPurchaseItemInput[];
  confirmedLinks: readonly SalesConfirmedLinkInput[];
  legacySummaryByPerson: ReadonlyMap<string, LegacySalesSummary>;
}

export const SALES_SHEET_TAB = "สรุปการขาย";
export const SALES_SHEET_HEADERS = ["ชื่อ", "ประเภท", "คอร์สที่ซื้อ", "ยอดใหม่", "เคยจ่าย (เก่า)", "วันล่าสุด"] as const;
export type SalesSheetCell = string | number;

function latest(dates: readonly Date[]): Date {
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

/**
 * สร้างรายงานจาก purchase ใหม่ โดยยอดเงินอยู่ที่ระดับ purchase และถูกนับครั้งเดียวต่อบิล
 * D23: ผู้เรียกต้องส่งเฉพาะ customer_links ที่ confirmed; ฟังก์ชันกรองซ้ำอีกชั้นหนึ่ง
 */
export function buildSalesReport(input: BuildSalesReportInput): SalesReport {
  const activePurchases = input.purchases.filter(
    (purchase): purchase is SalesPurchaseInput & { customerId: string } =>
      purchase.status === "active" && typeof purchase.customerId === "string" && purchase.customerId.length > 0
  );
  const purchasesByCustomer = new Map<string, Array<SalesPurchaseInput & { customerId: string }>>();
  for (const purchase of activePurchases) {
    const rows = purchasesByCustomer.get(purchase.customerId) ?? [];
    rows.push(purchase);
    purchasesByCustomer.set(purchase.customerId, rows);
  }

  const activePurchaseIds = new Set(activePurchases.map((purchase) => purchase._id));
  const itemsByPurchase = new Map<string, SalesPurchaseItemInput[]>();
  for (const item of input.purchaseItems) {
    if (!activePurchaseIds.has(item.purchaseId)) continue;
    const rows = itemsByPurchase.get(item.purchaseId) ?? [];
    rows.push(item);
    itemsByPurchase.set(item.purchaseId, rows);
  }

  const legacyPeopleByCustomer = new Map<string, Set<string>>();
  for (const link of input.confirmedLinks) {
    if (link.status !== "confirmed") continue;
    const personIds = legacyPeopleByCustomer.get(link.customerId) ?? new Set<string>();
    personIds.add(link.legacyPersonId);
    legacyPeopleByCustomer.set(link.customerId, personIds);
  }

  const rows: SalesRow[] = [];
  for (const customer of input.customers) {
    const purchases = purchasesByCustomer.get(customer._id);
    if (!purchases?.length) continue;

    const items = purchases.flatMap((purchase) => itemsByPurchase.get(purchase._id) ?? []);
    const legacyPersonIds = legacyPeopleByCustomer.get(customer._id);
    const legacySummaries = [...(legacyPersonIds ?? [])]
      .flatMap((personId) => {
        const summary = input.legacySummaryByPerson.get(personId);
        return summary ? [summary] : [];
      });
    const legacyDates = legacySummaries.flatMap((summary) => summary.lastPaidAt ? [summary.lastPaidAt] : []);

    rows.push({
      customerId: customer._id,
      name: customer.displayName ?? customer.lineDisplayName ?? customer.nickname ?? null,
      kind: legacyPersonIds?.size ? "returning" : "new",
      customerStatus: customer.customerStatus,
      lastActivityAt: latest(purchases.map((purchase) => purchase.paidAt ?? purchase.createdAt ?? customer.createdAt)),
      newPurchaseTotal: purchases.reduce((sum, purchase) => sum + (purchase.amount ?? 0), 0),
      newSeatCount: items.filter((item) => item.countsAsSeat).length,
      courses: [...new Set(items.map((item) => item.courseCode.trim().toUpperCase()).filter(Boolean))].sort(),
      ...(legacySummaries.length ? {
        legacyContext: {
          totalPaid: legacySummaries.reduce((sum, summary) => sum + summary.totalPaid, 0),
          lastPaidAt: legacyDates.length ? latest(legacyDates) : null,
        },
      } : {}),
    });
  }

  rows.sort((left, right) =>
    right.lastActivityAt.getTime() - left.lastActivityAt.getTime()
    || left.customerId.localeCompare(right.customerId)
  );

  return {
    rows,
    summary: {
      totalCustomers: rows.length,
      newCount: rows.filter((row) => row.kind === "new").length,
      returningCount: rows.filter((row) => row.kind === "returning").length,
      revenue: rows.reduce((sum, row) => sum + row.newPurchaseTotal, 0),
      seatCount: rows.reduce((sum, row) => sum + row.newSeatCount, 0),
    },
  };
}

export function toSalesSheetRows(report: SalesReport): SalesSheetCell[][] {
  const { summary } = report;
  return [
    [
      "สรุป",
      `ลูกค้ารวม ${summary.totalCustomers} คน`,
      `🆕 ใหม่ ${summary.newCount} คน`,
      `🔁 กลับมาซื้อ ${summary.returningCount} คน`,
      `ยอดใหม่ ${summary.revenue} บาท`,
      `ที่นั่ง ${summary.seatCount}`,
    ],
    [...SALES_SHEET_HEADERS],
    ...report.rows.map((row) => [
      row.name ?? "",
      row.kind === "returning" ? "🔁 กลับมาซื้อ" : "🆕 ใหม่",
      row.courses.join(", "),
      row.newPurchaseTotal,
      row.legacyContext?.totalPaid ?? "",
      row.lastActivityAt.toISOString().slice(0, 10),
    ]),
  ];
}
