import { ackEvents, failEvent, redact } from "@line-crm/core";
import { readSignedJson } from "@/lib/internal";
import { fail, newRequestId, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function POST(req: Request) {
  const requestId = newRequestId();
  const signed = await readSignedJson(req, requestId);
  if (!signed.ok) return signed.response;

  const provider = str(signed.body.provider) ?? "line";
  const rows = Array.isArray(signed.body.results) ? signed.body.results : [];
  let done = 0;
  let failed = 0;
  let dead = 0;

  try {
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const eventId = str(r.eventId);
      const status = str(r.status);
      if (!eventId) continue;

      if (status === "done") {
        done += await ackEvents([eventId], provider);
      } else if (status === "failed") {
        failed++;
        const error = String(redact(str(r.error) ?? "workflow failed"));
        const next = await failEvent(eventId, error, provider);
        if (next === "dead") dead++;
      }
    }
    return ok({ done, failed, dead }, requestId);
  } catch {
    return fail("INTERNAL_ERROR", "ack event ไม่สำเร็จ", requestId);
  }
}
