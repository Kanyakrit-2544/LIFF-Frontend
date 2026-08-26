import {
  COLLECTIONS,
  DEFAULT_FORM_ID,
  decrypt,
  getDb,
  getPublishedSchema,
  log,
  type CustomerDoc,
  type CustomerProfileDoc,
} from "@line-crm/core";
import { requireSession } from "@/lib/session";
import { fail, newRequestId, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * GET /api/liff/bootstrap  (docs/03 §3.5)
 *
 * รวม profile + ข้อมูลเดิม + form schema ไว้ใน request เดียว
 * เหตุผล: LIFF เปิดบนมือถือผ่านเน็ตมือถือ ทุก round-trip ที่ตัดได้มีผลกับความรู้สึกตอนเปิดหน้า
 */
export async function GET() {
  const requestId = newRequestId();
  const auth = await requireSession(requestId);
  if (!auth.ok) return auth.response;

  const { sub: customerId } = auth.session;

  try {
    const db = await getDb();
    const [customer, schema, lastProfile] = await Promise.all([
      db.collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: customerId }),
      getPublishedSchema(DEFAULT_FORM_ID),
      db
        .collection<CustomerProfileDoc>(COLLECTIONS.customerProfiles)
        .findOne({ customerId }, { sort: { revision: -1 } }),
    ]);

    if (!customer) return fail("NOT_FOUND", "ไม่พบข้อมูลลูกค้า", requestId);
    if (!schema) {
      log.error("ยังไม่มี form schema ที่ published", { requestId, formId: DEFAULT_FORM_ID });
      return fail("INTERNAL_ERROR", "ยังไม่ได้ตั้งค่าแบบฟอร์ม", requestId);
    }

    // ค่าที่ระบบมีอยู่แล้ว ใช้เติมลงฟอร์มให้ลูกค้าไม่ต้องพิมพ์ซ้ำ
    // PII ถอดรหัสตรงนี้เพราะเป็นข้อมูลของเจ้าตัวเอง (session ยืนยันแล้ว) ไม่ใช่ของคนอื่น
    const prefill: Record<string, unknown> = {
      fullNameTh: customer.displayName ?? "",
      nickname: customer.nickname ?? "",
      fullNameEn: customer.fullNameEn ?? "",
      birthYear: customer.birthYear ? String(customer.birthYear) : "",
      phone: safeDecrypt(customer.phone?.enc, requestId),
      email: safeDecrypt(customer.email?.enc, requestId),
      facebook: customer.facebook ?? "",
      instagram: customer.instagram ?? "",
      consentDataProcessing: customer.consent?.dataProcessing ?? false,
      consentMarketing: customer.consent?.marketing ?? false,
      ...(lastProfile?.answers ?? {}),
    };

    return ok(
      {
        profile: {
          customerId: customer._id,
          displayName: customer.displayName,
          lineDisplayName: customer.lineDisplayName,
          pictureUrl: customer.pictureUrl,
          customerStatus: customer.customerStatus,
          memberSince: customer.firstInteractionAt?.toISOString() ?? null,
          hasSubmittedBefore: Boolean(lastProfile),
        },
        formSchema: schema,
        prefill,
        consentRequired: !customer.consent?.dataProcessing,
      },
      requestId
    );
  } catch (e) {
    log.error("bootstrap ล้มเหลว", { requestId, error: (e as Error).message });
    return fail("INTERNAL_ERROR", "โหลดข้อมูลไม่สำเร็จ", requestId);
  }
}

/** ถอดรหัสไม่ได้ (เช่นหมุน key แล้วข้อมูลเก่าอ่านไม่ออก) ต้องไม่ทำให้ทั้งหน้าเปิดไม่ขึ้น */
function safeDecrypt(enc: string | undefined | null, requestId: string): string {
  if (!enc) return "";
  try {
    return decrypt(enc);
  } catch (e) {
    log.warn("ถอดรหัส PII ไม่สำเร็จ", { requestId, error: (e as Error).message });
    return "";
  }
}
