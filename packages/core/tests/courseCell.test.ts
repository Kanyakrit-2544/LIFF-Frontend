import { describe, it, expect } from "vitest";
import { parseCourseCell } from "../src/legacy/courseCell";
import { courseByHeader, COURSES } from "../src/legacy/courses";

const p = (v: string, year = 2025) => parseCourseCell(v, year);
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

describe("parseCourseCell — รอบเรียนปกติ", () => {
  it("เซลล์ว่าง = ไม่ได้ลงคอร์สนี้", () => {
    expect(p("")).toBeNull();
    expect(p("   ")).toBeNull();
  });

  it("แกะวันแรกของรอบ", () => {
    expect(iso(p("27-28 Jun")!.sessionStart)).toBe("2025-06-27");
    expect(iso(p("31 May - 1 Jun")!.sessionStart)).toBe("2025-05-31");
    expect(iso(p("28 Feb-1 Mar")!.sessionStart)).toBe("2025-02-28");
  });

  it("⭐ '30,31 Jan-1 Feb' ต้องได้ 30 ไม่ใช่ 31 — วันแรกของรอบคือวันที่จัดจริง", () => {
    expect(iso(p("30,31 Jan-1 Feb")!.sessionStart)).toBe("2025-01-30");
  });

  it("เลข 2 หลักท้ายชื่อเดือน = ปี ไม่ใช่วัน (รอบข้ามปี)", () => {
    const r = p("17-18 Jan 26")!;
    expect(iso(r.sessionStart)).toBe("2026-01-17");
    expect(r.sessionYear).toBe(2026);
  });

  it("ระบุแค่เดือน → precision เป็น month ไม่เดาวัน", () => {
    const r = p("Oct")!;
    expect(r.sessionPrecision).toBe("month");
    expect(iso(r.sessionStart)).toBe("2025-10-01");
  });

  it("D-1 เป็นชื่อรอบย่อย ไม่ใช่วันที่", () => {
    expect(iso(p("27-28 Jun D-1")!.sessionStart)).toBe("2025-06-27");
  });
});

describe("parseCourseCell — ชนิดรายการ", () => {
  it("⭐ relearn/free/waitlist/refund ไม่นับเป็นที่นั่งที่ขายได้", () => {
    for (const cell of ["RL 30-31 Aug", "Free 17-18 Jan", "Wait", "คืนเงิน", "หนังสือ RL", "ค่าปรับ 6980"]) {
      expect(p(cell)!.countsAsSeat, cell).toBe(false);
    }
  });

  it("รอบเรียนปกติเท่านั้นที่นับเป็นที่นั่ง", () => {
    expect(p("27-28 Jun")!.countsAsSeat).toBe(true);
    expect(p("27-28 Jun")!.kind).toBe("enrolled");
  });

  it("RL ยังเก็บรอบไว้ได้ ไม่ทิ้งข้อมูล", () => {
    const r = p("RL 30-31 Aug")!;
    expect(r.kind).toBe("relearn");
    expect(iso(r.sessionStart)).toBe("2025-08-30");
  });

  it("Free ชนะ RL เพราะสะท้อนว่าไม่มีรายได้", () => {
    expect(p("Free RL 15-16 Nov")!.kind).toBe("free");
  });

  it("รายการปรับอ้างเลขสลิปได้", () => {
    const r = p("เพิ่ม IN-6806-00164")!;
    expect(r.kind).toBe("adjustment");
    expect(r.refSlip).toBe("IN-6806-00164");
    expect(r.countsAsSeat).toBe(false);
  });

  it("ย้ายเรียนไม่นับที่นั่ง แม้จะมีรอบเขียนอยู่", () => {
    const r = p("8-9 Mar ย้ายเรียน IN")!;
    expect(r.kind).toBe("transfer");
    expect(r.countsAsSeat).toBe(false);
    expect(iso(r.sessionStart)).toBe("2025-03-08");
  });

  it("สินค้า/ค่าห้องพักไม่ใช่ที่นั่งคอร์ส", () => {
    for (const cell of ["หนังสือ", "ผ้าคลุม", "ห้องพัก", "พักเดี่ยว"]) {
      expect(p(cell)!.kind, cell).toBe("merchandise");
    }
  });

  it("เขียนอะไรที่แกะไม่ออก = unknown ไม่ใช่ขายได้", () => {
    const r = p("2026.0")!;
    expect(r.kind).toBe("unknown");
    expect(r.countsAsSeat).toBe(false);
  });
});

describe("parseCourseCell — PII ในเซลล์", () => {
  it("⭐ ติดธง substitute เมื่อเซลล์มีชื่อคนจริง และตัดชื่อออกจาก sessionLabel", () => {
    const r = p("13-14 Jun คุณสมชาย ใจดี เรียนแทน")!;
    expect(r.substitute).toBe(true);
    expect(r.sessionLabel).toBe("13-14 Jun");
    expect(r.sessionLabel).not.toContain("สมชาย");
    expect(iso(r.sessionStart)).toBe("2025-06-13");
  });

  it("raw ยังเก็บข้อความเดิมไว้ (ฐาน legacy เป็น plaintext) ให้ชั้น scrub เป็นคนตัด", () => {
    expect(p("13-14 Jun คุณสมชาย ใจดี เรียนแทน")!.raw).toContain("สมชาย");
  });
});

describe("พจนานุกรมคอร์ส", () => {
  it("หัวคอลัมน์ของชีต 2025–2026 แปลได้ครบ", () => {
    const headers = ["Inner", "Commu", "Present", "TTRT", "Deep In", "Inner Camp", "อื่น ๆ"];
    expect(headers.map((h) => courseByHeader(h)?.code)).toEqual([
      "INNER", "COMMU", "PRESENT", "TTRT", "DEEPIN", "INNERCAMP", "OTHER",
    ]);
  });

  it("ไม่ต่างตัวพิมพ์เล็กใหญ่/ช่องว่างเกิน", () => {
    expect(courseByHeader("  DEEP  IN ")?.code).toBe("DEEPIN");
  });

  it("หัวคอลัมน์ที่ไม่รู้จักคืน null — ให้ผู้เรียกรายงาน ไม่ใช่เดา", () => {
    expect(courseByHeader("MC Pro#5")).toBeNull();
  });

  it("รหัสคอร์สไม่ซ้ำ", () => {
    expect(new Set(COURSES.map((c) => c.code)).size).toBe(COURSES.length);
  });
});
