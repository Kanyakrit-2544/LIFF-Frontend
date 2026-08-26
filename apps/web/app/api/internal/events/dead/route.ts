import { COLLECTIONS, getDb, type InboundEventDoc } from "@line-crm/core";
import { readSignedJson } from "@/lib/internal";
import { fail, newRequestId, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

function limitField(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(Math.floor(n), 200));
}

export async function POST(req: Request) {
  const requestId = newRequestId();
  const signed = await readSignedJson(req, requestId);
  if (!signed.ok) return signed.response;

  const limit = limitField(signed.body.limit);
  const provider = typeof signed.body.provider === "string" && signed.body.provider.trim() ? signed.body.provider.trim() : undefined;

  try {
    const rows = await (await getDb())
      .collection<InboundEventDoc>(COLLECTIONS.inboundEvents)
      .find({ status: "dead", ...(provider ? { provider } : {}) }, { limit, sort: { processedAt: -1, receivedAt: -1 } })
      .toArray();
    const events = rows.map((r) => ({
      eventId: r.eventId,
      provider: r.provider,
      eventType: typeof r.raw?.type === "string" ? r.raw.type : null,
      attempts: r.attempts,
      lastError: r.lastError,
      receivedAt: r.receivedAt.toISOString(),
      processedAt: r.processedAt?.toISOString() ?? null,
    }));
    return ok({ count: events.length, events }, requestId);
  } catch {
    return fail("INTERNAL_ERROR", "อ่าน dead events ไม่สำเร็จ", requestId);
  }
}
