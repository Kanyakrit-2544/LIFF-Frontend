/**
 * Form schema ที่เก็บใน MongoDB (docs/02 `form_schemas`)
 * เจตนา: เพิ่ม/แก้/ลบคำถามได้โดยไม่ต้อง deploy — ทั้ง UI และ validation ฝั่ง server อ่านจากก้อนเดียวกัน
 */

export type FieldType =
  | "readonly"
  | "image"
  | "text"
  | "textarea"
  | "tel"
  | "email"
  | "number"
  | "select"
  | "radio"
  | "checkbox"
  | "consent";

export interface FieldOption {
  value: string;
  label: Localized;
}

export type Localized = { th: string; en?: string };

export interface FieldValidation {
  required?: boolean;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  /** สำหรับ checkbox หลายตัวเลือก */
  minItems?: number;
  maxItems?: number;
}

export interface VisibleIf {
  field: string;
  op: "eq" | "ne" | "in" | "truthy";
  value?: unknown;
}

export interface FormField {
  id: string;
  type: FieldType;
  label: Localized;
  placeholder?: Localized;
  help?: Localized;
  options?: FieldOption[];
  validate?: FieldValidation;
  /** ผูกกับ field ใน customers — ใช้ตอน prefill และตอนเขียนกลับ (S7) */
  bindTo?: string;
  /** field นี้เป็น PII → ต้องเข้ารหัสก่อนเก็บ */
  pii?: boolean;
  /** แสดงเฉพาะเมื่อเงื่อนไขเป็นจริง — ถ้าไม่แสดง จะไม่บังคับ required ด้วย */
  visibleIf?: VisibleIf;
}

export interface FormSection {
  id: string;
  title: Localized;
  description?: Localized;
  fields: FormField[];
}

export interface FormSchemaDoc {
  _id: string; // "<formId>@<version>"
  formId: string;
  version: string;
  status: "draft" | "published" | "archived";
  title: Localized;
  submitLabel?: Localized;
  sections: FormSection[];
  createdAt: Date;
  publishedAt: Date | null;
}
