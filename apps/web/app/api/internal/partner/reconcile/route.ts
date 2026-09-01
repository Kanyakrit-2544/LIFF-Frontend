import { reconcilePartnerIdentities, getDb, log } from "@line-crm/core";
import { readSignedJson } from "@/lib/internal";
import { fail, newRequestId, ok } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const requestId = newRequestId();
  const signed = await readSignedJson(req, requestId);
  if (!signed.ok) return signed.response;
  try {
    const r = await reconcilePartnerIdentities(await getDb());
    return ok(r as unknown as Record<string, unknown>, requestId);
  } catch (e) {
    log.error("partner reconcile ล้มเหลว", { requestId, error: (e as Error).message });
    return fail("INTERNAL_ERROR", "reconcile ไม่สำเร็จ", requestId);
  }
}
