import { cookies } from "next/headers";
import { readSession, SESSION_COOKIE, type SessionPayload } from "@line-crm/core";
import { fail } from "./http";

/** อ่าน session จาก cookie — ตัวตนของผู้ใช้มาจากที่นี่ที่เดียว ไม่รับจาก body */
export async function requireSession(
  requestId: string
): Promise<{ ok: true; session: SessionPayload } | { ok: false; response: Response }> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const result = readSession(token);
  if (!result.ok) {
    return {
      ok: false,
      response: fail("UNAUTHORIZED", "session หมดอายุหรือไม่ถูกต้อง", requestId, { reason: result.reason }),
    };
  }
  return { ok: true, session: result.payload };
}
