import { env, log, upsertFromLine, verifyInternal } from "@line-crm/core";
import { fail, newRequestId, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function POST(req: Request) {
  const requestId = newRequestId();
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return fail("VALIDATION_FAILED", "อ่าน request body ไม่ได้", requestId);
  }

  let secret: string;
  try {
    secret = env("security").INTERNAL_HMAC_SECRET;
  } catch (e) {
    log.error("env security ไม่ครบ", { requestId, error: (e as Error).message });
    return fail("INTERNAL_ERROR", "ระบบยังตั้งค่าไม่เรียบร้อย", requestId);
  }

  if (!verifyInternal(rawBody, req.headers.get("x-signature"), req.headers.get("x-timestamp"), secret)) {
    log.warn("internal HMAC ไม่ผ่าน", { requestId, route: "/api/internal/customers/upsert-from-line" });
    return fail("UNAUTHORIZED", "signature ไม่ถูกต้อง", requestId);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return fail("VALIDATION_FAILED", "body ไม่ใช่ JSON", requestId);
  }

  const eventId = asString(body.eventId);
  const channelId = asString(body.channelId);
  const lineUserId = asString(body.lineUserId);
  const eventType = asString(body.eventType);
  const occurredAt = asString(body.occurredAt);
  const profile = typeof body.profile === "object" && body.profile ? (body.profile as Record<string, unknown>) : {};
  const message = typeof body.message === "object" && body.message ? (body.message as Record<string, unknown>) : {};

  if (!eventId || !channelId || !lineUserId || !eventType || !occurredAt) {
    return fail("VALIDATION_FAILED", "ข้อมูล event จาก LINE ไม่ครบ", requestId);
  }
  if (!["follow", "message", "unfollow"].includes(eventType)) {
    return fail("VALIDATION_FAILED", "eventType ไม่รองรับ", requestId);
  }

  try {
    const result = await upsertFromLine({
      eventId,
      provider: "line",
      channelId,
      lineUserId,
      eventType: eventType as "follow" | "message" | "unfollow",
      occurredAt,
      profile: {
        displayName: asString(profile.displayName),
        pictureUrl: asString(profile.pictureUrl),
      },
      message: { type: asString(message.type) },
    });
    return ok(
      {
        customerId: result.customerId,
        isNew: result.isNew,
        interactionCreated: result.interactionCreated,
        milestone: result.milestone,
      },
      requestId
    );
  } catch (e) {
    log.error("upsert customer จาก LINE ล้มเหลว", { requestId, error: (e as Error).message });
    return fail("INTERNAL_ERROR", "บันทึกลูกค้าจาก LINE ไม่สำเร็จ", requestId);
  }
}
