import { ObjectId } from "mongodb";
import { getDb } from "../db/client";
import { COLLECTIONS, type AuditLogDoc, type CustomerDoc, type CustomerProfileDoc, type InteractionDoc } from "../db/models";
import { buildZodFromSchema, normalizeAnswers } from "../forms/buildZod";
import type { FormSchemaDoc } from "../forms/types";

import { newProfileId } from "../ids";
import { log } from "../logger";

/**
 * รับคำตอบจากฟอร์ม LIFF แล้วเขียนลงระบบ (docs/03 §3.6)
 *
 * ลำดับสำคัญ:
 *   1. validate ด้วย zod ที่สร้างจาก schema ใน DB (.strict() กัน field แปลกปลอม)
 *   2. normalize เบอร์/อีเมล/ปีเกิด
 *   3. ถ้าเบอร์ตรงกับลูกค้าอีกคน → merge (D3: auto-merge)
 *   4. เขียน customer_profiles (append-only) + อัปเดต customers + interaction + ตั้ง dirty
 */

export interface ApplyFormInput {
  customerId: string;
  schema: FormSchemaDoc;
  answers: Record<string, unknown>;
  idempotencyKey: string;
  submittedVia?: "liff" | "manual" | "import";
  clientMeta?: Record<string, unknown>;
  consentContext?: { ip: string | null; userAgent: string | null; version: string };
}

export type ApplyFormResult =
  | { ok: true; customerId: string; revision: number; merged: boolean; duplicate: boolean; pendingMerge?: boolean }
  | { ok: false; code: "VALIDATION_FAILED"; issues: Array<{ field: string; message: string }> };

/** clientMeta มาจาก client ตรง ๆ ไม่ผ่าน schema — จำกัดขนาดกันยัดข้อมูลถ่วงฐาน */
function capMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  let budget = 2048;
  for (const [k, v] of Object.entries(meta)) {
    if (budget <= 0 || out.__truncated__) break;
    if (k.length > 40) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
    if (typeof s !== "string") continue;
    const clipped = s.slice(0, Math.min(256, budget));
    out[k] = clipped;
    budget -= clipped.length;
  }
  if (JSON.stringify(meta).length > 2048) out.__truncated__ = true;
  return out;
}

export async function applyFormSubmission(input: ApplyFormInput): Promise<ApplyFormResult> {
  const { schema } = input;

  // ── 1. validate ────────────────────────────────────────────
  const parsed = buildZodFromSchema(schema, { answers: input.answers }).safeParse(input.answers);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      issues: parsed.error.issues.map((i) => ({ field: String(i.path[0] ?? ""), message: i.message })),
    };
  }

  // ── 2. normalize ───────────────────────────────────────────
  const answers = normalizeAnswers(schema, parsed.data as Record<string, unknown>);
  const db = await getDb();
  const customers = db.collection<CustomerDoc>(COLLECTIONS.customers);
  const profiles = db.collection<CustomerProfileDoc>(COLLECTIONS.customerProfiles);

  const phone = typeof answers.phone === "string" && answers.phone.startsWith("+") ? answers.phone : null;
  const email = typeof answers.email === "string" && answers.email.includes("@") ? answers.email : null;

  const customerId = input.customerId;
  const merged = false;
  let pendingMergeWith: string | null = null;

  // ── 3. เบอร์ตรงกับลูกค้าคนอื่น → ตั้งธงให้คนตรวจ ไม่ merge เอง ──
  //
  // เดิมที่นี่ merge อัตโนมัติ (D3) แต่พบว่าเปิดช่องให้ยึดข้อมูลคนอื่นได้:
  // เบอร์ที่พิมพ์ในฟอร์มเป็น "การอ้าง" ที่ยังไม่ได้ตรวจสอบ ใครก็พิมพ์เบอร์ของคนอื่นได้
  // เมื่อ merge แล้ว ข้อมูลของอีกฝ่าย (อีเมล ชื่อเล่น ปีเกิด) จะถูกเติมเข้ามาในบัญชีผู้กรอก
  // แล้วอ่านกลับออกไปได้ทาง /api/liff/bootstrap
  //
  // การรวมลูกค้ายังทำได้ แต่ต้องผ่านคนหรือผ่านการยืนยันเบอร์ (OTP) เท่านั้น
  if (phone) {
    const other = await customers.findOne(
      { phone, status: "active", _id: { $ne: customerId } },
      { projection: { _id: 1 } }
    );
    if (other) {
      pendingMergeWith = other._id;
      log.warn("เบอร์ซ้ำกับลูกค้าอีกคน — ตั้งธงรอตรวจสอบ ไม่ merge อัตโนมัติ", {
        customerId, candidateId: other._id, reason: "phone_match",
      });
    }
  }

  // ── 4. เขียนข้อมูล ─────────────────────────────────────────
  const now = new Date();
  const last = await profiles.findOne({ customerId }, { sort: { revision: -1 }, projection: { revision: 1 } });
  const revision = (last?.revision ?? 0) + 1;

  const profileDoc: CustomerProfileDoc = {
    _id: newProfileId(),
    customerId,
    revision,
    formId: schema.formId,
    formVersion: schema.version,
    answers,
    submittedVia: input.submittedVia ?? "liff",
    idempotencyKey: input.idempotencyKey,
    clientMeta: capMeta(input.clientMeta),
    createdAt: now,
  };

  try {
    await profiles.insertOne(profileDoc);
  } catch (e) {
    // unique(idempotencyKey) — กดส่งรัว ๆ หรือเน็ตหลุดแล้วกดใหม่ ต้องไม่เกิด revision ซ้ำ
    if ((e as { code?: number }).code === 11000) {
      const existing = await profiles.findOne({ idempotencyKey: input.idempotencyKey });
      log.info("submit ซ้ำด้วย key เดิม — คืนผลลัพธ์เดิม", { customerId, revision: existing?.revision });
      return { ok: true, customerId: existing?.customerId ?? customerId, revision: existing?.revision ?? revision, merged, duplicate: true };
    }
    throw e;
  }

  const set: Record<string, unknown> = {
    updatedAt: now,
    "sheetSync.dirty": true,
    "aiSync.dirty": true,
    profileRef: { revision, formId: schema.formId, formVersion: schema.version, updatedAt: now },
  };

  // เขียนกลับเข้า customers ตาม bindTo ของแต่ละ field
  if (typeof answers.title === "string") set.title = answers.title;
  if (typeof answers.heardFrom === "string") set.heardFrom = answers.heardFrom;
  if (typeof answers.fullNameTh === "string") set.displayName = answers.fullNameTh;
  if (typeof answers.nickname === "string") set.nickname = answers.nickname;
  if (typeof answers.fullNameEn === "string") set.fullNameEn = answers.fullNameEn;
  if (typeof answers.birthYear === "number") set.birthYear = answers.birthYear;
  if (typeof answers.facebook === "string") set.facebook = answers.facebook;
  if (typeof answers.instagram === "string") set.instagram = answers.instagram;
  if (phone) set.phone = phone;
  if (email) set.email = email;

  if (pendingMergeWith) {
    set.pendingMerge = { candidateId: pendingMergeWith, reason: "phone_match", at: now };
  }

  if (answers.consentDataProcessing === true) {
    set.consent = {
      dataProcessing: true,
      marketing: answers.consentMarketing === true,
      version: input.consentContext?.version ?? "1.0",
      grantedAt: now,
      ip: input.consentContext?.ip ?? null,
      userAgent: input.consentContext?.userAgent ?? null,
    };
  }

  await customers.updateOne(
    { _id: customerId },
    { $set: set, $inc: { "counters.formSubmits": 1 }, $addToSet: { tags: "form-completed" }, $max: { lastInteractionAt: now } }
  );

  await db.collection<InteractionDoc>(COLLECTIONS.interactions).insertOne({
    _id: new ObjectId(),
    customerId,
    type: "form_submit",
    channel: "liff",
    occurredAt: now,
    sourceEventId: input.idempotencyKey, // unique index กันบันทึกซ้ำ
    payload: { formId: schema.formId, formVersion: schema.version, revision },
    createdAt: now,
  }).catch((e) => {
    if ((e as { code?: number }).code !== 11000) throw e;
  });

  if (pendingMergeWith) {
    await db.collection<AuditLogDoc>(COLLECTIONS.auditLogs).insertOne({
      _id: new ObjectId(), actor: input.submittedVia ?? "liff", action: "customer.merge_pending",
      customerId, before: null, after: { candidateId: pendingMergeWith },
      reason: "เบอร์ตรงกับลูกค้าอีกคน — รอเจ้าหน้าที่ตรวจสอบ", at: now,
    });
  }

  return { ok: true, customerId, revision, merged, duplicate: false, pendingMerge: Boolean(pendingMergeWith) };
}
