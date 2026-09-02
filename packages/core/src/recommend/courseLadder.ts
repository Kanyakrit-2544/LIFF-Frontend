/**
 * เส้นทางคอร์สสมมุติสำหรับ S15 เท่านั้น ปรับได้เมื่อทีมขายยืนยันเส้นทางจริง
 * ไม่ใช้ LLM และไม่ส่งข้อความหาลูกค้าอัตโนมัติ
 */
export const MOCK_COURSE_LADDER: Readonly<Record<string, readonly string[]>> = {
  INNER: ["COMMU", "DEEPIN", "INNERCAMP"],
  COMMU: ["PRESENT"],
  PRESENT: ["TTRT"],
};

export function nextCourses(code: string): string[] {
  return [...(MOCK_COURSE_LADDER[code.trim().toUpperCase()] ?? [])];
}
