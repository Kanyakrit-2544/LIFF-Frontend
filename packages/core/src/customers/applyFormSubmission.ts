import { ObjectId } from "mongodb";
import { getDb } from "../db/client";
import { COLLECTIONS, type CustomerDoc, type CustomerProfileDoc, type InteractionDoc } from "../db/models";
import { buildZodFromSchema, normalizeAnswers } from "../forms/buildZod";
import type { FormSchemaDoc } from "../forms/types";
import { packEmail, packPhone } from "../security/pii";
import { mergeCustomers, pickWinner } from "../identity/merge";
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
  | { ok: true; customerId: string; revision: number; merged: boolean; duplicate: boolean }
  | { ok: false; code: "VALIDATION_FAILED"; issues: Array<{ field: string; message: string }> };

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

  const phone = typeof answers.phone === "string" && answers.phone.startsWith("+") ? packPhone(answers.phone) : null;
  const email = typeof answers.email === "string" && answers.email.includes("@") ? packEmail(answers.email) : null;

  let customerId = input.customerId;
  let merged = false;

  // ── 3. เบอร์ตรงกับลูกค้าคนอื่น → merge ──────────────────────
  if (phone) {
    const other = await customers.findOne({ phoneHash: phone.hash, status: "active", _id: { $ne: customerId } });
    if (other) {
      const self = await customers.findOne({ _id: customerId });
      if (self) {
        const { winner, loser } = await pickWinner(self, other);
        await mergeCustomers(winner._id, loser._id, "phone_match", "liff:form_submit");
        customerId = winner._id;
        merged = true;
      }
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
    clientMeta: input.clientMeta ?? {},
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
    profileRef: { revision, formId: schema.formId, formVersion: schema.version, updatedAt: now },
  };

  // เขียนกลับเข้า customers ตาม bindTo ของแต่ละ field
  if (typeof answers.fullNameTh === "string") set.displayName = answers.fullNameTh;
  if (typeof answers.nickname === "string") set.nickname = answers.nickname;
  if (typeof answers.fullNameEn === "string") set.fullNameEn = answers.fullNameEn;
  if (typeof answers.birthYear === "number") set.birthYear = answers.birthYear;
  if (typeof answers.facebook === "string") set.facebook = answers.facebook;
  if (typeof answers.instagram === "string") set.instagram = answers.instagram;
  if (phone) { set.phone = phone; set.phoneHash = phone.hash; }
  if (email) { set.email = email; set.emailHash = email.hash; }

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

  return { ok: true, customerId, revision, merged, duplicate: false };
}
