import { checkRateLimit, intakePartnerEvents, log } from "@line-crm/core";
import { fail, newRequestId, ok } from "@/lib/http";
import { readPartnerJson } from "@/lib/partner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(req: Request) {
  const requestId = newRequestId();
  const signed = await readPartnerJson(req, requestId);
  if (!signed.ok) return signed.response;

  const events = signed.body.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > 100) {
    return fail("VALIDATION_FAILED", "events ต้องมี 1–100 รายการ", requestId);
  }

  const limit = await checkRateLimit(`partner:intake:${signed.partnerId}`, 60, 60);
  if (!limit.allowed) {
    const response = fail("RATE_LIMITED", "ส่งถี่เกินกำหนด", requestId, { retryAfterSec: limit.retryAfterSec });
    response.headers.set("retry-after", String(limit.retryAfterSec));
    return response;
  }

  try {
    const report = await intakePartnerEvents(signed.partnerId, events);
    log.info("รับ partner events", { requestId, partnerId: signed.partnerId, total: events.length, ...report.summary });
    return ok({ summary: report.summary, results: report.results }, requestId);
  } catch (error) {
    log.error("partner intake ล้มเหลว", { requestId, partnerId: signed.partnerId, error: (error as Error).message });
    return fail("INTERNAL_ERROR", "บันทึก partner events ไม่สำเร็จ", requestId);
  }
}

