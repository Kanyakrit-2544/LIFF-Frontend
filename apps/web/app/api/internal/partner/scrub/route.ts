import { scrubPartnerToAi, ensureAiIndexes, getDb, log } from "@line-crm/core";
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
    const ai = await getMirrorAiDb();
    await ensureAiIndexes(ai);
    const r = await scrubPartnerToAi(await getDb(), ai);
    return ok(r as unknown as Record<string, unknown>, requestId);
  } catch (e) {
    log.error("partner scrub ล้มเหลว", { requestId, error: (e as Error).message });
    return fail("INTERNAL_ERROR", "scrub ไม่สำเร็จ", requestId);
  }
}
