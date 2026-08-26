import type { LineEvent } from "./lineTypes";

/**
 * D4: ระบบไม่เก็บบทสนทนา — บันทึกเฉพาะการแอดเพื่อนกับการทักครั้งแรก
 *
 * inbound_events.raw เก็บ payload ดิบไว้ retry ได้ ซึ่งแปลว่าข้อความลูกค้าจะค้างอยู่ 30 วันตาม TTL
 * ถ้าไม่ลบตรงนี้ = ยังเก็บบทสนทนาอยู่ดี แค่ซ่อนไว้อีกที่ (docs/02)
 *
 * จึงตัดเนื้อหาทิ้งตั้งแต่ก่อน insert เหลือแค่ metadata ที่จำเป็นต่อการประมวลผล
 */
export function redactLineEvent(event: LineEvent): LineEvent {
  if (event.type !== "message" || !event.message) return event;

  // เก็บเฉพาะ id (ใช้ dedupe) กับ type (ใช้ตัดสิน routing) — ที่เหลือทิ้งหมด
  const { id, type } = event.message;
  return { ...event, message: { id, type } };
}

export function redactLineEvents(events: LineEvent[]): LineEvent[] {
  return events.map(redactLineEvent);
}
