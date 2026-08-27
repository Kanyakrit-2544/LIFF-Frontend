import {
  applyFormSubmission,
  checkRateLimit,
  DEFAULT_FORM_ID,
  getPublishedSchema,
  getSchemaVersion,
  log,
  publish,
} from "@line-crm/core";
import { safeAfter } from "@/lib/afterSafe";
import { requireSession } from "@/lib/session";
import { fail, newRequestId, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * POST /api/liff/customer/profile  (docs/03 §3.6)
 *
 * ⚠️ customerId มาจาก session เท่านั้น — ไม่รับจาก body ไม่ว่ากรณีใด
 */
/** สรุปว่าแต่ละช่องมีค่าไหม/ยาวเท่าไร โดยไม่เอาค่าจริงออกมา */
function summarizeAnswers(answers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(answers)) {
    if (v === undefined || v === null || v === "") out[k] = "ว่าง";
    else if (typeof v === "boolean") out[k] = v ? "ติ๊ก" : "ไม่ติ๊ก";
    else if (Array.isArray(v)) out[k] = `เลือก ${v.length} ข้อ`;
    else out[k] = `กรอก ${String(v).length} ตัวอักษร`;
  }
  return out;
}

export async function POST(req: Request) {
  const requestId = newRequestId();
  const auth = await requireSession(requestId);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("VALIDATION_FAILED", "body ไม่ใช่ JSON", requestId);
  }

  // ปฏิเสธชนิดผิดตรง ๆ ดีกว่าเงียบ ๆ แล้วใช้ค่า default — ไม่งั้น client ส่งอะไรผิดก็ไม่รู้ตัว
  if ("formId" in body && typeof body.formId !== "string") {
    return fail("VALIDATION_FAILED", "formId ต้องเป็นข้อความ", requestId);
  }
  const formId = typeof body.formId === "string" ? body.formId : DEFAULT_FORM_ID;
  const formVersion = typeof body.formVersion === "string" ? body.formVersion : null;
  const answers = body.answers && typeof body.answers === "object" ? (body.answers as Record<string, unknown>) : null;
  const idempotencyKey =
    (typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()) ||
    req.headers.get("idempotency-key") ||
    "";

  if (!answers) return fail("VALIDATION_FAILED", "ต้องส่ง answers", requestId);
  if (!idempotencyKey) return fail("VALIDATION_FAILED", "ต้องส่ง idempotencyKey", requestId);
  if (!formVersion) return fail("VALIDATION_FAILED", "ต้องส่ง formVersion", requestId);

  // docs/03 §3.13 — 5 ครั้ง/นาที/ลูกค้า
  const rl = await checkRateLimit(`liff:profile:${auth.session.sub}`, 5, 60);
  if (!rl.allowed) {
    log.warn("ส่งฟอร์มถี่เกินกำหนด", { requestId, retryAfterSec: rl.retryAfterSec });
    return fail("RATE_LIMITED", `ส่งข้อมูลถี่เกินไป กรุณารอ ${rl.retryAfterSec} วินาที`, requestId);
  }

  try {
    const schema = await getSchemaVersion(formId, formVersion);
    if (!schema) return fail("NOT_FOUND", "ไม่พบแบบฟอร์มเวอร์ชันนี้", requestId);

    // ฟอร์มที่เปิดค้างไว้ข้ามวันแล้วเราเปลี่ยน schema ไปแล้ว — ให้ client โหลดใหม่
    // ดีกว่าปล่อยให้บันทึกตาม schema เก่าที่เลิกใช้แล้ว
    if (schema.status !== "published") {
      const current = await getPublishedSchema(formId);
      return fail("CONFLICT", "แบบฟอร์มมีเวอร์ชันใหม่แล้ว กรุณารีเฟรชหน้า", requestId, {
        currentVersion: current?.version ?? null,
      });
    }

    const result = await applyFormSubmission({
      customerId: auth.session.sub,
      schema,
      answers,
      idempotencyKey,
      submittedVia: "liff",
      clientMeta: body.clientMeta && typeof body.clientMeta === "object" ? (body.clientMeta as Record<string, unknown>) : {},
      consentContext: {
        ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        userAgent: req.headers.get("user-agent"),
        version: schema.version,
      },
    });

    if (!result.ok) {
      return fail("VALIDATION_FAILED", "ข้อมูลบางช่องไม่ถูกต้อง", requestId, result.issues);
    }

    // log ว่ากรอกอะไรมาบ้าง — บันทึก "ชื่อช่อง + กรอกหรือไม่ + ยาวเท่าไร" ไม่ใช่ค่าจริง
    // ค่าจริงเป็นข้อมูลส่วนบุคคล และ log บน Vercel ถูกส่งต่อ/ก็อปวางได้ง่าย (docs/06 §6.11)
    log.info("รับข้อมูลจากฟอร์ม LIFF", {
      requestId,
      revision: result.revision,
      duplicate: result.duplicate,
      pendingMerge: Boolean(result.pendingMerge),
      formVersion,
      fields: summarizeAnswers(answers),
      filled: Object.values(answers).filter((v) => v !== "" && v !== null && v !== undefined && v !== false).length,
      total: Object.keys(answers).length,
    });

    if (!result.duplicate) {
      safeAfter(
        () => publish("FORM", { requestId, customerId: result.customerId, revision: result.revision, merged: result.merged }),
        { requestId, topic: "FORM" }
      );
    }

    return ok(
      {
        customerId: result.customerId,
        revision: result.revision,
        merged: result.merged,
        message: "บันทึกข้อมูลเรียบร้อยแล้ว",
      },
      requestId
    );
  } catch (e) {
    log.error("บันทึกฟอร์มไม่สำเร็จ", { requestId, error: (e as Error).message });
    return fail("INTERNAL_ERROR", "บันทึกข้อมูลไม่สำเร็จ", requestId);
  }
}
