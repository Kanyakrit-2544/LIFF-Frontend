import { z } from "zod";
import type { FormField, FormSchemaDoc, VisibleIf } from "./types";
import { normalizePhone, normalizeEmail, normalizeBirthYearBE } from "../identity/normalize";

/**
 * สร้าง zod schema จาก form_schemas ที่เก็บใน DB
 *
 * ทำไมต้องมี: ถ้า validation ฝั่ง server เป็น hardcode แล้วคำถามใน DB เปลี่ยน
 * จะเกิดช่องว่าง — field ใหม่ผ่านเข้ามาโดยไม่ถูกตรวจ หรือ field ที่ลบไปแล้วยังบังคับกรอกอยู่
 *
 * ⚠️ ใช้ .strict() เสมอ — field ที่ไม่ได้อยู่ใน schema ต้องถูกปฏิเสธ ไม่ใช่ปล่อยผ่าน
 *    (กัน mass assignment: ยิง customerStatus:"vip" หรือ isAdmin:true แนบมากับฟอร์ม)
 */

export const ALL_FIELDS = "__all__";

function isVisible(cond: VisibleIf | undefined, answers: Record<string, unknown>): boolean {
  if (!cond) return true;
  const v = answers[cond.field];
  switch (cond.op) {
    case "eq":
      return v === cond.value;
    case "ne":
      return v !== cond.value;
    case "in":
      return Array.isArray(cond.value) && (cond.value as unknown[]).includes(v);
    case "truthy":
      return Boolean(v);
    default:
      return true;
  }
}

function stringRules(f: FormField) {
  let s = z.string().trim();
  const v = f.validate ?? {};
  if (v.minLength !== undefined) s = s.min(v.minLength, `${f.label.th}: สั้นเกินไป`);
  if (v.maxLength !== undefined) s = s.max(v.maxLength, `${f.label.th}: ยาวเกินกำหนด`);
  if (v.pattern) s = s.regex(new RegExp(v.pattern), `${f.label.th}: รูปแบบไม่ถูกต้อง`);
  return s;
}

function fieldSchema(f: FormField): z.ZodTypeAny {
  const v = f.validate ?? {};

  switch (f.type) {
    case "readonly":
    case "image":
      // ไม่รับค่าจาก client — เป็นข้อมูลที่ระบบแสดงให้ดูเท่านั้น
      return z.undefined().optional();

    case "tel":
      return z
        .string()
        .trim()
        .superRefine((val, ctx) => {
          if (!val) return;
          if (!normalizePhone(val)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${f.label.th}: เบอร์โทรไม่ถูกต้อง` });
        });

    case "email":
      return z
        .string()
        .trim()
        .superRefine((val, ctx) => {
          if (!val) return;
          if (!normalizeEmail(val)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${f.label.th}: อีเมลไม่ถูกต้อง` });
        });

    case "number":
      return z.coerce.number().superRefine((val, ctx) => {
        if (v.min !== undefined && val < v.min) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${f.label.th}: น้อยกว่าที่กำหนด` });
        if (v.max !== undefined && val > v.max) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${f.label.th}: มากกว่าที่กำหนด` });
      });

    case "select":
    case "radio": {
      const allowed = (f.options ?? []).map((o) => o.value);
      if (allowed.length === 0) return z.string().trim();
      // ค่าที่ไม่อยู่ในตัวเลือก = ถูกปฏิเสธ ไม่ใช่เก็บไว้เฉย ๆ
      return z.string().refine((val) => val === "" || allowed.includes(val), { message: `${f.label.th}: ตัวเลือกไม่ถูกต้อง` });
    }

    case "checkbox": {
      const allowed = (f.options ?? []).map((o) => o.value);
      let arr = z.array(z.string());
      if (v.minItems !== undefined) arr = arr.min(v.minItems, `${f.label.th}: เลือกอย่างน้อย ${v.minItems} ข้อ`);
      if (v.maxItems !== undefined) arr = arr.max(v.maxItems, `${f.label.th}: เลือกได้ไม่เกิน ${v.maxItems} ข้อ`);
      if (allowed.length === 0) return arr;
      return arr.refine((vals) => vals.every((x) => allowed.includes(x)), { message: `${f.label.th}: มีตัวเลือกที่ไม่ถูกต้อง` });
    }

    case "consent":
      return z.boolean();

    case "text":
    case "textarea":
    default:
      return stringRules(f);
  }
}

export interface BuildOptions {
  /** ค่าที่ผู้ใช้ส่งมา — ใช้ตัดสิน visibleIf ว่า field ไหนต้องบังคับกรอก */
  answers?: Record<string, unknown>;
}

export function collectFields(schema: FormSchemaDoc): FormField[] {
  return schema.sections.flatMap((s) => s.fields);
}

export function buildZodFromSchema(schema: FormSchemaDoc, opts: BuildOptions = {}) {
  const answers = opts.answers ?? {};
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const f of collectFields(schema)) {
    if (f.type === "readonly" || f.type === "image") continue;

    const visible = isVisible(f.visibleIf, answers);
    const required = Boolean(f.validate?.required) && visible;
    let s = fieldSchema(f);

    if (required) {
      if (f.type === "consent") {
        s = z.literal(true, { errorMap: () => ({ message: `${f.label.th}: ต้องยินยอมก่อนจึงจะส่งข้อมูลได้` }) });
      } else if (f.type === "checkbox") {
        s = (s as z.ZodArray<z.ZodString>).min(Math.max(1, f.validate?.minItems ?? 1), `${f.label.th}: จำเป็นต้องเลือก`);
      } else {
        s = (s as z.ZodTypeAny).refine((val) => val !== undefined && val !== null && String(val).trim() !== "", {
          message: `${f.label.th}: จำเป็นต้องกรอก`,
        });
      }
    } else {
      s = s.optional();
    }

    shape[f.id] = s;
  }

  // .strict() = field แปลกปลอมทำให้ parse ล้มเหลว ไม่ใช่ถูกเมินเงียบ ๆ
  return z.object(shape).strict();
}

/** normalize ค่าหลังผ่าน validation แล้ว — ทำที่เดียวเพื่อไม่ให้แต่ละ route ทำไม่เหมือนกัน */
export function normalizeAnswers(schema: FormSchemaDoc, answers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of collectFields(schema)) {
    if (!(f.id in answers)) continue;
    const raw = answers[f.id];
    if (raw === undefined || raw === "") continue;

    if (f.type === "tel") out[f.id] = normalizePhone(raw) ?? raw;
    else if (f.type === "email") out[f.id] = normalizeEmail(raw) ?? raw;
    else if (f.id === "birthYear" || f.bindTo === "customers.birthYear") out[f.id] = normalizeBirthYearBE(raw) ?? raw;
    else if (typeof raw === "string") out[f.id] = raw.trim();
    else out[f.id] = raw;
  }
  return out;
}
