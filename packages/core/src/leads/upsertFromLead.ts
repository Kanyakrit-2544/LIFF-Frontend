import { getDb } from "../db/client";
import { COLLECTIONS, type CustomerDoc } from "../db/models";
import { resolveCustomer } from "../identity/resolve";
import { log } from "../logger";
import { buildAttribution, loadMappings, pickMapping, type LeadAttribution } from "./attribution";
import { mapLead, type LeadConsentField, type MappedLead } from "./mapLead";
import type { GraphLead, LeadgenNotification } from "./types";
import { isMergePairRejected } from "../review/pendingMerge";

/**
 * สร้าง/อัปเดตลูกค้าจาก lead ที่ดึงมาจาก Graph API
 *
 * ใช้ resolveCustomer ตัวเดียวกับฝั่ง LINE — provider "lead_ads" มีอยู่ใน models แล้ว
 * D3: เบอร์ตรงกับลูกค้าเดิม = ตั้ง pendingMerge ให้คนตรวจ ห้าม merge เอง
 * D33: ไม่มีคำถาม consent ในฟอร์ม = ไม่มี consent ห้ามสมมติ
 */

export interface UpsertFromLeadInput {
  notification: LeadgenNotification;
  lead: GraphLead;
  consentFields?: LeadConsentField;
  now?: Date;
}

export interface UpsertFromLeadResult {
  customerId: string;
  isNew: boolean;
  mapped: MappedLead;
  attribution: LeadAttribution;
  pendingMergeWith: string | null;
}

export async function upsertFromLead(input: UpsertFromLeadInput): Promise<UpsertFromLeadResult> {
  const now = input.now ?? new Date();
  const { notification } = input;
  const mapped = mapLead(input.lead, input.consentFields ?? {});
  const db = await getDb();
  const attribution = buildAttribution(notification, pickMapping(notification, await loadMappings(db)), now);

  const resolved = await resolveCustomer({
    provider: "lead_ads",
    channelId: notification.pageId ?? "unknown",
    externalId: notification.leadgenId,
    verified: false,
    meta: { formId: notification.formId, adId: notification.adId },
    // ห้ามส่ง hints เบอร์/อีเมลเข้าไป — resolveCustomer จะผูกให้อัตโนมัติ ซึ่งขัด D3
    create: {
      now,
      firstInteractionAt: notification.createdTime ? new Date(notification.createdTime) : now,
      displayName: mapped.displayName,
      sourceChannel: "facebook_lead",
      tags: ["facebook-lead"],
    },
  });

  const customers = db.collection<CustomerDoc>(COLLECTIONS.customers);

  // เบอร์/อีเมลตรงกับลูกค้าคนอื่น = ตั้งธงให้คนตรวจ ไม่รวมร่างเอง (D3)
  let pendingMergeWith: string | null = null;
  const orClauses = [
    ...(mapped.phone ? [{ phone: mapped.phone }] : []),
    ...(mapped.email ? [{ email: mapped.email }] : []),
  ];
  if (orClauses.length > 0) {
    const other = await customers.findOne(
      { $or: orClauses, _id: { $ne: resolved.customerId }, status: "active" },
      { projection: { _id: 1 } }
    );
    if (other && !(await isMergePairRejected(db, resolved.customerId, other._id))) {
      pendingMergeWith = other._id;
    }
  }

  const set: Record<string, unknown> = {
    updatedAt: now,
    lastInteractionAt: now,
    leadAttribution: attribution,
    "sheetSync.dirty": true,
    "aiSync.dirty": true,
  };
  if (mapped.displayName) set.displayName = mapped.displayName;
  if (mapped.phone) set.phone = mapped.phone;
  if (mapped.email) set.email = mapped.email;
  if (mapped.consent) {
    set.consent = {
      dataProcessing: mapped.consent.dataProcessing,
      marketing: mapped.consent.marketing,
      version: "facebook_lead_form",
      grantedAt: now,
      ip: null,
      userAgent: null,
    };
  }
  if (pendingMergeWith) {
    set.pendingMerge = { candidateId: pendingMergeWith, reason: "facebook_lead_contact_match", at: now };
  }

  await customers.updateOne(
    { _id: resolved.customerId },
    { $set: set, $addToSet: { sources: "facebook_lead" } }
  );

  if (mapped.ignoredFields.length > 0) {
    // ชื่อฟิลด์เท่านั้น ไม่ใช่ค่า — ไว้ให้คนตรวจว่าฟอร์มถามอะไรที่เรายังไม่ได้เก็บ
    log.info("lead มีฟิลด์ที่ไม่ได้เก็บ", { leadgenId: notification.leadgenId, fields: mapped.ignoredFields });
  }
  if (mapped.needsConsent) {
    log.warn("lead ยังไม่มี consent — ห้ามส่งการตลาด", { leadgenId: notification.leadgenId });
  }

  return { customerId: resolved.customerId, isNew: resolved.isNew, mapped, attribution, pendingMergeWith };
}
