import { ackSheetSync, log, redact, sheetSyncStats, type SheetAckItem } from "@line-crm/core";
import { readSignedJson } from "@/lib/internal";
import { fail, newRequestId, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function POST(req: Request) {
  const requestId = newRequestId();
  const signed = await readSignedJson(req, requestId);
  if (!signed.ok) return signed.response;

  const rows = Array.isArray(signed.body.results) ? signed.body.results : [];
  const items: SheetAckItem[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const customerId = typeof o.customerId === "string" ? o.customerId.trim() : "";
    if (!customerId) continue;
    items.push({
      customerId,
      status: o.status === "ok" ? "ok" : "error",
      // error จาก n8n อาจมี payload ติดมา — redact ก่อนเข้า log
      error: o.error ? String(redact(String(o.error))).slice(0, 300) : undefined,
    });
  }

  try {
    const result = await ackSheetSync(items);
    const stats = await sheetSyncStats();
    log.info("ปิดงานซิงก์ชีต", { requestId, ...result, remaining: stats.dirty });
    return ok({ ...result, remaining: stats.dirty, stuck: stats.stuck }, requestId);
  } catch (e) {
    log.error("ปิดงานซิงก์ชีตไม่สำเร็จ", { requestId, error: (e as Error).message });
    return fail("INTERNAL_ERROR", "ปิดงานซิงก์ไม่สำเร็จ", requestId);
  }
}
