import { describe, expect, it } from "vitest";
import {
  buildSalesReport,
  SALES_SHEET_HEADERS,
  toSalesSheetRows,
  type SalesCustomerInput,
} from "../src/sales/report";

const customer = (id: string): SalesCustomerInput => ({
  _id: id,
  displayName: id,
  lineDisplayName: null,
  nickname: null,
  customerStatus: "customer",
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
});

describe("buildSalesReport", () => {
  it("⭐ จำแนก new/returning ด้วย confirmed link เท่านั้น และใช้ legacy เป็นบริบท", () => {
    const report = buildSalesReport({
      customers: [customer("cus_new"), customer("cus_returning"), customer("cus_unconfirmed")],
      purchases: [
        { _id: "pur_new", customerId: "cus_new", amount: 1_000, paidAt: new Date("2026-08-01"), status: "active", createdAt: new Date("2026-08-01") },
        { _id: "pur_returning", customerId: "cus_returning", amount: 5_000, paidAt: new Date("2026-08-03"), status: "active", createdAt: new Date("2026-08-03") },
        { _id: "pur_unconfirmed", customerId: "cus_unconfirmed", amount: 2_000, paidAt: new Date("2026-08-02"), status: "active", createdAt: new Date("2026-08-02") },
      ],
      purchaseItems: [],
      confirmedLinks: [
        { customerId: "cus_returning", legacyPersonId: "lgp_confirmed", status: "confirmed" },
        { customerId: "cus_unconfirmed", legacyPersonId: "lgp_hidden", status: "needs_review" },
      ],
      legacySummaryByPerson: new Map([
        ["lgp_confirmed", { totalPaid: 90_000, lastPaidAt: new Date("2025-12-01") }],
        ["lgp_hidden", { totalPaid: 999_999, lastPaidAt: new Date("2025-12-02") }],
      ]),
    });

    expect(report.rows.map((row) => [row.customerId, row.kind])).toEqual([
      ["cus_returning", "returning"],
      ["cus_unconfirmed", "new"],
      ["cus_new", "new"],
    ]);
    expect(report.rows[0]!.legacyContext?.totalPaid).toBe(90_000);
    expect(report.rows[1]!.legacyContext).toBeUndefined();
  });

  it("⭐ นับยอดหนึ่งครั้งต่อ purchase แม้มีหลายคอร์ส และไม่รวม voided/legacy", () => {
    const report = buildSalesReport({
      customers: [customer("cus_one")],
      purchases: [
        { _id: "pur_active", customerId: "cus_one", amount: 30_000, paidAt: new Date("2026-09-01"), status: "active", createdAt: new Date("2026-09-01") },
        { _id: "pur_voided", customerId: "cus_one", amount: 70_000, paidAt: new Date("2026-09-02"), status: "voided", createdAt: new Date("2026-09-02") },
      ],
      purchaseItems: [
        { purchaseId: "pur_active", courseCode: "INNER", countsAsSeat: true },
        { purchaseId: "pur_active", courseCode: "COMMU", countsAsSeat: true },
        { purchaseId: "pur_active", courseCode: "PRODUCT", countsAsSeat: false },
        { purchaseId: "pur_voided", courseCode: "TTRT", countsAsSeat: true },
      ],
      confirmedLinks: [{ customerId: "cus_one", legacyPersonId: "lgp_one", status: "confirmed" }],
      legacySummaryByPerson: new Map([["lgp_one", { totalPaid: 120_000, lastPaidAt: new Date("2025-01-01") }]]),
    });

    expect(report.rows[0]).toMatchObject({
      newPurchaseTotal: 30_000,
      newSeatCount: 2,
      courses: ["COMMU", "INNER", "PRODUCT"],
    });
    expect(report.summary).toEqual({
      totalCustomers: 1,
      newCount: 0,
      returningCount: 1,
      revenue: 30_000,
      seatCount: 2,
    });
  });

  it("เรียงล่าสุดก่อนและ summary ตรงกับแถว", () => {
    const report = buildSalesReport({
      customers: [customer("cus_old"), customer("cus_latest")],
      purchases: [
        { _id: "pur_old", customerId: "cus_old", amount: 100, paidAt: new Date("2026-01-01"), status: "active", createdAt: new Date("2026-01-01") },
        { _id: "pur_latest", customerId: "cus_latest", amount: 200, paidAt: new Date("2026-02-01"), status: "active", createdAt: new Date("2026-02-01") },
      ],
      purchaseItems: [],
      confirmedLinks: [],
      legacySummaryByPerson: new Map(),
    });

    expect(report.rows.map((row) => row.customerId)).toEqual(["cus_latest", "cus_old"]);
    expect(report.summary).toEqual({ totalCustomers: 2, newCount: 2, returningCount: 0, revenue: 300, seatCount: 0 });
  });
});

describe("toSalesSheetRows", () => {
  it("วาง summary ด้านบน หัวตารางถัดมา และคงลำดับจาก report", () => {
    const report = buildSalesReport({
      customers: [customer("cus_sheet")],
      purchases: [{ _id: "pur_sheet", customerId: "cus_sheet", amount: 2_500, paidAt: new Date("2026-08-20"), status: "active", createdAt: new Date("2026-08-20") }],
      purchaseItems: [{ purchaseId: "pur_sheet", courseCode: "INNER", countsAsSeat: true }],
      confirmedLinks: [],
      legacySummaryByPerson: new Map(),
    });
    const rows = toSalesSheetRows(report);

    expect(rows[0]).toEqual(["สรุป", "ลูกค้ารวม 1 คน", "🆕 ใหม่ 1 คน", "🔁 กลับมาซื้อ 0 คน", "ยอดใหม่ 2500 บาท", "ที่นั่ง 1"]);
    expect(rows[1]).toEqual([...SALES_SHEET_HEADERS]);
    expect(rows[2]).toEqual(["cus_sheet", "🆕 ใหม่", "INNER", 2_500, "", "2026-08-20"]);
  });
});
