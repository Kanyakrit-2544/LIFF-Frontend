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
  if (!cfg.webhook) console.log("⚠️  ยังไม่ได้ตั้ง FACEBOOK_APP_SECRET / FACEBOOK_VERIFY_TOKEN — webhook ยังรับ lead ไม่ได้");
  if (!cfg.graph) {
    console.log("⚠️  ยังไม่ได้ตั้ง FACEBOOK_PAGE_TOKEN — ดึงรายละเอียด lead ไม่ได้");
    console.log("   event ที่รับมาแล้วยังค้างอยู่ในคิว ไม่หาย · ใส่ token แล้วรันใหม่ได้เลย");
    await closeClient();
    return;
  }

  await ensureLeadIndexes(await getDb());
  await releaseStaleClaims("facebook");
  const events = await claimPending({ provider: "facebook", limit });
  console.log(`📥 หยิบมา ${events.length} lead`);

  let created = 0, updated = 0, failed = 0, pendingMerge = 0, noConsent = 0, pendingAttr = 0;
  const done: string[] = [];

  for (const ev of events) {
    const notification = ev.raw as unknown as LeadgenNotification;
    const res = await fetchLead(notification.leadgenId);
    if (!res.ok || !res.lead) {
      failed++;
      console.error(`  ✗ ${notification.leadgenId}: ${res.error}${res.retryable ? " (ลองใหม่ได้)" : " (ต้องมีคนแก้)"}`);
      if (!dryRun) await failEvent(ev.eventId, res.error ?? "fetch lead ไม่สำเร็จ", "facebook");
      continue;
    }
    if (dryRun) {
      console.log(`  • ${notification.leadgenId} ดึงได้ ${res.lead.field_data?.length ?? 0} ฟิลด์ (dry-run ไม่เขียนฐาน)`);
      continue;
    }
    const r = await upsertFromLead({ notification, lead: res.lead });
    r.isNew ? created++ : updated++;
    if (r.pendingMergeWith) pendingMerge++;
    if (r.mapped.needsConsent) noConsent++;
    if (r.attribution.attributionPending) pendingAttr++;
    done.push(ev.eventId);
  }

  if (done.length > 0) await ackEvents(done, "facebook");

  console.log(`\n✅ ลูกค้าใหม่ ${created} · อัปเดต ${updated} · ล้มเหลว ${failed}`);
  if (pendingMerge > 0) console.log(`⚠️  เบอร์/อีเมลซ้ำกับลูกค้าเดิม ${pendingMerge} คน — ตั้ง pendingMerge รอคนตรวจ (D3)`);
  if (noConsent > 0) console.log(`⚠️  ยังไม่มี consent ${noConsent} คน — ห้ามส่งการตลาด (D33)`);
  if (pendingAttr > 0) console.log(`⚠️  ยังไม่รู้ว่ามาจากคอร์ส/แคมเปญไหน ${pendingAttr} คน — เติม lead_form_mappings แล้วรันย้อนหลัง (D34)`);
  await closeClient();
}

main().catch(async (e) => {
  console.error("❌", (e as Error).message);
  await closeClient().catch(() => {});
  process.exit(1);
});
