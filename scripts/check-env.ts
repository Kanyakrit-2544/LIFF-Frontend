import { validateAllEnv } from "../packages/core/src/env";

const result = validateAllEnv();
if (result.ok) {
  console.log("✅ env ครบทุกกลุ่ม");
  process.exit(0);
}
console.error("❌ env ไม่ครบ:\n");
for (const e of result.errors) console.error(e + "\n");
process.exit(1);
