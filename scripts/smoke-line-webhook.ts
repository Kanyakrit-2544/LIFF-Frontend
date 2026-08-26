/**
 * ยิง LINE webhook ปลอมที่ signature ถูกต้อง เพื่อทดสอบ /api/webhook/line แบบ end-to-end
 *
 *   npx tsx scripts/smoke-line-webhook.ts [baseUrl]
 *
 * อ่าน LINE_CHANNEL_SECRET จาก env (หรือ apps/web/.env.local)
 */
import fs from "node:fs";
import path from "node:path";
import { signLineBody } from "../packages/core/src/security/lineSignature";

const BASE = process.argv[2] ?? "http://localhost:3000";

function loadSecret(): string {
  if (process.env.LINE_CHANNEL_SECRET) return process.env.LINE_CHANNEL_SECRET;
  const f = path.join(process.cwd(), "apps/web/.env.local");
  if (fs.existsSync(f)) {
    const m = fs.readFileSync(f, "utf8").match(/^LINE_CHANNEL_SECRET=(.*)$/m);
    if (m?.[1]) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("ไม่พบ LINE_CHANNEL_SECRET");
}

const SECRET = loadSecret();
const stamp = Date.now();

type Case = { name: string; body: unknown; signWith?: string; expectStatus: number; check?: (j: any) => boolean };

const followEvent = (id: string) => ({
  type: "follow",
  webhookEventId: id,
  deliveryContext: { isRedelivery: false },
  timestamp: stamp,
  source: { type: "user", userId: "Udeadbeef00000000000000000000000" },
  replyToken: "rt-" + id,
});

const messageEvent = (id: string) => ({
  type: "message",
  webhookEventId: id,
  deliveryContext: { isRedelivery: false },
  timestamp: stamp,
  source: { type: "user", userId: "Udeadbeef00000000000000000000000" },
  message: { id: "M-" + id, type: "text", text: "สวัสดีครับ ผมสนใจคอร์ส เบอร์ผม 0812345678" },
});

const cases: Case[] = [
  { name: "ไม่มี signature → 401", body: { events: [followEvent(`S-${stamp}-x`)] }, signWith: "", expectStatus: 401 },
  { name: "signature ผิด (secret คนละตัว) → 401", body: { events: [followEvent(`S-${stamp}-y`)] }, signWith: "wrong-secret", expectStatus: 401 },
  { name: "events ว่าง (ปุ่ม Verify ของ LINE) → 200", body: { destination: "U206d", events: [] }, expectStatus: 200, check: (j) => j.verify === true },
  { name: "follow event ใหม่ → accepted 1", body: { destination: "U206d", events: [followEvent(`S-${stamp}-1`)] }, expectStatus: 200, check: (j) => j.accepted === 1 && j.duplicated === 0 },
  { name: "ยิง event เดิมซ้ำ → duplicated 1, accepted 0", body: { destination: "U206d", events: [followEvent(`S-${stamp}-1`)] }, expectStatus: 200, check: (j) => j.accepted === 0 && j.duplicated === 1 },
  { name: "ชุดผสม (ซ้ำ 1 + ใหม่ 2) → accepted 2", body: { destination: "U206d", events: [followEvent(`S-${stamp}-1`), followEvent(`S-${stamp}-2`), followEvent(`S-${stamp}-3`)] }, expectStatus: 200, check: (j) => j.accepted === 2 && j.duplicated === 1 },
  { name: "message event → accepted 1 (ข้อความต้องไม่ถูกเก็บ)", body: { destination: "U206d", events: [messageEvent(`S-${stamp}-msg`)] }, expectStatus: 200, check: (j) => j.accepted === 1 },
  { name: "body ถูกแก้หลังเซ็น → 401", body: null, expectStatus: 401 },
];

async function run() {
  console.log(`🎯 ${BASE}/api/webhook/line\n`);
  let pass = 0;

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  console.log(`health: ${health?.ok ? "✅" : "❌"} db=${health?.db?.latencyMs}ms compressors=${health?.config?.compressors}\n`);

  for (const c of cases) {
    let raw: string;
    let sig: string;

    if (c.body === null) {
      // เซ็นก้อนหนึ่ง แล้วส่งอีกก้อน
      const original = JSON.stringify({ destination: "U206d", events: [followEvent(`S-${stamp}-t`)] });
      sig = signLineBody(original, SECRET);
      raw = original.replace("follow", "unfoll");
    } else {
      raw = JSON.stringify(c.body);
      sig = c.signWith === "" ? "" : signLineBody(raw, c.signWith ?? SECRET);
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (sig) headers["x-line-signature"] = sig;

    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/webhook/line`, { method: "POST", headers, body: raw });
    const ms = Date.now() - t0;
    const json = await res.json().catch(() => ({}));

    const statusOk = res.status === c.expectStatus;
    const checkOk = c.check ? c.check(json) : true;
    const good = statusOk && checkOk;
    if (good) pass++;

    console.log(
      `${good ? "✅" : "❌"} ${c.name.padEnd(48)} ${res.status} ${String(ms).padStart(4)}ms ` +
        (good ? "" : `\n     ได้: ${JSON.stringify(json)}`)
    );
  }

  console.log(`\n${pass}/${cases.length} ผ่าน`);
  process.exitCode = pass === cases.length ? 0 : 1;
}

run().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
