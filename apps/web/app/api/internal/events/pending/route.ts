import {
  ackEvents,
  claimPending,
  failEvent,
  getDb,
  releaseStaleClaims,
  COLLECTIONS,
  type CustomerDoc,
  type InboundEventDoc,
} from "@line-crm/core";
import { readSignedJson } from "@/lib/internal";
import { fail, newRequestId, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

type PendingEvent = {
  eventId: string;
  provider: string;
  channelId: string;
  eventType: "follow" | "unfollow" | "message";
  lineUserId: string;
  occurredAt: string;
  messageType: string | null;
  needsProfile: boolean;
  attempts: number;
};

const SUPPORTED = new Set(["follow", "unfollow", "message"]);

function intField(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(Math.floor(n), max));
}

function strField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function rawObject(doc: InboundEventDoc): Record<string, unknown> {
  return doc.raw && typeof doc.raw === "object" ? doc.raw : {};
}

function sourceUserId(raw: Record<string, unknown>): string | null {
  const source = raw.source && typeof raw.source === "object" ? (raw.source as Record<string, unknown>) : null;
  if (source?.type !== "user") return null;
  return typeof source.userId === "string" && source.userId ? source.userId : null;
}

function messageType(raw: Record<string, unknown>): string | null {
  const message = raw.message && typeof raw.message === "object" ? (raw.message as Record<string, unknown>) : null;
  return typeof message?.type === "string" ? message.type : null;
}

function occurredAt(doc: InboundEventDoc, raw: Record<string, unknown>): string {
  const ts = typeof raw.timestamp === "number" ? raw.timestamp : null;
  const d = ts ? new Date(ts) : doc.receivedAt;
  return d.toISOString();
}

async function loadProfilePresence(events: Array<{ provider: string; channelId: string; lineUserId: string }>) {
  const db = await getDb();
  const identities = db.collection(COLLECTIONS.identities);
  const customers = db.collection<CustomerDoc>(COLLECTIONS.customers);
  const unique = new Map<string, { provider: string; channelId: string; lineUserId: string }>();
  for (const e of events) unique.set(`${e.provider}\0${e.channelId}\0${e.lineUserId}`, e);
  const filters = [...unique.values()].map((e) => ({
    provider: e.provider,
    channelId: e.channelId,
    externalId: e.lineUserId,
  }));
  if (filters.length === 0) return new Map<string, boolean>();

  const identityRows = await identities
    .find<{ customerId: string; provider: string; channelId: string; externalId: string }>(
      { $or: filters },
      { projection: { customerId: 1, provider: 1, channelId: 1, externalId: 1 } }
    )
    .toArray();
  const customerIds = [...new Set(identityRows.map((i) => i.customerId).filter(Boolean))];
  const customerRows =
    customerIds.length > 0
      ? await customers.find({ _id: { $in: customerIds } }, { projection: { lineDisplayName: 1, pictureUrl: 1 } }).toArray()
      : [];
  const customerById = new Map(customerRows.map((c) => [c._id, c]));
  const hasProfile = new Map<string, boolean>();
  for (const i of identityRows) {
    const c = customerById.get(i.customerId);
    hasProfile.set(`${i.provider}\0${i.channelId}\0${i.externalId}`, Boolean(c?.lineDisplayName && c?.pictureUrl));
  }
  return hasProfile;
}

export async function POST(req: Request) {
  const requestId = newRequestId();
  const signed = await readSignedJson(req, requestId);
  if (!signed.ok) return signed.response;

  const provider = strField(signed.body.provider, "line");
  const limit = intField(signed.body.limit, 50, 200);
  const olderThanSec = intField(signed.body.olderThanSec, 0, 86_400);

  try {
    await releaseStaleClaims(provider);
    const claimed = await claimPending({ limit, olderThanSec, provider });
    const skipped = { noChannelId: 0, notUserEvent: 0, unsupportedType: 0 };
    const candidates: Array<{
      doc: InboundEventDoc;
      raw: Record<string, unknown>;
      eventType: "follow" | "unfollow" | "message";
      lineUserId: string;
      channelId: string;
    }> = [];

    for (const doc of claimed) {
      const raw = rawObject(doc);
      const eventType = typeof raw.type === "string" ? raw.type : "";

      if (!doc.channelId) {
        skipped.noChannelId++;
        await failEvent(doc.eventId, "ไม่มี channelId (destination)", doc.provider);
        continue;
      }

      const lineUserId = sourceUserId(raw);
      if (!lineUserId) {
        skipped.notUserEvent++;
        await ackEvents([doc.eventId], doc.provider);
        continue;
      }

      if (!SUPPORTED.has(eventType)) {
        skipped.unsupportedType++;
        await ackEvents([doc.eventId], doc.provider);
        continue;
      }

      candidates.push({ doc, raw, eventType: eventType as "follow" | "unfollow" | "message", lineUserId, channelId: doc.channelId });
    }

    const hasProfile = await loadProfilePresence(candidates.map((c) => ({ provider: c.doc.provider, channelId: c.channelId, lineUserId: c.lineUserId })));
    const events: PendingEvent[] = candidates.map((c) => ({
      eventId: c.doc.eventId,
      provider: c.doc.provider,
      channelId: c.channelId,
      eventType: c.eventType,
      lineUserId: c.lineUserId,
      occurredAt: occurredAt(c.doc, c.raw),
      messageType: c.eventType === "message" ? messageType(c.raw) : null,
      needsProfile: !hasProfile.get(`${c.doc.provider}\0${c.channelId}\0${c.lineUserId}`),
      attempts: c.doc.attempts,
    }));

    return ok({ claimed: events.length, skipped, events }, requestId);
  } catch (e) {
    return fail("INTERNAL_ERROR", "ดึง event pending ไม่สำเร็จ", requestId, { message: (e as Error).message });
  }
}
