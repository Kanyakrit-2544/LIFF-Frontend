import {
  env,
  forwardChatToTagger,
  log,
  verifyLineSignature,
  redactLineEvents,
  enqueueEvents,
  publish,
  type LineWebhookBody,
  type LineEvent,
} from "@line-crm/core";
import { ok, fail, newRequestId } from "@/lib/http";
import { safeAfter } from "@/lib/afterSafe";

export const runtime = "nodejs"; // ต้องใช้ crypto + mongodb driver
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * POST /api/webhook/line  (docs/03 §3.3)
 *
 * เป้าหมายเดียว: **รับให้ครบแล้วตอบ 200 ให้เร็วที่สุด**
 * การประมวลผลจริงเกิดทีหลังโดย n8n ซึ่งดึงจาก inbound_events
 *
 * ลำดับสำคัญ:
 *   1. อ่าน raw body ก่อน parse — signature คำนวณจาก byte ดิบ
 *   2. verify signature — ผิด = 401 ทันที ไม่แตะ database
 *   3. enqueue แบบ idempotent
 *   4. ตอบ 200
 *   5. push ไป n8n ทีหลัง (after) — ล้มเหลวได้ ไม่กระทบ response
 */
export async function POST(req: Request) {
  const requestId = newRequestId();
  const t0 = Date.now();

  // ── 1. raw body ────────────────────────────────────────────────
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return fail("VALIDATION_FAILED", "อ่าน request body ไม่ได้", requestId);
  }

  // ── 2. signature ───────────────────────────────────────────────
  const signature = req.headers.get("x-line-signature");
  let channelSecret: string;
  try {
    channelSecret = env("line").LINE_CHANNEL_SECRET;
  } catch (e) {
    log.error("env ของ LINE ไม่ครบ", { requestId, error: (e as Error).message });
    return fail("INTERNAL_ERROR", "ระบบยังตั้งค่าไม่เรียบร้อย", requestId);
  }

  if (!verifyLineSignature(rawBody, signature, channelSecret)) {
    // ไม่บอกเหตุผลว่าผิดตรงไหน — กันคนเดา signature
    log.warn("signature ไม่ผ่าน", { requestId, hasSignature: Boolean(signature), bytes: rawBody.length });
    return fail("UNAUTHORIZED", "signature ไม่ถูกต้อง", requestId);
  }

  // ── 3. parse ───────────────────────────────────────────────────
  let body: LineWebhookBody;
  try {
    body = JSON.parse(rawBody) as LineWebhookBody;
  } catch {
    return fail("VALIDATION_FAILED", "body ไม่ใช่ JSON", requestId);
  }

  const events: LineEvent[] = Array.isArray(body.events) ? body.events : [];
  const channelId = body.destination ?? null;
  if (!channelId) log.warn("LINE webhook ไม่มี destination", { requestId });

  // ── 3.5 ส่งต่อให้ระบบ tag ก่อน redact (docs/26 §D) ──────────────
  // LINE ตั้ง webhook ได้ channel ละ 1 อัน ระบบ tag ที่ต้องอ่านแชทจึงต้องพึ่งการส่งต่อจากที่นี่
  // ส่ง byte เดิม + ลายเซ็นเดิม แล้วปล่อยทิ้ง — ระบบนี้ยังไม่เก็บข้อความเหมือนเดิม (D4)
  // เป็น best-effort ทำหลังตอบ 200 แล้ว ปลายทางล่มไม่กระทบ LINE และไม่กระทบ inbound_events
  if (events.length > 0) {
    safeAfter(() => forwardChatToTagger(rawBody, signature), { requestId, target: "tagger" });
  }

  // LINE ยิง events ว่างตอนกดปุ่ม Verify ใน console — ต้องตอบ 200 ไม่งั้นตั้ง webhook ไม่ผ่าน
  if (events.length === 0) {
    return ok({ accepted: 0, duplicated: 0, verify: true }, requestId);
  }

  // ── 4. enqueue ─────────────────────────────────────────────────
  const redacted = redactLineEvents(events); // D4: ตัดข้อความลูกค้าทิ้งก่อนเก็บ
  const items = redacted
    .map((e, i) => ({
      // LINE ส่ง webhookEventId มาให้เสมอในปัจจุบัน แต่กันเหนียวด้วย fallback ที่ deterministic
      eventId: e.webhookEventId ?? `${body.destination ?? "unknown"}:${e.timestamp ?? 0}:${i}`,
      provider: "line",
      channelId,
      raw: e as unknown as Record<string, unknown>,
    }))
    .filter((i) => Boolean(i.eventId));

  let accepted = 0;
  let duplicated = 0;
  try {
    const r = await enqueueEvents(items);
    accepted = r.accepted;
    duplicated = r.duplicated;
  } catch (e) {
    // Mongo ล่ม → ตอบ 5xx ให้ LINE retry เอง ดีกว่าตอบ 200 แล้วทำข้อมูลหาย
    log.error("enqueue ล้มเหลว", { requestId, error: (e as Error).message, count: items.length });
    return fail("UPSTREAM_ERROR", "บันทึก event ไม่สำเร็จ", requestId);
  }

  log.info("รับ LINE webhook", {
    requestId,
    total: items.length,
    accepted,
    duplicated,
    types: [...new Set(events.map((e) => e.type))],
    latencyMs: Date.now() - t0,
  });

  // ── 5. แจ้ง n8n ทีหลัง ─────────────────────────────────────────
  if (accepted > 0) {
    safeAfter(() => publish("LINE", { requestId, eventIds: items.map((i) => i.eventId) }), { requestId, topic: "LINE" });
  }

  return ok({ accepted, duplicated }, requestId);
}

/** LINE บางกรณียิง GET มาเช็ค endpoint */
export async function GET() {
  return new Response("ok", { status: 200 });
}
