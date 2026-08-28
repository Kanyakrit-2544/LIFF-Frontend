import { z } from "zod";

/**
 * Env validation แยกเป็นกลุ่มโดยตั้งใจ:
 * script ที่ต้องการแค่ Mongo (เช่น create-indexes) ไม่ควรพังเพราะยังไม่ได้ตั้งค่า LINE
 * แต่ละกลุ่ม validate ครั้งแรกที่เรียกแล้ว cache ไว้ — ขาดค่าไหน = throw ทันที ไม่ปล่อยให้ไปพังตอนมีผู้ใช้จริง
 */

const dbSchema = z.object({
  MONGODB_URI: z.string().min(1).startsWith("mongodb"),
  MONGODB_DB: z.string().min(1).default("line_crm"),
  /** network compression ระหว่าง app ↔ Atlas — ดู docs/10 */
  MONGODB_COMPRESSORS: z.string().default("zstd,zlib"),
  /** WiredTiger block compressor ตอนสร้าง collection */
  MONGODB_BLOCK_COMPRESSOR: z.enum(["zstd", "snappy", "zlib", "none"]).default("zstd"),
});

const aiSchema = z.object({
  /**
   * ใช้ hash เฉพาะใน line_crm_ai เท่านั้น
   * ต้องแยกจาก pepper เก่าของ DB หลัก เพื่อไม่ให้ join ข้ามฐานได้ง่าย
   */
  AI_HASH_PEPPER: z.string().min(32, "AI_HASH_PEPPER ต้องยาวอย่างน้อย 32 ตัวอักษร"),
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

const optionalText = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());

const partnerSchema = z.object({
  /** JSON object: { "partner-id": "partner-specific-hmac-secret" } */
  PARTNER_HMAC_SECRETS_JSON: optionalText,
  /** LINE Messaging channel used when a partner supplies a previously unseen lineUserId. */
  PARTNER_LINE_CHANNEL_ID: optionalText,
});

const llmSchema = z.object({
  LLM_BASE_URL: optionalText.pipe(z.string().url().optional()),
  LLM_API_KEY: optionalText,
  LLM_MODEL: optionalText,
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  LLM_ALLOW_NAME_PAIRS: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
});

const groups = {
  db: dbSchema,
  ai: aiSchema,
  line: lineSchema,
  security: securitySchema,
  n8n: n8nSchema,
  llm: llmSchema,
  partner: partnerSchema,
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
