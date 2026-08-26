import { getDb } from "../db/client";
import { COLLECTIONS } from "../db/models";
import type { FormSchemaDoc } from "./types";

export const DEFAULT_FORM_ID = "customer_onboarding";

async function col() {
  return (await getDb()).collection<FormSchemaDoc>(COLLECTIONS.formSchemas);
}

/** เวอร์ชันที่ published ล่าสุดของ form นั้น — ใช้ตอน LIFF ขอฟอร์มมาแสดง */
export async function getPublishedSchema(formId = DEFAULT_FORM_ID): Promise<FormSchemaDoc | null> {
  return (await col()).findOne({ formId, status: "published" }, { sort: { publishedAt: -1 } });
}

/**
 * ดึงเวอร์ชันเจาะจง — ใช้ตอนรับ submit
 * ต้องตรวจว่าเวอร์ชันที่ client ส่งมายัง published อยู่ ไม่งั้นคนที่เปิดฟอร์มค้างไว้ข้ามวัน
 * จะส่งข้อมูลตาม schema เก่าที่เราเลิกใช้แล้ว
 */
export async function getSchemaVersion(formId: string, version: string): Promise<FormSchemaDoc | null> {
  return (await col()).findOne({ _id: `${formId}@${version}` });
}

export async function upsertSchema(doc: FormSchemaDoc): Promise<void> {
  await (await col()).replaceOne({ _id: doc._id }, doc, { upsert: true });
}
