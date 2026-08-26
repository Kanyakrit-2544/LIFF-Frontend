import { env } from "../env";
import { log } from "../logger";

/**
 * ตรวจ LINE ID Token (docs/00 RISK-2)
 *
 * ⚠️ ห้ามเชื่อ userId ที่ frontend ส่งมาเด็ดขาด
 * `liff.getProfile().userId` อยู่ฝั่ง browser — ใครเปิด DevTools ก็ส่ง userId ของคนอื่นมาได้
 * ตัวตนที่เชื่อได้มีทางเดียวคือ `sub` ที่ได้จากการ verify token กับ LINE
 */

export interface LineIdTokenPayload {
  iss: string;
  sub: string; // = lineUserId — ค่าเดียวที่เชื่อได้
  aud: string;
  exp: number;
  iat: number;
  name?: string;
  picture?: string;
  email?: string; // มีเฉพาะเมื่อได้รับอนุมัติ Email permission และผู้ใช้ยินยอม (D18)
}

export type VerifyResult =
  | { ok: true; payload: LineIdTokenPayload }
  | { ok: false; code: "INVALID" | "EXPIRED" | "WRONG_AUDIENCE" | "UPSTREAM"; message: string };

const VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
const ISSUER = "https://access.line.me";

export async function verifyLineIdToken(idToken: string, opts?: { clientId?: string; fetchImpl?: typeof fetch }): Promise<VerifyResult> {
  if (!idToken || typeof idToken !== "string") return { ok: false, code: "INVALID", message: "ไม่มี id_token" };

  const clientId = opts?.clientId ?? env("line").LINE_LOGIN_CHANNEL_ID;
  const doFetch = opts?.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: clientId }).toString(),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    log.warn("เรียก LINE verify ไม่สำเร็จ", { error: (e as Error).message });
    return { ok: false, code: "UPSTREAM", message: "ติดต่อ LINE ไม่ได้" };
  }

  if (!res.ok) {
    // LINE ตอบ 400 ทั้งกรณี token ผิด หมดอายุ และ client_id ไม่ตรง — ไม่บอกรายละเอียดกลับไปที่ client
    return { ok: false, code: "INVALID", message: "id_token ใช้ไม่ได้" };
  }

  const payload = (await res.json().catch(() => null)) as LineIdTokenPayload | null;
  if (!payload?.sub) return { ok: false, code: "INVALID", message: "id_token ไม่มี sub" };

  // ตรวจซ้ำฝั่งเราเอง ไม่พึ่ง LINE อย่างเดียว
  if (payload.iss !== ISSUER) return { ok: false, code: "INVALID", message: "issuer ไม่ถูกต้อง" };
  if (payload.aud !== clientId) return { ok: false, code: "WRONG_AUDIENCE", message: "token ของ channel อื่น" };
  if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) {
    return { ok: false, code: "EXPIRED", message: "id_token หมดอายุ" };
  }

  return { ok: true, payload };
}
