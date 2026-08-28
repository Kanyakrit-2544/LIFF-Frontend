/**
 * ถามคำถามธุรกิจกับข้อมูลใน line_crm_ai
 *
 *   npm run insights:ask -- --ai-uri "<uri>" --ai-db line_crm_ai --question "เดือนสิงหาคมขายได้เท่าไร"
 *   npm run insights:ask -- --query '{"metric":"seats","from":"2026-08-01","to":"2026-08-31","groupBy":"course"}'
 *   npm run insights:ask -- --query '...' --no-save
 *
 * --query = โหมดไม่ใช้ LLM ทำงานได้เต็มที่โดยไม่ต้องมี Hermes (D30)
 * --question = ให้ LLM แปลงคำถามให้ ต้องตั้ง LLM_BASE_URL / LLM_MODEL
 *
 * ⚠️ อ่านอย่างเดียว ไม่เขียนอะไรกลับเข้า line_crm_dev
 */
import { MongoClient } from "mongodb";
import {
  analyticsQuerySchema,
  createLlmProvider,
  ensureInsightIndexes,
  parseQuestion,
  renderAnswer,
  runAnalytics,
  saveInsight,
  PROMPT_VERSION,
  type AnalyticsQuery,
} from "../packages/core/src/index";

function arg(name: string, fallback?: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")) return process.argv[i + 1];
  return fallback;
}

const fmt = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 2 });

async function main() {
  const uri = arg("ai-uri", process.env.MONGODB_MIRROR_URI ?? process.env.MONGODB_URI);
  if (!uri) throw new Error("ไม่พบ URI — ใส่ --ai-uri หรือตั้ง MONGODB_MIRROR_URI");
  const dbName = arg("ai-db", process.env.AI_MONGODB_DB ?? "line_crm_ai")!;
  const question = arg("question");
  const rawQuery = arg("query");
  const noSave = process.argv.includes("--no-save");
  if (!question && !rawQuery) throw new Error("ต้องใส่ --question หรือ --query อย่างใดอย่างหนึ่ง");

  const client = new MongoClient(uri, { appName: "line-crm-insights", serverSelectionTimeoutMS: 8_000 });
  await client.connect();
  const db = client.db(dbName);
  const startedAt = Date.now();

  try {
    let query: AnalyticsQuery;
    const provider = question ? createLlmProvider() : null;

    if (rawQuery) {
      query = analyticsQuerySchema.parse(JSON.parse(rawQuery));
    } else {
      if (!provider) {
        console.error("❌ ยังไม่ได้ตั้ง LLM_BASE_URL / LLM_MODEL — ใช้ --query ส่งพารามิเตอร์ตรง ๆ แทนได้");
        process.exitCode = 1;
        return;
      }
      const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
      const parsed = await parseQuestion(provider, question!, today);
      if (!parsed.ok) {
        console.log(`❓ ${parsed.clarify}`);
        return;
      }
      query = parsed.query;
      console.log(`🔎 ตีความเป็น: ${JSON.stringify(query)}\n`);
    }

    const result = await runAnalytics(db, query);

    console.log(`📊 ${result.metric} · ${result.meta.from} ถึง ${result.meta.to} (${result.meta.timezone})`);
    for (const r of result.rows) {
      const share = r.share !== undefined ? ` (${fmt(r.share * 100)}%)` : "";
      const delta = r.delta !== undefined ? ` · เทียบช่วงก่อน ${r.delta >= 0 ? "+" : ""}${fmt(r.delta)}` : "";
      console.log(`   ${r.label.padEnd(24)} ${fmt(r.value).padStart(12)}${share}${delta}`);
    }
    console.log(`   ${"รวม".padEnd(24)} ${fmt(result.total).padStart(12)}`);
    console.log(`   (สแกน ${result.meta.rowsScanned} แถว · แหล่ง: ${result.meta.sourcesUsed.join(", ")})`);
    for (const w of result.meta.warnings) console.log(`   ⚠️  ${w}`);

    let answer: string | null = null;
    let verified = false;
    let invented: string[] = [];
    if (provider) {
      const rendered = await renderAnswer(provider, query, result);
      invented = rendered.invented;
      verified = rendered.verified;
      if (rendered.answer && rendered.verified) {
        answer = rendered.answer;
        console.log(`\n💬 ${answer}`);
      } else if (rendered.answer) {
        // ตัวกันโกหกจับได้ — ไม่แสดงข้อความนั้น ให้ดูตารางข้างบนแทน
        console.log(`\n🚫 ไม่แสดงคำสรุปของ AI เพราะมีตัวเลขที่ไม่มีอยู่จริงในข้อมูล: ${invented.join(", ")}`);
        console.log("   ใช้ตัวเลขในตารางข้างบนแทน");
      }
    }

    if (!noSave) {
      await ensureInsightIndexes(db);
      const id = await saveInsight(db, {
        question: question ?? null,
        params: query,
        result,
        answer,
        answerVerified: verified,
        invented,
        model: provider?.name ?? null,
        promptVersion: PROMPT_VERSION,
        runAt: new Date(),
        elapsedMs: Date.now() - startedAt,
      });
      console.log(`\n💾 บันทึกไว้ที่ insights: ${id}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error("❌", (e as Error).message);
  process.exit(1);
});
