import { MongoClient } from "mongodb";
import {
  buildCustomerLinks,
  createLlmProvider,
  ensureAiIndexes,
  env,
  plantMatchFixtures,
  unplantMatchFixtures,
  verifyAiIndexes,
  verifyCustomerLinks,
} from "../packages/core/src/index";

function arg(name: string, fallback?: string): string | undefined {
  const equals = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1]!.startsWith("--")) return process.argv[index + 1];
  return fallback;
}

function requiredArg(name: string, envName: string): string {
  const value = arg(name, process.env[envName]);
  if (!value) throw new Error(`ไม่พบ ${name} — ใส่ --${name} หรือ ${envName}`);
  return value;
}

function testDbOnly(dbName: string, action: string): void {
  if (!/test/i.test(dbName)) throw new Error(`${action} ทำได้เฉพาะฐาน test เท่านั้น (ชื่อฐานต้องมีคำว่า test)`);
}

function printBuild(report: Awaited<ReturnType<typeof buildCustomerLinks>>): void {
  console.log(`customers ${report.customers.toLocaleString()} · legacy persons ${report.legacyPersons.toLocaleString()}`);
  console.log(`ชั้น 1 phoneHash : auto ${report.phoneAuto} · needs_review ${report.phoneReview} (มีคู่แข่ง)`);
  console.log(`ชั้น 2 emailHash : auto ${report.emailAuto} · needs_review ${report.emailReview}`);
  console.log(`กฎ name feature  : needs_review ${report.featureRuleReview}`);
  console.log(`ชั้น 3 LLM       : ถาม ${report.llmAsked} คู่ · same ${report.llmSame} · different ${report.llmDifferent} · unsure ${report.llmUnsure} · ข้าม ${report.llmSkipped}`);
  console.log(`รวม link ใหม่ ${report.inserted} · อัปเดต ${report.updated} · ถอด link เครื่องเก่า ${report.removed} · ไม่แตะของที่คนตัดสินแล้ว ${report.preservedStaff}`);
  console.log(`เวลา ${(report.elapsedMs / 1_000).toFixed(2)} วิ`);
}

async function main(): Promise<void> {
  const aiUri = requiredArg("ai-uri", "MONGODB_MIRROR_URI");
  const aiDbName = arg("ai-db", process.env.AI_MONGODB_DB ?? "line_crm_ai")!;
  const plantValue = arg("plant");
  const unplant = process.argv.includes("--unplant");
  const verify = process.argv.includes("--verify");
  const dryRun = process.argv.includes("--dry-run");
  const noLlm = process.argv.includes("--no-llm");
  const sendNamePairs = process.argv.includes("--send-name-pairs");
  const modes = [plantValue !== undefined, unplant, verify].filter(Boolean).length;
  if (modes > 1) throw new Error("ใช้ --plant, --unplant หรือ --verify ได้ครั้งละโหมด");
  if (sendNamePairs && !env("llm").LLM_ALLOW_NAME_PAIRS) {
    throw new Error("--send-name-pairs ถูกปิดตาม D28; ต้องมี LLM_ALLOW_NAME_PAIRS=true ที่ยืนยัน decision ใหม่ก่อน");
  }

  const client = new MongoClient(aiUri, { appName: "line-crm-match-build", serverSelectionTimeoutMS: 8_000 });
  try {
    await client.connect();
    const db = client.db(aiDbName);
    if (plantValue !== undefined) {
      testDbOnly(aiDbName, "--plant");
      const total = Number(plantValue);
      await ensureAiIndexes(db);
      const report = await plantMatchFixtures(db, total);
      console.log(`ปลูก fixture ${report.total}: phone ${report.phone} · family ${report.family} · email ${report.email} · name ${report.name} · no-match ${report.noMatch}`);
      return;
    }
    if (unplant) {
      testDbOnly(aiDbName, "--unplant");
      const report = await unplantMatchFixtures(db);
      console.log(`ลบ fixture: customers ${report.customers} · links ${report.links}`);
      return;
    }
    if (verify) {
      const [links, indexes] = await Promise.all([verifyCustomerLinks(db), verifyAiIndexes(db)]);
      console.log(
        `fixture customers ${links.plantCustomers} · link จากกฎ ${links.plantRuleLinks}/${links.expectedPlantLinks}` +
          ` · link ทั้งหมด ${links.plantLinks} (ส่วนเกินคือ needs_review จาก LLM ซึ่งถูกต้อง)`
      );
      console.log(`คู่ซ้ำ ${links.duplicatePairs} · auto ที่ไม่ปลอดภัย ${links.unsafeAuto} · family auto ${links.familyAuto}`);
      console.log(`indexes ${indexes.ok ? "ครบ" : `ขาด ${indexes.missing.join(", ")}`}`);
      if (!links.ok || !indexes.ok) process.exitCode = 1;
      return;
    }

    if (!dryRun) await ensureAiIndexes(db);
    const provider = noLlm ? null : createLlmProvider();
    const report = await buildCustomerLinks(db, { llmProvider: provider, dryRun });
    printBuild(report);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("match build ล้มเหลว:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
