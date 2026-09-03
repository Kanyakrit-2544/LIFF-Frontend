import { getDb, loadMarketingSheetSnapshot, log } from "@line-crm/core";
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
    const snapshot = await loadMarketingSheetSnapshot(await getDb());
    log.info("เตรียมข้อมูลชีตการตลาดสำเร็จ", { requestId, ...snapshot.counts });
    return ok(snapshot as unknown as Record<string, unknown>, requestId);
  } catch (error) {
    log.error("เตรียมข้อมูลชีตการตลาดไม่สำเร็จ", { requestId, error: (error as Error).message });
    return fail("INTERNAL_ERROR", "เตรียมข้อมูลชีตการตลาดไม่สำเร็จ", requestId);
  }
}
