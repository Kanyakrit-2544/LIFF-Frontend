import { syncPendingLeads, log } from "@line-crm/core";
import { readSignedJson } from "@/lib/internal";
import { fail, newRequestId, ok } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const requestId = newRequestId();
  const signed = await readSignedJson(req, requestId);
  if (!signed.ok) return signed.response;
  const limit = Number.isFinite(Number(signed.body.limit)) ? Number(signed.body.limit) : 50;
  try {
    const r = await syncPendingLeads(limit);
    return ok(r as unknown as Record<string, unknown>, requestId);
  } catch (e) {
    log.error("leads sync ล้มเหลว", { requestId, error: (e as Error).message });
    return fail("INTERNAL_ERROR", "sync leads ไม่สำเร็จ", requestId);
  }
}
