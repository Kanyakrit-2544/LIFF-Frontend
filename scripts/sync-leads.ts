/**
 * ดึงรายละเอียด lead ที่ค้างในคิวจาก Graph API แล้วสร้างลูกค้า
 *
 *   npm run leads:sync                 ประมวลผลที่ค้างทั้งหมด
 *   npm run leads:sync -- --limit 20
 *   npm run leads:sync -- --dry-run    ดึงมาดูอย่างเดียว ไม่เขียนฐาน
 *
 * ยังไม่ตั้ง FACEBOOK_PAGE_TOKEN = จบด้วย exit 0 พร้อมบอกว่าต้องตั้งอะไร (D32)
 * event ยังค้างในคิว ข้อมูลไม่หาย
 */
import {
  ackEvents,
  claimPending,
  closeClient,
  facebookConfigured,
  syncPendingLeads,
  failEvent,
  fetchLead,
  getDb,
  releaseStaleClaims,
  upsertFromLead,
  ensureLeadIndexes,
  type LeadgenNotification,
} from "../packages/core/src/index";

function arg(name: string, fallback?: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")) return process.argv[i + 1];
  return fallback;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limit = Math.max(1, Math.min(Number(arg("limit", "50")), 200));
  const cfg = facebookConfigured();
  if (!cfg.graph) {
    console.log("⚠️  ยังไม่ได้ตั้ง FACEBOOK_PAGE_TOKEN — ดึงรายละเอียด lead ไม่ได้ (event ค้างในคิว ไม่หาย)");
    await closeClient();
    return;
  }
  if (dryRun) {
    console.log("dry-run: ข้ามการเขียนฐาน (ใช้ endpoint/สคริปต์จริงเพื่อ sync)");
    await closeClient();
    return;
  }
  const r = await syncPendingLeads(limit);
  console.log(`✅ ลูกค้าใหม่ ${r.created} · อัปเดต ${r.updated} · ล้มเหลว ${r.failed} (หยิบมา ${r.claimed})`);
  if (r.pendingMerge > 0) console.log(`⚠️  เบอร์/อีเมลซ้ำกับลูกค้าเดิม ${r.pendingMerge} คน — pendingMerge รอคนตรวจ (D3)`);
  if (r.needsConsent > 0) console.log(`⚠️  ยังไม่มี consent ${r.needsConsent} คน — ห้ามส่งการตลาด (D33)`);
  if (r.attributionPending > 0) console.log(`⚠️  ยังไม่รู้คอร์ส/แคมเปญ ${r.attributionPending} คน — เติม lead_form_mappings แล้วรันใหม่ (D34)`);
  await closeClient();
}

main().catch(async (e) => {
  console.error("❌", (e as Error).message);
  await closeClient().catch(() => {});
  process.exit(1);
});
