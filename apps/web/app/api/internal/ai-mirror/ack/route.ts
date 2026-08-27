import { ackAiMirror, aiMirrorStats, log, redact, type AiMirrorAckItem } from "@line-crm/core";
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
  const claimId = typeof signed.body.claimId === "string" && signed.body.claimId.trim() ? signed.body.claimId.trim() : undefined;
  const items: AiMirrorAckItem[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const customerId = typeof o.customerId === "string" ? o.customerId.trim() : "";
    if (!customerId) continue;
    items.push({
      customerId,
      status: o.status === "ok" ? "ok" : "error",
      claimId,
      error: o.error ? String(redact(String(o.error))).slice(0, 300) : undefined,
    });
  }

  try {
    const result = await ackAiMirror(items);
    const stats = await aiMirrorStats();
    log.info("ปิดงาน AI mirror", { requestId, ...result, remaining: stats.dirty });
    return ok({ ...result, remaining: stats.dirty, stuck: stats.stuck }, requestId);
  } catch (e) {
    log.error("ปิดงาน AI mirror ไม่สำเร็จ", { requestId, error: (e as Error).message });
    return fail("INTERNAL_ERROR", "ปิดงาน AI mirror ไม่สำเร็จ", requestId);
  }
}
