import { describe, it, expect } from "vitest";
import { SHEET_COLUMNS, SYSTEM_COLUMNS, HEADERS, columnLetter, systemRange, toSheetRow } from "../src/customers/toSheetRow";
import { packPhone, packEmail } from "../src/security/pii";
import { normalizePhone } from "../src/identity/normalize";
import type { CustomerDoc } from "../src/db/models";

const base = (o: Partial<CustomerDoc> = {}): CustomerDoc => ({
  _id: "cus_01TEST", status: "active", mergedInto: null,
  displayName: "สมชาย ใจดี", nickname: "ชาย", fullNameEn: "Somchai Jaidee", birthYear: 2535,
  lineDisplayName: "Somchai", pictureUrl: null, facebook: "fb.somchai", instagram: null,
  phone: packPhone(normalizePhone("0812345678")!), email: packEmail("somchai@gmail.com"),
  phoneHash: "h", emailHash: "h", customerStatus: "lead", tags: ["line-follower"],
  source: { channel: "line", campaign: null }, sources: ["line"],
  consent: { dataProcessing: true, marketing: false, version: "v1", grantedAt: new Date("2026-08-01"), ip: null, userAgent: null },
  profileRef: { revision: 1, formId: "f", formVersion: "v1", updatedAt: new Date("2026-08-02") },
  pendingMerge: null,
  sheetSync: { dirty: true, rowKey: "cus_01TEST", syncedAt: null, lockedAt: null, attempts: 0 },
  counters: { milestones: 1, formSubmits: 1 },
  firstInteractionAt: new Date("2026-07-01"), firstMessageAt: new Date("2026-07-02"),
  lastInteractionAt: new Date("2026-08-02"), createdAt: new Date("2026-07-01"), updatedAt: new Date("2026-08-03T10:20:00Z"),
  schemaVersion: 1, ...o,
});

describe("columnLetter", () => {
  it("แปลงเลขคอลัมน์เป็นตัวอักษร", () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(columnLetter)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA"]);
  });
});

describe("นิยามคอลัมน์", () => {
  it("⭐ staffNote ต้องเป็นคอลัมน์สุดท้ายเสมอ — ไม่งั้นระบบจะเขียนทับหมายเหตุพนักงาน", () => {
    expect(SHEET_COLUMNS.at(-1)!.id).toBe("staffNote");
    expect(SHEET_COLUMNS.at(-1)!.owner).toBe("staff");
  });
  it("มีคอลัมน์ของพนักงานแค่ตัวเดียวและอยู่ท้าย", () => {
    const staffIdx = SHEET_COLUMNS.map((c, i) => (c.owner === "staff" ? i : -1)).filter((i) => i >= 0);
    expect(staffIdx).toEqual([SHEET_COLUMNS.length - 1]);
  });
  it("customerId เป็นคอลัมน์แรก (ใช้หาแถว)", () => {
    expect(SHEET_COLUMNS[0]!.id).toBe("customerId");
  });
  it("ไม่มี id ซ้ำ", () => {
    expect(new Set(SHEET_COLUMNS.map((c) => c.id)).size).toBe(SHEET_COLUMNS.length);
  });
  it("systemRange ไม่กินคอลัมน์ของพนักงาน", () => {
    expect(systemRange(5)).toBe(`Customers!A5:${columnLetter(SYSTEM_COLUMNS.length - 1)}5`);
    expect(SYSTEM_COLUMNS.length).toBe(HEADERS.length - 1);
  });
});

describe("toSheetRow", () => {
  it("จำนวนช่องตรงกับคอลัมน์ของระบบ", () => {
    expect(toSheetRow(base()).length).toBe(SYSTEM_COLUMNS.length);
  });
  it("คำนวณอายุจากปีเกิด ไม่เก็บอายุตรง ๆ", () => {
    const row = toSheetRow(base());
    const i = SYSTEM_COLUMNS.findIndex((c) => c.id === "age");
    expect(row[i]).toBe(String(new Date().getFullYear() + 543 - 2535));
  });
  it("ถอดรหัสเบอร์/อีเมลได้เมื่อโหมด full", () => {
    const row = toSheetRow(base());
    expect(row[SYSTEM_COLUMNS.findIndex((c) => c.id === "phone")]).toBe("+66812345678");
    expect(row[SYSTEM_COLUMNS.findIndex((c) => c.id === "email")]).toBe("somchai@gmail.com");
  });
  it("ถอดรหัสไม่ได้ → ใช้ค่า mask ไม่ทำให้ทั้งรอบล้ม", () => {
    const c = base({ phone: { hash: "h", enc: "v1:เสีย:เสีย:เสีย", masked: "08x-xxx-5678" } });
    expect(() => toSheetRow(c)).not.toThrow();
    expect(toSheetRow(c)[SYSTEM_COLUMNS.findIndex((x) => x.id === "phone")]).toBe("08x-xxx-5678");
  });
  it("ค่าว่างเป็นสตริงว่าง ไม่ใช่ null/undefined", () => {
    const row = toSheetRow(base({ nickname: null, birthYear: null, email: null, firstMessageAt: null }));
    expect(row.every((v) => typeof v === "string")).toBe(true);
  });
  it("วันที่เป็น YYYY-MM-DD อ่านง่ายในชีต", () => {
    const row = toSheetRow(base());
    expect(row[SYSTEM_COLUMNS.findIndex((c) => c.id === "firstInteractionAt")]).toBe("2026-07-01");
  });
  it("PDPA แสดงเครื่องหมายพร้อมวันที่", () => {
    const row = toSheetRow(base());
    expect(row[SYSTEM_COLUMNS.findIndex((c) => c.id === "consent")]).toBe("✓ 2026-08-01");
    expect(toSheetRow(base({ consent: null }))[SYSTEM_COLUMNS.findIndex((c) => c.id === "consent")]).toBe("✗");
  });
  it("ธง pendingMerge โผล่ในชีตให้พนักงานเห็น", () => {
    const i = SYSTEM_COLUMNS.findIndex((c) => c.id === "pendingMerge");
    expect(toSheetRow(base())[i]).toBe("");
    expect(toSheetRow(base({ pendingMerge: { candidateId: "cus_อื่น", reason: "phone_match", at: new Date() } }))[i]).toBe("cus_อื่น");
  });
});
