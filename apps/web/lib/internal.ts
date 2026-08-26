import { env, verifyInternal } from "@line-crm/core";
import { fail } from "./http";

export async function readSignedJson(req: Request, requestId: string): Promise<
  | { ok: true; rawBody: string; body: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return { ok: false, response: fail("VALIDATION_FAILED", "อ่าน request body ไม่ได้", requestId) };
  }

  let secret: string;
  try {
    secret = env("security").INTERNAL_HMAC_SECRET;
  } catch {
    return { ok: false, response: fail("INTERNAL_ERROR", "ระบบยังตั้งค่าไม่เรียบร้อย", requestId) };
  }

  if (!verifyInternal(rawBody, req.headers.get("x-signature"), req.headers.get("x-timestamp"), secret)) {
    return { ok: false, response: fail("UNAUTHORIZED", "signature ไม่ถูกต้อง", requestId) };
  }

  try {
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    return { ok: true, rawBody, body };
  } catch {
    return { ok: false, response: fail("VALIDATION_FAILED", "body ไม่ใช่ JSON", requestId) };
  }
}
