import { createFacebookGraphClient, getDb, log, syncFacebookPosts } from "@line-crm/core";
import { readSignedJson } from "@/lib/internal";
import { fail, newRequestId, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const requestId = newRequestId();
  const signed = await readSignedJson(req, requestId);
  if (!signed.ok) return signed.response;
  const rawDays = signed.body.days;
  const days = rawDays === undefined ? undefined : Number(rawDays);
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 366)) {
    return fail("VALIDATION_FAILED", "days ต้องเป็นจำนวนเต็ม 1–366", requestId);
  }
  try {
    const client = createFacebookGraphClient();
    const result = await syncFacebookPosts(await getDb(), client, { days });
    log.info("ซิงก์ Facebook posts สำเร็จ", {
      requestId,
      fetched: result.fetched,
      stored: result.stored,
      attributed: result.attribution.resolved,
    });
    return ok(result as unknown as Record<string, unknown>, requestId);
  } catch (error) {
    log.error("ซิงก์ Facebook posts ไม่สำเร็จ", { requestId, error: (error as Error).message });
    return fail("UPSTREAM_ERROR", "ซิงก์ Facebook posts ไม่สำเร็จ", requestId);
  }
}
