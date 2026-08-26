/**
 * ใส่ form_schemas ตัวแรกลง MongoDB
 * ฟิลด์ทั้งหมดมาจาก docs/08 §8.2 ที่เจ้าของงานยืนยันแล้ว
 *
 *   npm run seed:form            สร้าง/อัปเดตแล้ว publish
 *   npm run seed:form -- --dry   แสดงอย่างเดียว ไม่เขียน DB
 */
import { upsertSchema, getPublishedSchema } from "../packages/core/src/forms/schemaStore";
import { buildZodFromSchema } from "../packages/core/src/forms/buildZod";
import type { FormSchemaDoc, FieldOption } from "../packages/core/src/forms/types";
import { closeClient } from "../packages/core/src/db/client";

const FORM_ID = "customer_onboarding";
const VERSION = "v1";

// ปีเกิด พ.ศ. (D16) — เก็บเป็น select ธรรมดาโดยตั้งใจ ไม่ทำ type พิเศษ
// จะได้ไม่ต้องแก้โค้ดทั้ง client และ server เวลาอยากเปลี่ยนช่วงปี
const currentBE = new Date().getFullYear() + 543;
const birthYearOptions: FieldOption[] = Array.from({ length: 86 }, (_, i) => {
  const y = currentBE - 5 - i; // อายุขั้นต่ำ 5 ปี ย้อนไป 86 ปี
  return { value: String(y), label: { th: String(y), en: String(y - 543) } };
});

const schema: FormSchemaDoc = {
  _id: `${FORM_ID}@${VERSION}`,
  formId: FORM_ID,
  version: VERSION,
  status: "published",
  title: { th: "ข้อมูลลูกค้า", en: "Customer Information" },
  submitLabel: { th: "บันทึกข้อมูล", en: "Save" },
  createdAt: new Date(),
  publishedAt: new Date(),
  sections: [
    {
      id: "line",
      title: { th: "ข้อมูลจาก LINE", en: "From LINE" },
      description: { th: "ดึงมาจากบัญชี LINE ของคุณอัตโนมัติ", en: "Fetched from your LINE account" },
      fields: [
        { id: "pictureUrl", type: "image", label: { th: "รูปโปรไฟล์", en: "Profile picture" }, bindTo: "customers.pictureUrl" },
        { id: "lineDisplayName", type: "readonly", label: { th: "ชื่อใน LINE", en: "LINE name" }, bindTo: "customers.lineDisplayName" },
      ],
    },
    {
      id: "identity",
      title: { th: "ข้อมูลของคุณ", en: "Your details" },
      fields: [
        {
          id: "fullNameTh", type: "text", label: { th: "ชื่อ-นามสกุล", en: "Full name" },
          placeholder: { th: "เช่น สมชาย ใจดี" }, help: { th: "ชื่อจริงสำหรับออกใบเสร็จและใบประกาศ" },
          bindTo: "customers.displayName", pii: true,
          validate: { required: true, minLength: 2, maxLength: 120 },
        },
        {
          id: "nickname", type: "text", label: { th: "ชื่อเล่น", en: "Nickname" },
          bindTo: "customers.nickname", validate: { maxLength: 60 },
        },
        {
          id: "fullNameEn", type: "text", label: { th: "ชื่อ-นามสกุล (ภาษาอังกฤษ)", en: "Full name (English)" },
          placeholder: { th: "Somchai Jaidee" }, bindTo: "customers.fullNameEn", pii: true,
          validate: { maxLength: 120, pattern: "^[A-Za-z .'-]*$" },
        },
        {
          id: "birthYear", type: "select", label: { th: "ปีเกิด (พ.ศ.)", en: "Birth year (B.E.)" },
          bindTo: "customers.birthYear", options: birthYearOptions,
        },
        {
          id: "phone", type: "tel", label: { th: "เบอร์โทรศัพท์", en: "Phone" },
          placeholder: { th: "08xxxxxxxx" }, help: { th: "ใช้ยืนยันตัวตนและติดต่อกลับ" },
          bindTo: "customers.phone", pii: true, validate: { required: true },
        },
        {
          id: "email", type: "email", label: { th: "อีเมล", en: "Email" },
          placeholder: { th: "you@example.com" }, bindTo: "customers.email", pii: true,
          validate: { maxLength: 254 },
        },
      ],
    },
    {
      id: "social",
      title: { th: "ช่องทางอื่น (ไม่บังคับ)", en: "Other channels (optional)" },
      fields: [
        { id: "facebook", type: "text", label: { th: "Facebook", en: "Facebook" }, bindTo: "customers.facebook", validate: { maxLength: 120 } },
        { id: "instagram", type: "text", label: { th: "Instagram", en: "Instagram" }, bindTo: "customers.instagram", validate: { maxLength: 120 } },
      ],
    },
    {
      id: "consent",
      title: { th: "ความยินยอม", en: "Consent" },
      fields: [
        {
          id: "consentDataProcessing", type: "consent",
          label: { th: "ยินยอมให้เก็บและใช้ข้อมูลส่วนบุคคลเพื่อการให้บริการ", en: "I consent to processing of my personal data" },
          validate: { required: true },
        },
        {
          id: "consentMarketing", type: "consent",
          label: { th: "ยินดีรับข่าวสารและโปรโมชัน", en: "Send me news and promotions" },
        },
      ],
    },
  ],
};

async function main() {
  const dry = process.argv.includes("--dry");

  // ตรวจว่า schema ที่จะใส่สร้าง zod ได้จริงก่อนเขียนลง DB
  const z = buildZodFromSchema(schema);
  const probe = z.safeParse({ fullNameTh: "ทดสอบ ระบบ", phone: "0812345678", consentDataProcessing: true });
  if (!probe.success) {
    console.error("❌ schema สร้าง zod แล้วใช้ไม่ได้:", probe.error.issues);
    process.exitCode = 1;
    return;
  }

  const fields = schema.sections.flatMap((s) => s.fields);
  console.log(`form: ${schema._id}  (${schema.sections.length} section, ${fields.length} field)`);
  for (const s of schema.sections) {
    console.log(`  [${s.id}] ${s.title.th}`);
    for (const f of s.fields) {
      const req = f.validate?.required ? " *จำเป็น" : "";
      const pii = f.pii ? " 🔒" : "";
      console.log(`     - ${f.id.padEnd(22)} ${f.type.padEnd(9)} ${f.label.th}${req}${pii}`);
    }
  }

  if (dry) {
    console.log("\n(--dry: ไม่เขียน DB)");
    return;
  }

  await upsertSchema(schema);
  const published = await getPublishedSchema(FORM_ID);
  console.log(`\n✅ เขียนลง DB แล้ว — published version = ${published?.version ?? "(ไม่พบ)"}`);
}

main()
  .catch((e) => {
    console.error("❌", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeClient());
