import { describe, expect, it } from "vitest";
import {
  buildCompletedByCustomer,
  buildFollowUpRecommendations,
  buildUpsellRecommendations,
  followUpAction,
  nextCourses,
  type CourseHistoryRow,
  type FollowUpIntent,
  type RecommendationCustomer,
} from "../src/index";

const NOW = new Date("2026-09-02T00:00:00.000Z");

function customer(id: string, marketing = true, synthetic = false): RecommendationCustomer {
  return {
    _id: id,
    status: "active",
    displayName: `Customer ${id}`,
    lineDisplayName: null,
    consent: {
      dataProcessing: true,
      marketing,
      version: "test",
      grantedAt: NOW,
      ip: null,
      userAgent: null,
    },
    synthetic,
  };
}

function intent(over: Partial<FollowUpIntent> = {}): FollowUpIntent {
  return {
    customerId: "cus_1",
    courseCode: "INNER",
    status: "hesitant",
    hesitationReason: "budget",
    confidence: 0.81,
    observedAt: NOW,
    supersededAt: null,
    voidedAt: null,
    ...over,
  };
}

describe("course ladder สมมุติ", () => {
  it("INNER แตกไปคอร์สหลักถัดไปและคอร์สเสริม", () => {
    expect(nextCourses("inner")).toEqual(["COMMU", "DEEPIN", "INNERCAMP"]);
    expect(nextCourses("COMMU")).toEqual(["PRESENT"]);
    expect(nextCourses("PRESENT")).toEqual(["TTRT"]);
    expect(nextCourses("TTRT")).toEqual([]);
  });
});

describe("follow-up recommendations", () => {
  it("สร้าง recoId คงที่และแมปเหตุผลเป็นคำแนะนำ", () => {
    const customers = new Map([["cus_1", customer("cus_1")]]);
    const rows = buildFollowUpRecommendations([intent()], customers, new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recoId: "follow_up:cus_1:INNER",
      courseCode: "INNER",
      suggestedAction: "เสนอผ่อน / ส่วนลด",
      confidence: 0.81,
    });
    expect(followUpAction("timing_conflict")).toBe("เตือนรอบถัดไป");
    expect(followUpAction("not_ready")).toBe("เตือนรอบถัดไป");
    expect(followUpAction(null)).toBe("ตามผลทั่วไป");
  });

  it("ไม่แสดงคนที่ไม่ยินยอมการตลาด", () => {
    const customers = new Map([["cus_1", customer("cus_1", false)]]);
    expect(buildFollowUpRecommendations([intent()], customers, new Map())).toEqual([]);
  });

  it("ไม่แนะนำคอร์สที่ซื้อแล้ว", () => {
    const customers = new Map([["cus_1", customer("cus_1")]]);
    const purchased = new Map([["cus_1", new Set(["INNER"])]]);
    expect(buildFollowUpRecommendations([intent()], customers, purchased)).toEqual([]);
  });

  it("ตัด intent ที่ voided/superseded/ไม่ใช่ hesitant และใช้ตัวล่าสุดเมื่อซ้ำ", () => {
    const customers = new Map([["cus_1", customer("cus_1")]]);
    const latest = new Date(NOW.getTime() + 1_000);
    const rows = buildFollowUpRecommendations([
      intent({ voidedAt: NOW }),
      intent({ supersededAt: NOW }),
      intent({ status: "interested" }),
      intent({ confidence: 0.4 }),
      intent({ confidence: 0.9, observedAt: latest, synthetic: true }),
    ], customers, new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ confidence: 0.9, observedAt: latest, synthetic: true });
  });
});

describe("upsell recommendations", () => {
  function build(rows: CourseHistoryRow[]) {
    const customers = new Map([["cus_1", customer("cus_1")]]);
    return buildUpsellRecommendations(buildCompletedByCustomer(rows, NOW), customers);
  }

  it("INNER ที่เรียนจบแล้วแนะนำ COMMU และคอร์สเสริมด้วย ID คงที่", () => {
    const rows = build([{
      customerId: "cus_1", courseCode: "INNER", countsAsSeat: true,
      sessionStart: new Date("2026-08-01"), source: "partner",
    }]);
    expect(rows.map((row) => row.recoId).sort()).toEqual([
      "upsell:cus_1:COMMU",
      "upsell:cus_1:DEEPIN",
      "upsell:cus_1:INNERCAMP",
    ]);
  });

  it("วันในอนาคตหรือ countsAsSeat=false ยังไม่ถือว่าเรียนจบ", () => {
    expect(build([
      { customerId: "cus_1", courseCode: "INNER", countsAsSeat: true, sessionStart: new Date("2026-10-01"), source: "partner" },
      { customerId: "cus_1", courseCode: "COMMU", countsAsSeat: false, sessionStart: new Date("2026-08-01"), source: "partner" },
    ])).toEqual([]);
  });

  it("คอร์สถัดไปที่ซื้อไว้แล้วไม่ถูกแนะนำ แม้ยังไม่ถึงวันเรียน", () => {
    const rows = build([
      { customerId: "cus_1", courseCode: "INNER", countsAsSeat: true, sessionStart: new Date("2026-08-01"), source: "legacy" },
      { customerId: "cus_1", courseCode: "COMMU", countsAsSeat: true, sessionStart: new Date("2026-10-01"), source: "partner" },
    ]);
    expect(rows.map((row) => row.courseCode).sort()).toEqual(["DEEPIN", "INNERCAMP"]);
  });

  it("เลือกวันที่เรียนจบล่าสุดและติดป้าย synthetic จากประวัติ", () => {
    const rows = build([
      { customerId: "cus_1", courseCode: "COMMU", countsAsSeat: true, sessionStart: new Date("2026-07-01"), source: "partner" },
      { customerId: "cus_1", courseCode: "COMMU", countsAsSeat: true, sessionStart: new Date("2026-08-01"), source: "legacy", synthetic: true },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recoId: "upsell:cus_1:PRESENT",
      completedAt: new Date("2026-08-01"),
      source: "legacy",
      synthetic: true,
    });
  });
});
