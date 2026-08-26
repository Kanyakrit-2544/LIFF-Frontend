import { after } from "next/server";
import { log } from "@line-crm/core";

/**
 * เรียกงานเบื้องหลังโดยไม่ให้ล้มทั้ง request
 *
 * `after()` ของ Next โยน error ถ้าถูกเรียกนอก request scope
 * ถ้าปล่อยให้หลุดออกไป จะกลายเป็น 500 **ทั้งที่ข้อมูลถูกบันทึกสำเร็จไปแล้ว**
 * ผู้ใช้เห็น error แล้วกดส่งใหม่ ทั้งที่ของเข้าระบบไปเรียบร้อย
 *
 * งานที่ส่งมาที่นี่เป็น best-effort เสมอ (แจ้ง n8n) — n8n มี pull mode คอยเก็บตกอยู่แล้ว
 */
export function safeAfter(fn: () => Promise<unknown>, context: Record<string, unknown> = {}): void {
  try {
    after(async () => {
      try {
        await fn();
      } catch (e) {
        log.warn("งานเบื้องหลังล้มเหลว", { ...context, error: (e as Error).message });
      }
    });
  } catch (e) {
    log.warn("ตั้งงานเบื้องหลังไม่ได้", { ...context, error: (e as Error).message });
  }
}
