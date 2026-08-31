import { env } from "../env";
import { log } from "../logger";

/**
 * ส่งต่อ webhook ดิบของ LINE ให้ระบบ tag (docs/26 §D)
 *
 * ทำไมต้องมี: LINE ตั้ง webhook URL ได้ **channel ละ 1 อันเท่านั้น**
 * ลูกค้าจริงทักเข้า OA เดียว ซึ่ง webhook ชี้มาที่ระบบนี้อยู่
 * ระบบ tag ที่ต้องอ่านบทสนทนาจึงไม่มีทางเห็นข้อความเลยถ้าไม่มีใครส่งต่อให้
 *
 * ⚠️ D4 ยังคงอยู่ครบ — ระบบนี้ **ไม่เก็บ** ข้อความ ยังคง redact ก่อน insert เหมือนเดิม
 * ตรงนี้แค่ "ส่งต่อ byte ที่รับมา" แล้วปล่อยทิ้ง ไม่เขียนลง DB ไม่ log เนื้อความ
 *
 * ส่งต่อทั้ง raw body และ x-line-signature เดิม → ปลายทางตรวจลายเซ็นเองได้
 * ด้วย channel secret ตัวเดียวกัน จึงไม่ต้องมี secret ชุดใหม่ระหว่างสองระบบ
 *
 * เป็น best-effort: ปลายทางล่ม = ข้อความรอบนั้นหายจากฝั่ง tag
 * ยอมรับได้เพราะ tag ทำงานวิเคราะห์ ไม่ใช่ธุรกรรม — ส่วนข้อมูลลูกค้ายังเข้า
 * inbound_events ของระบบนี้ครบเสมอ ไม่ขึ้นกับปลายทางนี้เลย
 */

export interface ForwardResult {
  forwarded: boolean;
  status?: number;
  reason?: string;
}

export async function forwardChatToTagger(
  rawBody: string,
  signature: string | null,
  timeoutMs = 3_000
): Promise<ForwardResult> {
  const { TAGGER_FORWARD_URL } = env("tagger");
  if (!TAGGER_FORWARD_URL) return { forwarded: false, reason: "ไม่ได้ตั้งค่า" };
  if (!signature) return { forwarded: false, reason: "ไม่มีลายเซ็นให้ส่งต่อ" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(TAGGER_FORWARD_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-line-signature": signature },
      body: rawBody,
      signal: controller.signal,
    });
    if (!res.ok) {
      // ไม่ log body ที่ตอบกลับ กันข้อความลูกค้าย้อนกลับมาโผล่ใน log
      log.warn("ส่งต่อแชทให้ระบบ tag ไม่สำเร็จ", { status: res.status });
      return { forwarded: false, status: res.status, reason: `HTTP ${res.status}` };
    }
    return { forwarded: true, status: res.status };
  } catch (e) {
    const msg = (e as Error).message;
    log.warn("ส่งต่อแชทให้ระบบ tag ไม่สำเร็จ", { error: msg.includes("abort") ? "timeout" : msg });
    return { forwarded: false, reason: msg.includes("abort") ? "timeout" : msg };
  } finally {
    clearTimeout(timer);
  }
}
