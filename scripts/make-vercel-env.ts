/**
 * สร้างไฟล์ env สำหรับวางลง Vercel dashboard ในครั้งเดียว
 *
 *   npm run env:vercel -- --domain line-crm.vercel.app
 *   npm run env:vercel -- --domain line-crm.vercel.app --keep-secrets   (ใช้ secret ชุดเดียวกับ dev)
 *
 * ไฟล์ผลลัพธ์อยู่ที่ vercel.env.txt (gitignored) — เปิดแล้วคัดลอกทั้งไฟล์
 * ไปวางในช่อง Key ของหน้า Environment Variables ของ Vercel (รองรับการวางทั้งก้อน)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SRC = path.join(process.cwd(), "apps/web/.env.local");
const OUT = path.join(process.cwd(), "vercel.env.txt");

const args = process.argv.slice(2);
const domainArg = args.find((a) => a.startsWith("--domain="))?.split("=")[1] ?? args[args.indexOf("--domain") + 1];
const keepSecrets = args.includes("--keep-secrets");

if (!domainArg || domainArg.startsWith("--")) {
  console.error("ต้องระบุ domain:  npm run env:vercel -- --domain your-project.vercel.app");
  process.exit(1);
}
const domain = domainArg.replace(/^https?:\/\//, "").replace(/\/$/, "");

if (!fs.existsSync(SRC)) {
  console.error(`ไม่พบ ${SRC}`);
  process.exit(1);
}
const dev = Object.fromEntries(
  fs.readFileSync(SRC, "utf8").split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
) as Record<string, string>;

/** ค่าที่ควรเป็นคนละชุดกับ dev — dev secret รั่วแล้ว production ต้องไม่พังตาม */
const FRESH = {
  PII_KEY: () => crypto.randomBytes(32).toString("base64"),
  PII_PEPPER: () => crypto.randomBytes(48).toString("base64"),
  SESSION_JWT_SECRET: () => crypto.randomBytes(48).toString("base64"),
  INTERNAL_HMAC_SECRET: () => crypto.randomBytes(48).toString("base64"),
} as const;

const COPY = [
  "MONGODB_URI", "MONGODB_DB", "MONGODB_COMPRESSORS", "MONGODB_BLOCK_COMPRESSOR",
  "LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_ID",
  "LINE_LOGIN_CHANNEL_ID", "NEXT_PUBLIC_LIFF_ID",
];
const DEFAULTS: Record<string, string> = {
  LINE_LOGIN_SCOPES: "openid profile email",
  N8N_PUSH_ENABLED: "false",
  SHEETS_PII_MODE: "full",
  MONGODB_DB: "line_crm",
  MONGODB_COMPRESSORS: "zstd,zlib",
  MONGODB_BLOCK_COMPRESSOR: "zstd",
};

const out: Record<string, string> = {};
const missing: string[] = [];

for (const k of COPY) {
  const v = dev[k] ?? DEFAULTS[k];
  if (!v) { missing.push(k); continue; }
  out[k] = v;
}
for (const k of ["LINE_LOGIN_SCOPES", "N8N_PUSH_ENABLED", "SHEETS_PII_MODE"]) out[k] = dev[k] || DEFAULTS[k]!;
for (const [k, gen] of Object.entries(FRESH)) out[k] = keepSecrets ? (dev[k] ?? gen()) : gen();
out.ALLOWED_LIFF_ORIGINS = `https://${domain}`;
// n8n คุยกับ Sheets เอง Vercel ไม่ต้องมี — ใส่ไว้เผื่ออนาคตย้ายมาฝั่ง API
for (const k of ["GOOGLE_SHEET_ID"]) if (dev[k]) out[k] = dev[k];

const body = Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
fs.writeFileSync(OUT, body, { mode: 0o600 });

console.log(`✅ เขียน ${OUT} แล้ว (${Object.keys(out).length} ตัวแปร)\n`);
console.log("คัดลอกมาจาก .env.local:");
for (const k of COPY) if (out[k]) console.log(`   ${k}`);
console.log(`\n${keepSecrets ? "ใช้ชุดเดิมจาก dev" : "⭐ สร้างใหม่สำหรับ production"}:`);
for (const k of Object.keys(FRESH)) console.log(`   ${k}`);
console.log("\nตั้งจาก --domain:");
console.log(`   ALLOWED_LIFF_ORIGINS = https://${domain}`);

if (missing.length) {
  console.log("\n❌ ยังขาด (ต้องเติมเองในไฟล์):");
  for (const k of missing) console.log(`   ${k}`);
}

if (!keepSecrets) {
  console.log("\n⚠️  PII_PEPPER ชุดใหม่นี้ห้ามเปลี่ยนอีกหลังมีข้อมูลจริง — เก็บสำรองไว้ที่ปลอดภัย");
  console.log("⚠️  INTERNAL_HMAC_SECRET ต้องเอาไปใส่ใน .env ของ n8n ให้ตรงกันด้วย");
}
console.log("\n📋 วิธีใช้: เปิดไฟล์ คัดลอกทั้งหมด → Vercel → Settings → Environment Variables");
console.log("   คลิกช่อง Key แล้ววางทั้งก้อน Vercel จะแตกเป็นรายตัวให้เอง → ติ๊ก Production/Preview/Development → Save");
