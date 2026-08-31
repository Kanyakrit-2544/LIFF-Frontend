import { afterAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import http from "node:http";
import { COLLECTIONS, closeClient, forwardChatToTagger, getDb, __resetEnvCache } from "@line-crm/core";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const d = runIntegration ? describe : describe.skip;

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? "test-line-channel-secret";
const PORT = 4488;

interface Captured { headers: Record<string, string | string[] | undefined>; body: string }
const captured: Captured[] = [];
let server: http.Server | null = null;
let mode: "ok" | "fail" | "hang" = "ok";

function startTagger(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        captured.push({ headers: req.headers, body });
        if (mode === "hang") return; // ไม่ตอบเลย ทดสอบ timeout
        if (mode === "fail") { res.writeHead(500); res.end("boom"); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(PORT, () => resolve());
  });
}

function lineBody(text: string, id: string): string {
  return JSON.stringify({
    destination: "U_DEST",
    events: [{
      type: "message", webhookEventId: id, timestamp: Date.now(),
      source: { type: "user", userId: "Uforward00000001" },
      message: { type: "text", id: "m1", text },
    }],
  });
}
const sign = (body: string) => crypto.createHmac("sha256", CHANNEL_SECRET).update(body).digest("base64");

d("forwardChatToTagger — ส่งต่อแชทให้ระบบ tag (docs/26 §D)", () => {
  beforeEach(async () => {
    captured.length = 0;
    mode = "ok";
    if (!server) await startTagger();
    process.env.TAGGER_FORWARD_URL = `http://127.0.0.1:${PORT}/line/webhook`;
    __resetEnvCache();
  });
  afterAll(() => {
    delete process.env.TAGGER_FORWARD_URL;
    __resetEnvCache();
    server?.close();
  });

  it("⭐ ส่ง byte เดิมและลายเซ็นเดิม — ปลายทางตรวจลายเซ็นเองได้ด้วย secret ตัวเดียวกัน", async () => {
    const body = lineBody("สนใจคอร์ส Inner ครับ ราคาเท่าไร", "ev-1");
    const sig = sign(body);
    const r = await forwardChatToTagger(body, sig);

    expect(r.forwarded).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.body).toBe(body);                        // byte ต่อ byte
    expect(captured[0]!.headers["x-line-signature"]).toBe(sig);  // ลายเซ็นเดิม
    expect(crypto.createHmac("sha256", CHANNEL_SECRET).update(captured[0]!.body).digest("base64")).toBe(sig);
  });

  it("⭐ ปลายทางตอบ 500 → ไม่ throw คืน forwarded:false", async () => {
    mode = "fail";
    const body = lineBody("ปลายทางพัง", "ev-2");
    const r = await forwardChatToTagger(body, sign(body));
    expect(r.forwarded).toBe(false);
    expect(r.status).toBe(500);
  });

  it("⭐ ปลายทางไม่ตอบ → timeout แล้วคืน forwarded:false ไม่ค้าง", async () => {
    mode = "hang";
    const body = lineBody("ปลายทางเงียบ", "ev-3");
    const r = await forwardChatToTagger(body, sign(body), 300);
    expect(r.forwarded).toBe(false);
    expect(r.reason).toBe("timeout");
  });

  it("ไม่ได้ตั้ง TAGGER_FORWARD_URL → ไม่ส่งต่อ ไม่ error", async () => {
    delete process.env.TAGGER_FORWARD_URL;
    __resetEnvCache();
    const body = lineBody("ไม่มีปลายทาง", "ev-4");
    const r = await forwardChatToTagger(body, sign(body));
    expect(r.forwarded).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it("ไม่มีลายเซ็นให้ส่งต่อ → ไม่ยิงออกไป (ปลายทางตรวจไม่ได้อยู่ดี)", async () => {
    const r = await forwardChatToTagger(lineBody("x", "ev-5"), null);
    expect(r.forwarded).toBe(false);
    expect(captured).toHaveLength(0);
  });
});

d("D4 ยังอยู่ครบหลังต่อท่อ forward", () => {
  beforeEach(async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.inboundEvents).deleteMany({ provider: "line" });
  });
  afterAll(async () => { await closeClient(); });

  it("⭐ ข้อความลูกค้าไม่ถูกเก็บลง inbound_events แม้จะส่งต่อไปแล้ว", async () => {
    const { POST } = await import("../app/api/webhook/line/route");
    const body = lineBody("ข้อความลับของลูกค้า", "ev-d4");
    const res = await POST(new Request("https://x.test/api/webhook/line", {
      method: "POST", body,
      headers: { "content-type": "application/json", "x-line-signature": sign(body) },
    }));
    expect(res.status).toBe(200);
    const db = await getDb();
    const doc = await db.collection(COLLECTIONS.inboundEvents).findOne({ eventId: "ev-d4" });
    expect(doc).not.toBeNull();
    expect(JSON.stringify(doc!.raw)).not.toContain("ข้อความลับ");
  });

  it("ลายเซ็นผิด → 401 และไม่บันทึกอะไรเลย", async () => {
    const { POST } = await import("../app/api/webhook/line/route");
    const body = lineBody("ไม่ควรถูกบันทึก", "ev-401");
    const res = await POST(new Request("https://x.test/api/webhook/line", {
      method: "POST", body,
      headers: { "content-type": "application/json", "x-line-signature": "bm90LWEtdmFsaWQtc2ln" },
    }));
    expect(res.status).toBe(401);
    const db = await getDb();
    expect(await db.collection(COLLECTIONS.inboundEvents).countDocuments({ eventId: "ev-401" })).toBe(0);
  });
});
