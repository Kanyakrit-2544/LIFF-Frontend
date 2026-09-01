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
const N8N_ENV = path.join(process.cwd(), ".env");

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
  AI_HASH_PEPPER: () => crypto.randomBytes(48).toString("base64"),
  SESSION_JWT_SECRET: () => crypto.randomBytes(48).toString("base64"),
  INTERNAL_HMAC_SECRET: () => crypto.randomBytes(48).toString("base64"),
  AUTH_SECRET: () => crypto.randomBytes(48).toString("base64"),
} as const;

function writeEnvValues(file: string, values: Record<string, string>): void {
  let source = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    source = pattern.test(source)
      ? source.replace(pattern, line)
      : `${source}${source && !source.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  fs.writeFileSync(file, source, { mode: 0o600 });
}

const COPY = [
  "MONGODB_URI", "MONGODB_DB", "MONGODB_COMPRESSORS", "MONGODB_BLOCK_COMPRESSOR",
  "LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_ID",
  "LINE_LOGIN_CHANNEL_ID", "NEXT_PUBLIC_LIFF_ID",
  "ADMIN_MONGODB_URI", "MONGODB_MIRROR_URI", "AI_MONGODB_DB", "LEGACY_MONGODB_DB",
  "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET", "STAFF_EMAIL_ALLOWLIST",
  "PARTNER_HMAC_SECRETS_JSON", "TAGGER_FORWARD_URL",
];
const OPTIONAL_COPY = [
  "FACEBOOK_PAGE_TOKEN", "FACEBOOK_APP_SECRET", "FACEBOOK_VERIFY_TOKEN", "FACEBOOK_PAGE_ID",
];
const DEFAULTS: Record<string, string> = {
  LINE_LOGIN_SCOPES: "openid profile email",
  N8N_PUSH_ENABLED: "false",
  MONGODB_DB: "line_crm",
  MONGODB_COMPRESSORS: "zstd,zlib",
  MONGODB_BLOCK_COMPRESSOR: "zstd",
  AI_MONGODB_DB: "line_crm_ai",
  LEGACY_MONGODB_DB: "line_crm_legacy",
  FACEBOOK_GRAPH_VERSION: "v21.0",
};

const out: Record<string, string> = {};
const missing: string[] = [];

for (const k of COPY) {
  const v = dev[k] ?? DEFAULTS[k];
  if (!v) { missing.push(k); continue; }
  out[k] = v;
}
for (const k of OPTIONAL_COPY) if (dev[k]) out[k] = dev[k];
for (const k of ["LINE_LOGIN_SCOPES", "N8N_PUSH_ENABLED", "FACEBOOK_GRAPH_VERSION"]) out[k] = dev[k] || DEFAULTS[k]!;
for (const [k, gen] of Object.entries(FRESH)) {
  if (!keepSecrets) {
    out[k] = gen();
  } else if (dev[k]) {
    out[k] = dev[k];
  } else {
    missing.push(k);
  }
}
out.ALLOWED_LIFF_ORIGINS = `https://${domain}`;
// n8n คุยกับ Sheets เอง Vercel ไม่ต้องมี — ใส่ไว้เผื่ออนาคตย้ายมาฝั่ง API
for (const k of ["GOOGLE_SHEET_ID"]) if (dev[k]) out[k] = dev[k];

const body = Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
fs.writeFileSync(OUT, body, { mode: 0o600 });

if (!keepSecrets) {
  const freshValues = Object.fromEntries(Object.keys(FRESH).map((key) => [key, out[key]!])) as Record<string, string>;
  writeEnvValues(SRC, freshValues);
  if (fs.existsSync(N8N_ENV)) writeEnvValues(N8N_ENV, { INTERNAL_HMAC_SECRET: out.INTERNAL_HMAC_SECRET! });
}

console.log(`✅ เขียน ${OUT} แล้ว (${Object.keys(out).length} ตัวแปร)\n`);
console.log("คัดลอกมาจาก .env.local:");
for (const k of [...COPY, ...OPTIONAL_COPY]) if (out[k]) console.log(`   ${k}`);
console.log(`\n${keepSecrets ? "ใช้ชุดเดิมจาก dev" : "⭐ สร้างใหม่สำหรับ production"}:`);
for (const k of Object.keys(FRESH)) if (out[k]) console.log(`   ${k}`);
console.log("\nตั้งจาก --domain:");
console.log(`   ALLOWED_LIFF_ORIGINS = https://${domain}`);

if (missing.length) {
  console.log("\n❌ ยังขาด (ต้องเติมเองในไฟล์):");
  for (const k of missing) console.log(`   ${k}`);
}

if (!keepSecrets) {
  console.log(`\n✅ เขียน secret ชุดใหม่กลับ ${SRC} แล้ว — เครื่อง dev จะไม่ถือค่าเก่า`);
  if (fs.existsSync(N8N_ENV)) {
    console.log(`✅ อัปเดต INTERNAL_HMAC_SECRET ใน ${N8N_ENV} แล้ว — restart n8n ก่อนทดสอบ`);
  } else {
    console.log(`⚠️  ไม่พบ ${N8N_ENV} — ต้องใส่ INTERNAL_HMAC_SECRET ชุดใหม่นี้ใน env ของ n8n`);
  }
  console.log("\n⚠️  AI_HASH_PEPPER ชุดใหม่นี้มีผลกับ hash ใน line_crm_ai — เก็บสำรองไว้ที่ปลอดภัย");
  console.log("⚠️  หลังอัปเดต Vercel ต้องรัน AI mirror/scrub ใหม่ เพราะ hash ชุดเดิมใช้ pepper เก่า");
}
console.log("\n📋 วิธีใช้: เปิดไฟล์ คัดลอกทั้งหมด → Vercel → Settings → Environment Variables");
console.log("   คลิกช่อง Key แล้ววางทั้งก้อน Vercel จะแตกเป็นรายตัวให้เอง → ติ๊ก Production/Preview/Development → Save");
