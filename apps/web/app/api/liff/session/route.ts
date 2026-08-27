import { cookies } from "next/headers";
import {
  checkRateLimit,
  COLLECTIONS,
  createSession,
  env,
  getDb,
  log,
  redact,
  resolveLiffCustomer,
  SESSION_COOKIE,
  sessionCookieOptions,
  verifyLineIdToken,
  type CustomerDoc,
} from "@line-crm/core";
import { fail, newRequestId, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * POST /api/liff/session  (docs/03 §3.4)
 *
 * รับ id_token จาก LIFF → verify กับ LINE → ออก session cookie
 *
 * ⚠️ ตัวตนมาจาก `sub` ของ token ที่ verify แล้วเท่านั้น
 *    ห้ามรับ userId / customerId จาก request body ไม่ว่ากรณีใด (docs/00 RISK-2)
 */
export async function POST(req: Request) {
  const requestId = newRequestId();

  let body: { idToken?: unknown };
  try {
    body = (await req.json()) as { idToken?: unknown };
  } catch {
    return fail("VALIDATION_FAILED", "body ไม่ใช่ JSON", requestId);
  }

  const idToken = typeof body.idToken === "string" ? body.idToken : "";
  if (!idToken) return fail("VALIDATION_FAILED", "ต้องส่ง idToken", requestId);

  // กันคนยิง id_token มั่ว ๆ รัว ๆ เพื่อไล่เดา (แต่ละครั้งเราต้องยิงไปถาม LINE)
  const ipKey = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = await checkRateLimit(`liff:session:${ipKey}`, 20, 60);
  if (!rl.allowed) {
    return fail("RATE_LIMITED", `เรียกถี่เกินไป กรุณารอ ${rl.retryAfterSec} วินาที`, requestId);
  }

  const verified = await verifyLineIdToken(idToken);
  if (!verified.ok) {
    log.warn("id_token ใช้ไม่ได้", { requestId, code: verified.code });
    // คืน code ให้ frontend ตัดสินใจได้ว่าควรสั่ง liff.login() ใหม่หรือแสดง error
    return fail("UNAUTHORIZED", verified.message, requestId, { reason: verified.code });
  }

  const { sub, name, picture, email } = verified.payload;

  try {
    const resolved = await resolveLiffCustomer(sub);
    const customers = (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers);

    // เก็บเฉพาะกระจกของ LINE — ห้ามแตะ displayName
    // displayName คือ "ชื่อ-นามสกุลจริง" ที่ลูกค้ากรอกเอง ถ้าเติมชื่อ LINE ให้
    // ช่องในฟอร์มจะมีชื่อเล่น LINE อยู่แล้วตั้งแต่เปิดครั้งแรก ลูกค้าก็กดส่งทับไปเลย
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (name) set.lineDisplayName = name;
    if (picture) set.pictureUrl = picture;
    if (Object.keys(set).length > 1) await customers.updateOne({ _id: resolved.customerId }, { $set: set });

    const doc = await customers.findOne(
      { _id: resolved.customerId },
      { projection: { displayName: 1, lineDisplayName: 1, pictureUrl: 1, customerStatus: 1 } }
    );

    const jar = await cookies();
    jar.set(SESSION_COOKIE, createSession({ customerId: resolved.customerId, lineUserId: sub, channelId: env("line").LINE_LOGIN_CHANNEL_ID }), sessionCookieOptions());

    return ok(
      {
        customer: {
          customerId: resolved.customerId,
          displayName: doc?.displayName ?? name ?? null,
          lineDisplayName: doc?.lineDisplayName ?? name ?? null,
          pictureUrl: doc?.pictureUrl ?? picture ?? null,
          customerStatus: doc?.customerStatus ?? "lead",
          isNew: resolved.isNew,
        },
        // มีเฉพาะเมื่อ Email permission อนุมัติแล้วและผู้ใช้ยินยอม (D18) — ใช้ prefill ช่องอีเมล
        lineEmail: email ?? null,
      },
      requestId
    );
  } catch (e) {
    const msg = (e as Error).message ?? "";
    log.error("สร้าง session ไม่สำเร็จ", { requestId, error: msg });
    // ส่งสาเหตุแบบย่อกลับไปด้วย เพื่อให้ดีบักได้โดยไม่ต้องพึ่ง log ของ Vercel
    // ตัดเหลือ 160 ตัวและผ่าน redact แล้ว — ไม่มี PII และไม่มี stack trace
    return fail("INTERNAL_ERROR", "เข้าสู่ระบบไม่สำเร็จ", requestId, {
      cause: String(redact(msg)).slice(0, 160),
    });
  }
}
