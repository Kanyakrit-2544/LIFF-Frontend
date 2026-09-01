import { buildCustomerLinks, log } from "@line-crm/core";
import { readSignedJson } from "@/lib/internal";
import { fail, newRequestId, ok } from "@/lib/http";
import { getMirrorAiDb, mirrorConfigured } from "@/lib/mirrorDb";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const requestId = newRequestId();
  const signed = await readSignedJson(req, requestId);
  if (!signed.ok) return signed.response;
  if (!mirrorConfigured()) return fail("INTERNAL_ERROR", "ยังไม่ตั้ง MONGODB_MIRROR_URI", requestId);
  try {
    // n8n ไม่ส่งชื่อคนให้ LLM (D28) และ match ผ่าน endpoint นี้ปิด LLM ไว้ — เดินเฉพาะกฎ deterministic
    const r = await buildCustomerLinks(await getMirrorAiDb(), { llmProvider: null });
    return ok(r as unknown as Record<string, unknown>, requestId);
  } catch (e) {
    log.error("match build ล้มเหลว", { requestId, error: (e as Error).message });
    return fail("INTERNAL_ERROR", "match ไม่สำเร็จ", requestId);
  }
}
