// ค่า test เท่านั้น — ไม่ใช่ secret จริง
process.env.AI_HASH_PEPPER = "test-ai-hash-pepper-must-be-at-least-32-chars";
process.env.INTERNAL_HMAC_SECRET = "test-internal-hmac-secret-at-least-32-chars";
process.env.SESSION_JWT_SECRET = "test-session-jwt-secret-at-least-32-chars!";
process.env.ALLOWED_LIFF_ORIGINS = "http://localhost:3000";
process.env.MONGODB_URI ??= "mongodb://localhost:27018/?directConnection=true"; // npm run db:test:up
process.env.MONGODB_DB ??= "line_crm_test";
