/**
 * ยิง webhook ปลอมที่เซ็นลายเซ็นถูกต้อง — แบบเดียวกับ smoke:line
 *   npm run smoke:facebook -- --url http://localhost:3000
 */
import crypto from "node:crypto";

function arg(name: string, fallback: string): string {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main() {
  const base = arg("url", "http://localhost:3000");
  const secret = process.env.FACEBOOK_APP_SECRET;
  if (!secret) throw new Error("ต้องตั้ง FACEBOOK_APP_SECRET ก่อน");
  const pageId = process.env.FACEBOOK_PAGE_ID ?? "PAGE_SMOKE";
  const leadgenId = `smoke-${Date.now()}`;
  const body = JSON.stringify({
    object: "page",
    entry: [{ id: pageId, time: Math.floor(Date.now() / 1000), changes: [{ field: "leadgen", value: {
      leadgen_id: leadgenId, page_id: pageId, form_id: "F_SMOKE", ad_id: "AD_SMOKE",
      created_time: Math.floor(Date.now() / 1000),
    } }] }],
  });
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const url = `${base}/api/webhook/facebook`;

  const good = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", "x-hub-signature-256": sig } });
  console.log(`ลายเซ็นถูก  → HTTP ${good.status} ${(await good.text()).slice(0, 120)}`);

  const bad = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", "x-hub-signature-256": sig.slice(0, -1) + "0" } });
  console.log(`ลายเซ็นผิด  → HTTP ${bad.status} (ต้องเป็น 401)`);

  const verify = await fetch(`${url}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(process.env.FACEBOOK_VERIFY_TOKEN ?? "")}&hub.challenge=smoke123`);
  console.log(`GET challenge → HTTP ${verify.status} "${(await verify.text()).slice(0, 40)}" (ต้องเป็น smoke123)`);

  if (good.status !== 200 || bad.status !== 401) process.exit(1);
  console.log("\n✅ smoke:facebook ผ่าน");
}
main().catch((e) => { console.error("❌", (e as Error).message); process.exit(1); });
