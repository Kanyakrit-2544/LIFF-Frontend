import { describe, it, expect, beforeEach } from "vitest";
import { env, __resetEnvCache } from "../src/env";

beforeEach(() => __resetEnvCache());

describe("env", () => {
  it("อ่านกลุ่ม db พร้อมค่า default", () => {
    const e = env("db");
    expect(e.MONGODB_DB).toBe(process.env.MONGODB_DB ?? "line_crm");
    expect(e.MONGODB_COMPRESSORS).toBe("zstd,zlib");
    expect(e.MONGODB_BLOCK_COMPRESSOR).toBe("zstd");
  });

  it("AI_HASH_PEPPER สั้นเกินไปต้อง throw", () => {
    const saved = process.env.AI_HASH_PEPPER;
    process.env.AI_HASH_PEPPER = "too-short";
    __resetEnvCache();
    expect(() => env("ai")).toThrow(/AI_HASH_PEPPER/);
    if (saved === undefined) delete process.env.AI_HASH_PEPPER;
    else process.env.AI_HASH_PEPPER = saved;
  });

  it("ขาดค่าที่จำเป็นต้อง throw ทันที ไม่ปล่อยผ่าน", () => {
    const saved = {
      LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET,
      LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      LINE_CHANNEL_ID: process.env.LINE_CHANNEL_ID,
      LINE_LOGIN_CHANNEL_ID: process.env.LINE_LOGIN_CHANNEL_ID,
    };
    delete process.env.LINE_CHANNEL_SECRET;
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_CHANNEL_ID;
    delete process.env.LINE_LOGIN_CHANNEL_ID;
    __resetEnvCache();
    expect(() => env("line")).toThrow(/LINE_CHANNEL_SECRET/);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("N8N_PUSH_ENABLED default = false (dev pull mode)", () => {
    const saved = process.env.N8N_PUSH_ENABLED;
    delete process.env.N8N_PUSH_ENABLED;
    __resetEnvCache();
    expect(env("n8n").N8N_PUSH_ENABLED).toBe(false);
    if (saved === undefined) delete process.env.N8N_PUSH_ENABLED;
    else process.env.N8N_PUSH_ENABLED = saved;
  });
});
