import { env } from "../env";
import type { GraphLead } from "./types";

/**
 * ดึงรายละเอียด lead จาก Graph API
 *
 * Meta ส่งมาแต่ leadgen_id ทาง webhook (D31) ข้อมูลลูกค้าต้องมาขอเอง
 * ใช้ fetch ของ Node ตรง ๆ ไม่เพิ่ม SDK — เรียก endpoint เดียว ไม่คุ้มที่จะลากทั้งก้อนเข้ามา
 */

export interface FetchLeadResult {
  ok: boolean;
  lead?: GraphLead;
  /** true = ลองใหม่แล้วมีโอกาสสำเร็จ (เน็ตล่ม/rate limit) · false = ผิดถาวร (token หมดอายุ/ไม่มีสิทธิ์) */
  retryable?: boolean;
  error?: string;
}

export function facebookConfigured(): { webhook: boolean; graph: boolean } {
  const c = env("facebook");
  return {
    webhook: Boolean(c.FACEBOOK_APP_SECRET && c.FACEBOOK_VERIFY_TOKEN),
    graph: Boolean(c.FACEBOOK_PAGE_TOKEN),
  };
}

export async function fetchLead(leadgenId: string, timeoutMs = 10_000): Promise<FetchLeadResult> {
  const c = env("facebook");
  if (!c.FACEBOOK_PAGE_TOKEN) return { ok: false, retryable: true, error: "ยังไม่ได้ตั้ง FACEBOOK_PAGE_TOKEN" };

  const url = new URL(`https://graph.facebook.com/${c.FACEBOOK_GRAPH_VERSION}/${encodeURIComponent(leadgenId)}`);
  url.searchParams.set("fields", "id,created_time,ad_id,form_id,field_data");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      // token อยู่ใน header ไม่ใช่ query string — กันหลุดเข้า log ของ proxy ระหว่างทาง
      headers: { authorization: `Bearer ${c.FACEBOOK_PAGE_TOKEN}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      // 400/403 = token หมดอายุหรือไม่มีสิทธิ์ ลองใหม่ก็ไม่หาย ต้องมีคนไปต่อ token ใหม่
      const retryable = res.status === 429 || res.status >= 500;
      return { ok: false, retryable, error: `Graph API ${res.status}: ${body}` };
    }
    return { ok: true, lead: (await res.json()) as GraphLead };
  } catch (e) {
    const msg = (e as Error).message;
    return { ok: false, retryable: true, error: msg.includes("abort") ? "หมดเวลารอ Graph API" : msg };
  } finally {
    clearTimeout(timer);
  }
}
