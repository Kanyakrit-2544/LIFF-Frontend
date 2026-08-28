import {
  enqueueEvents,
  env,
  extractLeadgenNotifications,
  log,
  verifyMetaSignature,
  type MetaWebhookBody,
} from "@line-crm/core";
import { ok, fail, newRequestId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * Webhook ของ Facebook Lead Ads (docs/28)
 *
 * เก็บแค่ leadgen_id + id แคมเปญ — Meta ไม่ส่งข้อมูลลูกค้ามากับ webhook อยู่แล้ว
 * จึงไม่มี PII ตกอยู่ใน inbound_events เลย (D31) รายละเอียดค่อยไปดึงจาก Graph API ทีหลัง
 *
 * ยังไม่ตั้ง env = ตอบ 404 เหมือนไม่มี route นี้อยู่ (D32)
 * endpoint สาธารณะไม่ควรบอกใบ้ว่ามีอะไรรออยู่
 */

function config() {
  try {
    return env("facebook");
  } catch {
    return null;
  }
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

/** Meta เรียกตอนตั้ง webhook — ต้องตอบ challenge เป็น text ล้วน ไม่ใช่ JSON */
export function GET(req: Request): Response {
  const c = config();
  if (!c?.FACEBOOK_VERIFY_TOKEN) return notFound();

  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode !== "subscribe" || token !== c.FACEBOOK_VERIFY_TOKEN) {
    log.warn("Facebook verify ไม่ผ่าน", { mode, hasToken: Boolean(token) });
    return new Response("Forbidden", { status: 403 });
  }
  return new Response(challenge ?? "", { status: 200, headers: { "content-type": "text/plain" } });
}

export async function POST(req: Request) {
  const requestId = newRequestId();
  const c = config();
  if (!c?.FACEBOOK_APP_SECRET) return notFound();

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return fail("VALIDATION_FAILED", "อ่าน request body ไม่ได้", requestId);
  }

  if (!verifyMetaSignature(rawBody, req.headers.get("x-hub-signature-256"), c.FACEBOOK_APP_SECRET)) {
    log.warn("Facebook signature ไม่ผ่าน", { requestId, bytes: rawBody.length });
    return fail("UNAUTHORIZED", "signature ไม่ถูกต้อง", requestId);
  }

  let body: MetaWebhookBody;
  try {
    body = JSON.parse(rawBody) as MetaWebhookBody;
  } catch {
    return fail("VALIDATION_FAILED", "body ไม่ใช่ JSON", requestId);
  }

  const notifications = extractLeadgenNotifications(body);
  // Meta ยิง body ว่างตอนกดทดสอบใน console — ต้องตอบ 200 ไม่งั้นตั้ง webhook ไม่ผ่าน
  if (notifications.length === 0) return ok({ accepted: 0, duplicated: 0 }, requestId);

  // กันรับ event ของเพจอื่นที่ยิงมาผิดที่
  const allowed = c.FACEBOOK_PAGE_ID
    ? notifications.filter((n) => n.pageId === c.FACEBOOK_PAGE_ID)
    : notifications;
  if (allowed.length === 0) {
    log.warn("Facebook webhook มาจากเพจที่ไม่รู้จัก", { requestId, pages: [...new Set(notifications.map((n) => n.pageId))] });
    return ok({ accepted: 0, duplicated: 0, ignored: notifications.length }, requestId);
  }

  try {
    const r = await enqueueEvents(
      allowed.map((n) => ({
        eventId: n.leadgenId, // กันซ้ำในตัวเอง — Meta ยิงซ้ำได้ ไม่มี timestamp ในลายเซ็นให้กัน replay
        provider: "facebook",
        channelId: n.pageId,
        raw: { ...n } as unknown as Record<string, unknown>,
      }))
    );
    log.info("รับ Facebook lead webhook", { requestId, total: allowed.length, accepted: r.accepted, duplicated: r.duplicated });
    return ok({ accepted: r.accepted, duplicated: r.duplicated }, requestId);
  } catch (e) {
    // Mongo ล่ม → ตอบ 5xx ให้ Meta retry ดีกว่าตอบ 200 แล้วทำ lead หาย
    log.error("enqueue lead ล้มเหลว", { requestId, error: (e as Error).message });
    return fail("UPSTREAM_ERROR", "บันทึก event ไม่สำเร็จ", requestId);
  }
}
