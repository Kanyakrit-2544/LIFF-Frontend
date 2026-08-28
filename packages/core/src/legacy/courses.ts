/**
 * พจนานุกรมคอร์ส — หัวคอลัมน์ในชีตขาย → รหัสคอร์สมาตรฐาน
 *
 * ชีตแต่ละปีเขียนชื่อคอร์สเดียวกันไม่เหมือนกัน (`Inner` / `Inner Makeover`,
 * `MC Pro` / `MC Pro7` / `MC Pro#ุ6`) ทั้งไฟล์มีหัวคอลัมน์ 42 แบบ
 * ตารางนี้จึงเป็น "ความจริงชุดเดียว" ที่ทุกชั้นอ้างอิง — analytics ห้ามเทียบด้วยชื่อดิบ
 *
 * ตอนนี้ครอบคลุมเฉพาะชีต 2025–2026 (prototype) เพิ่มปีเก่า = เพิ่มบรรทัดในตารางนี้
 * ห้ามให้ LLM แปลชื่อคอร์สตอน query — mapping ต้องนิ่งและตรวจสอบได้
 */

export interface CourseDef {
  code: string;
  nameTh: string;
  /** หัวคอลัมน์ที่เคยเจอในชีต (lowercase ตอนเทียบ) */
  aliases: string[];
  /** true = ไม่ใช่ที่นั่งคอร์ส เช่น สินค้า/ค่าห้องพัก — ไม่นับหัวตอนสรุปยอดผู้เรียน */
  nonCourse?: boolean;
}

export const COURSES: CourseDef[] = [
  { code: "INNER", nameTh: "Inner Makeover", aliases: ["inner", "inner makeover"] },
  { code: "COMMU", nameTh: "Communication", aliases: ["commu", "communication", "mas com"] },
  { code: "PRESENT", nameTh: "Presentation", aliases: ["present", "presentation"] },
  { code: "TTRT", nameTh: "The Trainer", aliases: ["ttrt", "ttrt'63", "ttrt'64", "the trainer"] },
  { code: "DEEPIN", nameTh: "Deep In", aliases: ["deep in", "deepin"] },
  { code: "INNERCAMP", nameTh: "Inner Camp", aliases: ["inner camp"] },
  { code: "OTHER", nameTh: "อื่น ๆ", aliases: ["อื่น ๆ", "อื่นๆ"], nonCourse: true },
];

const BY_ALIAS = new Map<string, CourseDef>();
for (const c of COURSES) {
  for (const a of c.aliases) BY_ALIAS.set(a, c);
}

/** null = หัวคอลัมน์ที่ยังไม่รู้จัก — ผู้เรียกต้องรายงาน ไม่ใช่เดาเอง */
export function courseByHeader(header: string): CourseDef | null {
  return BY_ALIAS.get(header.trim().replace(/\s+/g, " ").toLowerCase()) ?? null;
}

export function courseByCode(code: string): CourseDef | null {
  return COURSES.find((c) => c.code === code) ?? null;
}
