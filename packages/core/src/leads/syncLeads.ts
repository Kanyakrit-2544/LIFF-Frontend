import { getDb } from "../db/client";
import { ackEvents, claimPending, failEvent, releaseStaleClaims } from "../events/inbox";
import { log } from "../logger";
import { ensureLeadIndexes } from "./attribution";
import { facebookConfigured, fetchLead } from "./fetchLead";
import { upsertFromLead } from "./upsertFromLead";
import type { LeadgenNotification } from "./types";

/**
 * ดึง Facebook lead ที่ค้างในคิวมาสร้างลูกค้า — orchestration กลาง
 * เรียกได้ทั้งจากสคริปต์ (leads:sync) และจาก endpoint ที่ n8n ยิงมา
 * (business logic อยู่ที่นี่ ไม่ใช่ในสคริปต์/n8n — ตามกฎ HANDOFF ข้อ 1)
 */
export interface SyncLeadsResult {
  configured: boolean;
  claimed: number;
  created: number;
  updated: number;
  failed: number;
  pendingMerge: number;
  needsConsent: number;
  attributionPending: number;
}

export async function syncPendingLeads(limit = 50): Promise<SyncLeadsResult> {
  const empty: SyncLeadsResult = {
    configured: false, claimed: 0, created: 0, updated: 0, failed: 0,
    pendingMerge: 0, needsConsent: 0, attributionPending: 0,
  };
  // ยังไม่ตั้ง token = ไม่ทำอะไร แต่ไม่ error (event ค้างในคิวรอ ไม่หาย)
  if (!facebookConfigured().graph) return empty;

  const db = await getDb();
  await ensureLeadIndexes(db);
  await releaseStaleClaims("facebook");
  const events = await claimPending({ provider: "facebook", limit: Math.max(1, Math.min(limit, 200)) });

  const result: SyncLeadsResult = { ...empty, configured: true, claimed: events.length };
  const done: string[] = [];

  for (const ev of events) {
    const notification = ev.raw as unknown as LeadgenNotification;
    const res = await fetchLead(notification.leadgenId);
    if (!res.ok || !res.lead) {
      result.failed++;
      await failEvent(ev.eventId, res.error ?? "fetch lead ไม่สำเร็จ", "facebook");
      continue;
    }
    const r = await upsertFromLead({ notification, lead: res.lead });
    r.isNew ? result.created++ : result.updated++;
    if (r.pendingMergeWith) result.pendingMerge++;
    if (r.mapped.needsConsent) result.needsConsent++;
    if (r.attribution.attributionPending) result.attributionPending++;
    done.push(ev.eventId);
  }

  if (done.length > 0) await ackEvents(done, "facebook");
  log.info("sync facebook leads", result as unknown as Record<string, unknown>);
  return result;
}
