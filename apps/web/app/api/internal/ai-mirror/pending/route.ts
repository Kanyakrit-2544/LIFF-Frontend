import { claimAiMirrorCustomers, log } from "@line-crm/core";
import { readSignedJson } from "@/lib/internal";
import { fail, newRequestId, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * POST /api/internal/ai-mirror/pending
 *
 * n8n ดึงเฉพาะข้อมูลที่ scrub แล้วจาก API นี้เท่านั้น
 * เพื่อไม่ให้ workflow หรือ credential ฝั่ง n8n เห็นข้อมูลดิบใน line_crm_dev
 */
export async function POST(req: Request) {
  const requestId = newRequestId();
  const signed = await readSignedJson(req, requestId);
  if (!signed.ok) return signed.response;

  const raw = Number(signed.body.limit);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(Math.floor(raw), 500)) : 200;

  try {
    const { claimId, rows } = await claimAiMirrorCustomers(limit);
    log.info("จองงาน AI mirror", { requestId, claimed: rows.length });
    return ok({ claimId, claimed: rows.length, rows }, requestId);
  } catch (e) {
    log.error("ดึงงาน AI mirror ไม่สำเร็จ", { requestId, error: (e as Error).message });
    return fail("INTERNAL_ERROR", "ดึงงาน AI mirror ไม่สำเร็จ", requestId);
  }
}
