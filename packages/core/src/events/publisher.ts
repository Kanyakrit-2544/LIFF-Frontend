import crypto from "node:crypto";
import { env } from "../env";
import { log } from "../logger";

/**
 * แจ้ง n8n ว่ามีงานใหม่ (docs/07 §7.3)
 *
 * dev: N8N_PUSH_ENABLED=false → ข้ามการยิง เพราะ n8n อยู่ใน Docker บนเครื่อง Vercel เข้าไม่ถึง
 *      n8n จะมา poll เอง (pull mode)
 * prod: true → push เพื่อลด latency
 *
 * push เป็นแค่ตัวเร่ง ไม่ใช่เส้นทางเดียว — ล้มเหลวก็ไม่ทำให้ข้อมูลหาย เพราะ event อยู่ใน inbound_events แล้ว
 */

export type Topic = "LINE" | "FORM";

export function signInternal(rawBody: string, timestamp: number, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(`${rawBody}.${timestamp}`).digest("hex");
}

export function verifyInternal(rawBody: string, signature: string | null, timestamp: string | null, secret: string, windowSec = 300): boolean {
  if (!signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > windowSec) return false; // กัน replay

  const expected = Buffer.from(signInternal(rawBody, ts, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

export interface PublishResult {
  published: boolean;
  reason?: string;
  status?: number;
}

export async function publish(topic: Topic, payload: unknown): Promise<PublishResult> {
  const n8n = env("n8n");
  if (!n8n.N8N_PUSH_ENABLED) return { published: false, reason: "pull-mode" };

  const url = topic === "LINE" ? n8n.N8N_WEBHOOK_LINE : n8n.N8N_WEBHOOK_FORM;
  if (!url) return { published: false, reason: `ไม่ได้ตั้ง N8N_WEBHOOK_${topic}` };

  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": signInternal(body, ts, env("security").INTERNAL_HMAC_SECRET),
        "x-timestamp": String(ts),
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) log.warn("push ไป n8n ไม่สำเร็จ — reconciler จะเก็บให้เอง", { topic, status: res.status });
    return { published: res.ok, status: res.status };
  } catch (e) {
    log.warn("push ไป n8n ล้มเหลว — reconciler จะเก็บให้เอง", { topic, error: (e as Error).message });
    return { published: false, reason: (e as Error).message };
  }
}
