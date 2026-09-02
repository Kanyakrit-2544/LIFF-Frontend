import { describe, it, expect } from "vitest";
import { importLegacyRows, type LegacyRawRow } from "../src/legacy/importReal";

/** ช่วยสร้างแถวดิบให้อ่านง่ายในเทส */
function row(
  rowNumber: number,
  fields: LegacyRawRow["fields"],
  courses: LegacyRawRow["courses"] = []
): LegacyRawRow {
  return { rowNumber, fields, courses };
}

const run = (rows: LegacyRawRow[], sheet = "Inner2025") =>
  importLegacyRows({ sheets: [{ sheet, rows }], importRunId: "job_TEST", now: new Date("2026-09-02T00:00:00Z") });

describe("importLegacyRows — โครงพื้นฐาน", () => {
  it("ข้อมูลจริงต้องติดธง synthetic:false ทุก doc", () => {
    const out = run([
      row(2, { fullNameTh: "ก ข", phone: "0812345678", amount: 6900, paidAt: new Date("2025-03-10") }, [
        { label: "Inner", value: "8-9 Mar" },
      ]),
    ]);
    expect(out.persons[0]!.synthetic).toBe(false);
    expect(out.payments[0]!.synthetic).toBe(false);
    expect(out.enrollments[0]!.synthetic).toBe(false);
    expect(out.persons[0]!.importRunId).toBe("job_TEST");
  });

  it("แถวว่าง/ไม่มีสัญญาณการชำระ = skipped ไม่สร้าง doc", () => {
    const out = run([
      row(2, {}, []),
      row(3, { nickname: "ปอ" }, [{ label: "Inner", value: "" }]),
    ]);
    expect(out.skipped).toBe(2);
    expect(out.persons).toHaveLength(0);
    expect(out.payments).toHaveLength(0);
    expect(out.rows).toBe(2);
  });
});

describe("importLegacyRows — dedupe คน", () => {
  it("เบอร์เดียวกัน 2 แถว = คนเดียว 2 การชำระ", () => {
    const out = run([
      row(2, { fullNameTh: "สมชาย", phone: "0812345678", amount: 6900, paidAt: new Date("2025-01-05") }, [
        { label: "Inner", value: "10-11 Jan" },
      ]),
      row(3, { phone: "0812345678", amount: 3900, paidAt: new Date("2025-06-05") }, [
        { label: "Commu", value: "20-21 Jun" },
      ]),
    ]);
    expect(out.persons).toHaveLength(1);
    expect(out.payments).toHaveLength(2);
    const p = out.persons[0]!;
    expect(p.paymentCount).toBe(2);
    expect(p.totalPaid).toBe(6900 + 3900);
    expect(p.seatCount).toBe(2);
    expect(p.courseCodes.sort()).toEqual(["COMMU", "INNER"]);
    // first/last paid ครอบช่วงถูก
    expect(p.firstPaidAt?.toISOString().slice(0, 10)).toBe("2025-01-05");
    expect(p.lastPaidAt?.toISOString().slice(0, 10)).toBe("2025-06-05");
  });

  it("ไม่มีเบอร์ ใช้อีเมล (lowercase) เป็นคีย์", () => {
    const out = run([
      row(2, { email: "A@Mail.com", amount: 1000, paidAt: new Date("2025-02-01") }),
      row(3, { email: "a@mail.com", amount: 2000, paidAt: new Date("2025-03-01") }),
    ]);
    expect(out.persons).toHaveLength(1);
    expect(out.persons[0]!.email).toBe("a@mail.com");
    expect(out.persons[0]!.totalPaid).toBe(3000);
  });

  it("ไม่มีทั้งเบอร์และอีเมล = แยกไม่ได้ ถือคนละคน", () => {
    const out = run([
      row(2, { fullNameTh: "คนไม่มีเบอร์", amount: 1000, paidAt: new Date("2025-02-01") }),
      row(3, { fullNameTh: "คนไม่มีเบอร์", amount: 1000, paidAt: new Date("2025-02-01") }),
    ]);
    expect(out.persons).toHaveLength(2);
  });

  it("แถวซ้ำเติมช่องที่แถวแรกว่าง ไม่ทับของเดิม", () => {
    const out = run([
      row(2, { fullNameTh: "สมหญิง", phone: "0898888888", amount: 1000, paidAt: new Date("2025-02-01") }),
      row(3, { phone: "0898888888", email: "somying@mail.com", amount: 1000, paidAt: new Date("2025-03-01") }),
    ]);
    const p = out.persons[0]!;
    expect(p.fullNameTh).toBe("สมหญิง"); // คงของแถวแรก
    expect(p.email).toBe("somying@mail.com"); // เติมช่องที่เคยว่าง
  });
});

describe("importLegacyRows — เงิน/ที่นั่งไม่เบิ้ล", () => {
  it("1 แถวหลายคอร์ส = 1 payment ยอดเดียว แต่หลาย enrollment", () => {
    const out = run([
      row(2, { phone: "0811111111", amount: 9900, paidAt: new Date("2025-04-01") }, [
        { label: "Inner", value: "1-2 Apr" },
        { label: "Commu", value: "3-4 Apr" },
      ]),
    ]);
    expect(out.payments).toHaveLength(1);
    expect(out.payments[0]!.amount).toBe(9900);
    expect(out.enrollments).toHaveLength(2);
    // ยอดคนต้องเท่ายอด payment ก้อนเดียว ไม่ใช่ *2
    expect(out.persons[0]!.totalPaid).toBe(9900);
  });

  it("relearn/refund ไม่นับเป็นที่นั่งขายได้", () => {
    const out = run([
      row(2, { phone: "0822222222", amount: 0, paidAt: new Date("2025-05-01") }, [
        { label: "Inner", value: "RL 5-6 May" }, // relearn
        { label: "Commu", value: "คืนเงิน" }, // refund
      ]),
    ]);
    expect(out.enrollments).toHaveLength(2);
    expect(out.enrollments.every((e) => e.countsAsSeat === false)).toBe(true);
    expect(out.persons[0]!.seatCount).toBe(0);
    expect(out.persons[0]!.courseCodes).toEqual([]);
  });

  it("หัวคอลัมน์คอร์สที่ไม่รู้จัก → เข้า unknownCourseHeaders ไม่สร้าง enrollment", () => {
    const out = run([
      row(2, { phone: "0833333333", amount: 5000, paidAt: new Date("2025-06-01") }, [
        { label: "SuperNewCourse", value: "1-2 Jun" },
      ]),
    ]);
    expect(out.unknownCourseHeaders).toEqual(["SuperNewCourse"]);
    expect(out.enrollments).toHaveLength(0);
    expect(out.payments).toHaveLength(1); // ยังเป็นการชำระอยู่
  });
});

describe("importLegacyRows — slipShared", () => {
  it("เลขสลิปซ้ำข้ามคน = ทำเครื่องหมาย slipShared ทั้งคู่", () => {
    const out = run([
      row(2, { phone: "0844444444", slipNo: "IN-6801-00001", amount: 6900, paidAt: new Date("2025-01-10") }),
      row(3, { phone: "0855555555", slipNo: "IN-6801-00001", amount: 6900, paidAt: new Date("2025-01-10") }),
      row(4, { phone: "0866666666", slipNo: "IN-6801-00002", amount: 3900, paidAt: new Date("2025-01-11") }),
    ]);
    const shared = out.payments.filter((p) => p.slipShared).map((p) => p.slipNo);
    expect(shared).toEqual(["IN-6801-00001", "IN-6801-00001"]);
    expect(out.payments.find((p) => p.slipNo === "IN-6801-00002")!.slipShared).toBe(false);
  });
});

describe("importLegacyRows — แปลงค่า", () => {
  it("เบอร์ normalize เป็น E.164 แบบเดียวกับฝั่ง LINE", () => {
    const out = run([
      row(2, { phone: "081-234-5678", amount: 1000, paidAt: new Date("2025-01-01") }),
    ]);
    expect(out.persons[0]!.phone).toBe("+66812345678");
  });

  it("ยอดเงินมี comma และ 0 = ไม่นับ", () => {
    const out = run([
      row(2, { phone: "0877777777", amount: "6,900", paidAt: new Date("2025-01-01") }),
      row(3, { phone: "0877777777", amount: 0, paidAt: new Date("2025-02-01") }),
    ]);
    expect(out.payments[0]!.amount).toBe(6900);
    expect(out.payments[1]!.amount).toBeNull();
    expect(out.persons[0]!.totalPaid).toBe(6900); // 0/null ไม่บวก
  });

  it("วันที่แบบ Excel serial number แปลงได้", () => {
    // 45658 = 2025-01-01
    const out = run([row(2, { phone: "0888888888", amount: 1000, paidAt: 45658 })]);
    expect(out.payments[0]!.paidAt?.toISOString().slice(0, 10)).toBe("2025-01-01");
  });
});
