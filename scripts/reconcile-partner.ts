import { MongoClient } from "mongodb";
import { reconcilePartnerIdentities } from "../packages/core/src/index";

function arg(name: string, fallback?: string): string | undefined {
  const equals = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1]!.startsWith("--")) return process.argv[index + 1];
  return fallback;
}

async function main() {
  const uri = arg("uri", process.env.MONGODB_URI);
  if (!uri) throw new Error("ไม่พบ --uri หรือ MONGODB_URI");
  const dbName = arg("db", process.env.MONGODB_DB ?? "line_crm_dev")!;
  const client = new MongoClient(uri, { appName: "line-crm-partner-reconcile", serverSelectionTimeoutMS: 8_000 });
  try {
    await client.connect();
    const report = await reconcilePartnerIdentities(client.db(dbName), { dryRun: process.argv.includes("--dry-run") });
    console.log(`partner reconcile: ตรวจ ${report.scanned} · ผูกได้ ${report.resolved} · ยังรอ ${report.stillPending} · กำกวม ${report.ambiguous}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("partner reconcile ล้มเหลว:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});

