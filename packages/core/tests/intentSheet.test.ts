import { describe, expect, it } from "vitest";
import {
  buildIntentSheetReport,
  buildIntentSheetRows,
  INTENT_SHEET_HEADERS,
  type CustomerIntentDoc,
  type IntentSheetCustomer,
} from "../src";

const at = (value: string) => new Date(value);

function intent(
  id: string,
  over: Partial<CustomerIntentDoc> = {}
): CustomerIntentDoc {
  const observedAt = at("2026-09-01T03:00:00.000Z");
  return {
    _id: id,
    customerId: "cus_1",
    courseCode: "INNER",
    status: "interested",
    hesitationReason: null,
    confidence: 0.92,
    belowThreshold: false,
    source: "ai",
    lock: "soft",
    model: "test-model",
    observedAt,
    supersededAt: null,
    voidedAt: null,
    partnerId: "test",
    sourceEventId: `event_${id}`,
    aiSync: { dirty: false, syncedAt: observedAt, lockedAt: null, attempts: 0 },
    createdAt: observedAt,
    updatedAt: observedAt,
    schemaVersion: 1,
    ...over,
  };
}

function customers(...rows: IntentSheetCustomer[]): ReadonlyMap<string, IntentSheetCustomer> {
  return new Map(rows.map((row) => [row._id, row]));
}

describe("Intent sheet", () => {
  it("⭐ แสดงเฉพาะ intent ปัจจุบัน ไม่เอา voided/superseded/unknown/ไม่มีเจ้าของ", () => {
    const report = buildIntentSheetReport([
      intent("current"),
      intent("superseded", { observedAt: at("2026-08-01T00:00:00Z"), supersededAt: at("2026-09-01T00:00:00Z") }),
      intent("voided", { voidedAt: at("2026-09-01T00:00:00Z") }),
      intent("unknown", { courseCode: "COMMU", status: "unknown" }),
      intent("unassigned", { customerId: null, courseCode: "PRESENT" }),
    ], customers({ _id: "cus_1", status: "active", displayName: "ลูกค้าปัจจุบัน" }));

    expect(report.summary).toEqual({ interested: 1, hesitant: 0, notInterested: 0 });
    expect(report.values).toHaveLength(3);
    expect(report.values[2]).toEqual(["ลูกค้าปัจจุบัน", "INNER", "สนใจ", "", "92%", "AI", "2026-09-01"]);
  });

  it("ถ้ามี current ซ้ำในคู่ลูกค้า+คอร์ส ใช้กฎ currentIntent และเรียงล่าสุดบน", () => {
    const rows = buildIntentSheetRows([
      intent("old-current", { observedAt: at("2026-09-01T01:00:00Z"), status: "hesitant", hesitationReason: "budget" }),
      intent("latest-current", { observedAt: at("2026-09-03T01:00:00Z"), status: "not_interested", hesitationReason: "not_needed", source: "staff", confidence: 1 }),
      intent("other-course", { courseCode: "COMMU", observedAt: at("2026-09-02T01:00:00Z"), status: "hesitant", hesitationReason: "timing_conflict", confidence: 0.745 }),
    ], customers({ _id: "cus_1", status: "active", displayName: "ลูกค้า 1" }));

    expect(rows.slice(2).map((row) => row[1])).toEqual(["INNER", "COMMU"]);
    expect(rows[2]).toEqual(["ลูกค้า 1", "INNER", "ไม่สนใจ", "ยังไม่เห็นความจำเป็น", "100%", "พนักงาน", "2026-09-03"]);
    expect(rows[3]).toEqual(["ลูกค้า 1", "COMMU", "ลังเล", "เวลาไม่สะดวก", "74.5%", "AI", "2026-09-02"]);
  });

  it("summary ตรงครบ 3 สถานะและหัวตารางมี 7 คอลัมน์", () => {
    const report = buildIntentSheetReport([
      intent("interested"),
      intent("hesitant", { customerId: "cus_2", status: "hesitant", hesitationReason: "not_ready" }),
      intent("not-interested", { customerId: "cus_3", status: "not_interested" }),
    ], customers(
      { _id: "cus_1", status: "active", displayName: "หนึ่ง" },
      { _id: "cus_2", status: "active", displayName: "สอง" },
      { _id: "cus_3", status: "active", displayName: "สาม" }
    ));
    expect(report.summary).toEqual({ interested: 1, hesitant: 1, notInterested: 1 });
    expect(report.values[0]).toEqual(["สรุป", "สนใจ 1", "ลังเล 1", "ไม่สนใจ 1", "", "", ""]);
    expect(report.values[1]).toEqual([...INTENT_SHEET_HEADERS]);
  });

  it("⭐ erased ซ่อนชื่อ และไม่ส่งข้อความแชทที่อาจติดมากับ input", () => {
    const secretChat = "ข้อความสนทนาที่ห้ามออกชีต";
    const row = { ...intent("erased"), rawMessage: secretChat } as CustomerIntentDoc & { rawMessage: string };
    const report = buildIntentSheetReport(
      [row],
      customers({ _id: "cus_1", status: "erased", displayName: "ชื่อที่ต้องซ่อน", lineDisplayName: "LINE ที่ต้องซ่อน" })
    );
    expect(report.values[2]![0]).toBe("");
    expect(JSON.stringify(report.values)).not.toContain("ชื่อที่ต้องซ่อน");
    expect(JSON.stringify(report.values)).not.toContain(secretChat);
  });
});
