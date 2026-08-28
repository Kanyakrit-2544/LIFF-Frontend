import { partnerSecretFor, verifyInternal } from "@line-crm/core";
import { fail } from "./http";

const MAX_BODY_BYTES = 1024 * 1024;

export async function readPartnerJson(req: Request, requestId: string): Promise<
  | { ok: true; partnerId: string; rawBody: string; body: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const partnerId = req.headers.get("x-partner-id")?.trim() ?? "";
  const secret = partnerSecretFor(partnerId);
  if (!partnerId || !secret) {
    return { ok: false, response: fail("UNAUTHORIZED", "partner หรือ signature ไม่ถูกต้อง", requestId) };
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return { ok: false, response: fail("VALIDATION_FAILED", "อ่าน request body ไม่ได้", requestId) };
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return { ok: false, response: fail("VALIDATION_FAILED", "request body ใหญ่เกิน 1 MB", requestId) };
  }
  if (!verifyInternal(rawBody, req.headers.get("x-signature"), req.headers.get("x-timestamp"), secret)) {
    return { ok: false, response: fail("UNAUTHORIZED", "partner หรือ signature ไม่ถูกต้อง", requestId) };
  }

  try {
    const body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {};
    if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("not object");
    return { ok: true, partnerId, rawBody, body };
  } catch {
    return { ok: false, response: fail("VALIDATION_FAILED", "body ไม่ใช่ JSON object", requestId) };
  }
}

