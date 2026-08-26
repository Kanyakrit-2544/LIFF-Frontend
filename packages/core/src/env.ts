import { z } from "zod";

/**
 * Env validation แยกเป็นกลุ่มโดยตั้งใจ:
 * script ที่ต้องการแค่ Mongo (เช่น create-indexes) ไม่ควรพังเพราะยังไม่ได้ตั้งค่า LINE
 * แต่ละกลุ่ม validate ครั้งแรกที่เรียกแล้ว cache ไว้ — ขาดค่าไหน = throw ทันที ไม่ปล่อยให้ไปพังตอนมีผู้ใช้จริง
 */

const b64 = (bytes: number, label: string) =>
  z.string().refine(
    (v) => {
      try {
        return Buffer.from(v, "base64").length === bytes;
      } catch {
        return false;
      }
    },
    { message: `${label} ต้องเป็น base64 ขนาด ${bytes} ไบต์ (สร้างด้วย: openssl rand -base64 ${bytes})` }
  );

const dbSchema = z.object({
  MONGODB_URI: z.string().min(1).startsWith("mongodb"),
  MONGODB_DB: z.string().min(1).default("line_crm"),
  /** network compression ระหว่าง app ↔ Atlas — ดู docs/10 */
  MONGODB_COMPRESSORS: z.string().default("zstd,zlib"),
  /** WiredTiger block compressor ตอนสร้าง collection */
  MONGODB_BLOCK_COMPRESSOR: z.enum(["zstd", "snappy", "zlib", "none"]).default("zstd"),
});

const piiSchema = z.object({
  PII_KEY: b64(32, "PII_KEY"),
  /** ⚠️ ห้ามเปลี่ยนหลัง production — hash เดิมทั้งฐานจะใช้ไม่ได้ */
  PII_PEPPER: z.string().min(32, "PII_PEPPER ต้องยาวอย่างน้อย 32 ตัวอักษร"),
});

const lineSchema = z.object({
  LINE_CHANNEL_SECRET: z.string().min(1),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1),
  LINE_CHANNEL_ID: z.string().min(1),
  /** LINE Login channel — คนละอันกับ Messaging API channel */
  LINE_LOGIN_CHANNEL_ID: z.string().min(1),
  /** ยื่นขอ Email permission แล้ว (D18) → ขอ scope email ตอน login */
  LINE_LOGIN_SCOPES: z.string().default("openid profile email"),
});

const securitySchema = z.object({
  SESSION_JWT_SECRET: z.string().min(32),
  INTERNAL_HMAC_SECRET: z.string().min(32),
  ALLOWED_LIFF_ORIGINS: z.string().min(1),
});

const n8nSchema = z.object({
  /** dev = false (pull mode) / prod = true — ดู docs/07 */
  N8N_PUSH_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  N8N_WEBHOOK_LINE: z.string().url().optional(),
  N8N_WEBHOOK_FORM: z.string().url().optional(),
});

const sheetsSchema = z.object({
  /** D15: full — ทีมขายต้องใช้เบอร์จริง */
  SHEETS_PII_MODE: z.enum(["full", "masked"]).default("full"),
});

const groups = {
  db: dbSchema,
  pii: piiSchema,
  line: lineSchema,
  security: securitySchema,
  n8n: n8nSchema,
  sheets: sheetsSchema,
} as const;

type Groups = typeof groups;
type Parsed<K extends keyof Groups> = z.infer<Groups[K]>;

const cache = new Map<keyof Groups, unknown>();

export function env<K extends keyof Groups>(group: K): Parsed<K> {
  const hit = cache.get(group);
  if (hit) return hit as Parsed<K>;

  const result = groups[group].safeParse(process.env);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`ตั้งค่า env กลุ่ม "${group}" ไม่ครบ/ไม่ถูกต้อง:\n${detail}`);
  }
  cache.set(group, result.data);
  return result.data as Parsed<K>;
}

/** ใช้ตอน boot / CI — ตรวจทุกกลุ่มพร้อมกันเพื่อให้เห็นปัญหาครบในรอบเดียว */
export function validateAllEnv(): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const key of Object.keys(groups) as (keyof Groups)[]) {
    try {
      env(key);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** สำหรับ test เท่านั้น */
export function __resetEnvCache() {
  cache.clear();
}
