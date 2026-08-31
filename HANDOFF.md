# HANDOFF — LINE CRM (อ่านไฟล์นี้ก่อนเริ่มงาน)

## ระบบนี้คืออะไร

เก็บข้อมูลลูกค้าจาก LINE OA ของ **Inner Power** (ธุรกิจคอร์ส/สัมมนา)

```
คนแอด LINE → webhook → Vercel → inbound_events → n8n WF-A → customers
เปิด LIFF → กรอกฟอร์ม → Vercel → MongoDB (plaintext)
MongoDB → n8n WF-C (2 นาที) → Google Sheet   ← ฝ่ายขายใช้
MongoDB → n8n WF-D (10 นาที) → line_crm_ai   ← ข้อมูล scrub แล้วสำหรับ AI
Partner → HMAC intake → purchases/intents → partner:scrub → line_crm_ai
Facebook Lead → webhook เก็บ id → leads:sync → customers + attribution
Legacy DB → legacy:scrub → line_crm_ai → match:build → customer_links
line_crm_ai → analytics แบบ deterministic → insights
Staff → Google OAuth → /admin/review → decisions + audit_logs
```

**ใช้งานจริงแล้ว** ทดสอบระบบกรอกฟอร์มผ่าน LINE สำเร็จ

## Stack

Next.js 15 (App Router) บน Vercel · MongoDB Atlas · n8n (Docker บนเครื่อง) · Google Sheets · TypeScript monorepo (npm workspaces)

- `packages/core` — business logic ทั้งหมด (unit test ได้เปล่า ๆ)
- `apps/web` — LIFF frontend + API routes
- `workflows/` — n8n export (WF-A, WF-C, WF-D, WF-E)
- `scripts/` — seed, setup, smoke test, reset

## เอกสาร

`README.md` มี index ครบ · `docs/00`–`docs/30` · **`docs/13`** = สเปกที่เขียนให้ Codex เป็นตัวอย่างรูปแบบที่ใช้ได้ผล

## กฎที่ยึดมาตลอด ห้ามละเมิด

1. **business logic อยู่ใน `packages/core` ไม่ใช่ n8n** — n8n ทำแค่ trigger/retry/integration I/O
2. **n8n ห้ามต่อ MongoDB หลัก** — ผ่าน `/api/internal/*` (HMAC + replay window 300s) เท่านั้น
3. **ห้าม log PII** — `logger.ts` redact อัตโนมัติ อย่าปิด
4. **ไม่เก็บบทสนทนา LINE** — redact ตั้งแต่ webhook ก่อน insert (D4)
5. **`staffNote` ต้องเป็นคอลัมน์สุดท้ายของชีตเสมอ** — ระบบเขียนถึงแค่คอลัมน์ก่อนหน้า
6. **ตัวตนมาจาก id_token เท่านั้น** — ห้ามรับ `userId`/`customerId` จาก request body
7. **ห้ามลด/ปิด test เดิม** — พังเพราะพฤติกรรมเปลี่ยนให้แก้ให้ตรงพร้อมอธิบาย

## ⚠️ บทเรียนสำคัญ (เสียเวลาไปเยอะกับเรื่องพวกนี้)

**Integration test ถูก skip เงียบ ๆ** — `npm test` เฉย ๆ ข้าม test ที่ต้องใช้ Mongo แล้วรายงานว่า "ผ่าน" ต้องรัน
```bash
npm run db:test:up && RUN_MONGO_INTEGRATION=true npm test
```
Codex รายงาน "ผ่าน" มาหลายรอบทั้งที่ integration ไม่ได้รัน — **ตรวจตัวเลข skipped ทุกครั้ง**

**n8n workflow ต้องรันจริงถึงจะรู้ว่าพัง** — S4 มี 8 บั๊กที่ typecheck/build/unit test ผ่านหมดแต่ workflow ทำงานไม่ได้เลย ดู `docs/15`

**n8n gotcha ที่เจอมาแล้ว**
- ต้องมี `NODE_FUNCTION_ALLOW_BUILTIN=crypto` ไม่งั้น Code node เซ็น HMAC ไม่ได้
- ต้องมี `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` ไม่งั้นอ่าน `$env` ไม่ได้
- Code node โหมด `runOnceForAllItems` แต่เขียนอ่าน `$json` = ได้ item แรกตัวเดียว item อื่นหายเงียบ
- `retryOnFail` เป็น property ระดับ node ไม่ใช่ใน `options`
- workflow JSON ต้องมี `id` ไม่งั้น `n8n import:workflow` พัง
- `errorWorkflow` ต้องอ้างด้วย id ไม่ใช่ชื่อ
- **import ทับลบการผูก credential เสมอ** — วิธีแก้: ใส่ `id` ของ credential ลงในไฟล์ JSON **ก่อน** import
  (อ่าน id จาก `.n8n-data/database.sqlite` ตาราง `credentials_entity`) แล้วไม่ต้องเปิด UI เลย · ใช้สำเร็จมาแล้ว 2 ครั้ง
- MongoDB node cast `_id` เป็น ObjectId เสมอ — `_id` ของเราเป็น ULID ใช้ `customerId` เป็น updateKey แทน
- claim lock ค้าง 5 นาทีถ้า workflow error กลางคัน → `npm run reset:demo -- --resync` ปลดได้

**Compass** — `Drop Collection` ลบทั้ง collection · `Delete Document` ลบแค่แถว · กู้ด้วย `npm run create-indexes && npm run seed:form`

## Design decisions ที่ยืนยันแล้ว

อยู่ในตาราง `README.md` (D1–D22) ที่สำคัญ

| # | ตัดสินใจ |
|---|---|
| D2 | Sheet one-way จาก Mongo เท่านั้น |
| D3 | **เลิก auto-merge** — เบอร์ตรงกับคนอื่น = ตั้งธง `pendingMerge` ให้คนตรวจ (auto-merge เปิดช่องยึดข้อมูลด้วยเบอร์ ดู `docs/18`) |
| D4 | ไม่เก็บบทสนทนา เก็บแค่ follow + first_message |
| D9–D11 | **ไม่ใช้ AI ใน sheet sync** — map ตรงจาก `SHEET_COLUMNS` (คอลัมน์ไม่เปลี่ยน) จึงไม่ต้อง scrub ในเส้นทางนี้ |
| S9 | Mongo หลักเก็บ **plaintext** (ฝ่าย IT อ่านได้) · `line_crm_ai` เก็บฉบับ scrub แล้ว · แยก Mongo user 3 ตัว |

## สถานะปัจจุบัน

**เสร็จในโค้ดแล้ว** S1–S9 และ S11-M1/M2/M3/M3.5/M4/M6

- S10 ว่างโดยตั้งใจตาม `docs/05` (งาน PII service ถูกย้าย/พักไว้)
- M5 restore/แสดงประวัติซื้อรายบุคคลยังพักไว้ เพราะ `customer_links` ต้องให้พนักงานยืนยันก่อน
- ผลล่าสุด 2026-08-31: 383 tests ผ่าน (core 309 · web 74), skipped 0, typecheck ผ่านทั้ง core/web/scripts
- Partner, Facebook และ Hermes/LLM ยังไม่ได้ยืนยันกับ credential/ข้อมูลจริง

**WF-D เคลียร์แล้ว (2026-08-28)** — import เวอร์ชันใหม่ที่มี `title`/`nameKeys`/`nicknameKey`
เทคนิค: ใส่ `id` ของ MongoDB credential ลงในไฟล์ JSON **ก่อน** import → credential ไม่หลุด ไม่ต้องผูกใหม่ใน UI
active แล้ว · สั่ง re-sync ลูกค้าเติม `nameKeys` แล้ว

⚠️ **บทเรียนใหม่: `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none`**
execution ที่สำเร็จจะไม่ถูกบันทึก เหลือแถวค้างสถานะ `running` ตลอดไป
**`running` ในตาราง execution = สำเร็จแล้ว ไม่ใช่ค้าง** ส่วน `error` ที่เห็นเป็นกองเป็นของเก่าสะสม
เช็คว่าระบบพังจริงไหม ให้ดู **เวลาของ error ล่าสุด** ไม่ใช่จำนวน error
(เกือบวินิจฉัยผิดว่าทุก workflow กำลังพัง ทั้งที่ error ล่าสุดคือ 07:18 UTC และหลังจากนั้นเดินปกติ)

**ต่อระบบ tag แล้ว (2026-08-31)**
- ออก partner secret ให้ `tagger` แล้ว ทั้งสองฝั่งตรงกัน (ยังไม่ได้วางลง Vercel)
- **ส่งต่อแชทให้ระบบ tag** — LINE ตั้ง webhook ได้ channel ละ 1 อัน ระบบ tag จึงรับต่อจาก
  `/api/webhook/line` ผ่าน `TAGGER_FORWARD_URL` · ส่ง byte เดิม + ลายเซ็นเดิม ปลายทางตรวจเองด้วย
  channel secret ตัวเดียวกัน · **D4 ยังอยู่ครบ ระบบนี้ไม่เก็บข้อความเหมือนเดิม** แค่ส่งต่อแล้วปล่อยทิ้ง
- `type: "erase"` — คำขอลบข้อมูล PDPA (docs/26 §A11) ตัดตัวตนออกจากธุรกรรม ไม่ลบธุรกรรมทิ้ง
  ⚠️ ยังไม่ครอบ `line_crm_legacy` ถ้าลูกค้าขอลบต้องจัดการชีตขายแยกด้วยมือ

**สภาพ error ปัจจุบัน (ตรวจ 31 ส.ค. 2026)**
`audit_logs` มี `workflow.error` 169 รายการใน 5 วัน (~50/วัน) กระจุกที่ node ที่ยิง HTTP มาขอข้อมูล
WF-A `Claim Events` 129 · WF-C `Claim Rows` 35 · WF-D `Claim Customers` 5

**แต่ไม่มีข้อมูลสูญหาย** — `dead 0 · stuck 0 · dirty 0` ทุกคิว ระบบ retry เองสำเร็จ
สาเหตุน่าจะเป็น Mongo ตอบช้า ~2.2 วิ (Atlas shared tier) + WF-A ยิงทุก 15 วิ → บาง request timeout
WF-A ยิงวันละ ~5,760 ครั้ง พลาด 129 = 2% ซึ่ง retry รับไหว

**WF-E แก้แล้ว (2026-08-31)** — อ่าน `execution.error.message` และ redact PII ต่อ
พิสูจน์โดยทำให้ WF-A ชี้ host ผิดชั่วคราว: `audit_logs` เก็บชื่อ WF-A, node `Claim Events`
และสาเหตุ host/domain ไม่ถูกต้องจริง จากนั้นคืน WF-A ตัวจริงแล้ว

**ชั้นตรวจข้อมูลค้างเสร็จแล้ว (D41/D42)**
- `npm run status:check` และ `GET /api/admin/status`
- ค่าเริ่มต้น: inbound 15 นาที · Sheet/AI mirror 30 นาที · error spike 10 ครั้งใน 15 นาที
- `status_incidents` จำปัญหาที่ยังไม่หาย จึงไม่รายงานซ้ำทุกรอบ
- มีแค่ console/log sink ตาม D42 ยังไม่ต่อ LINE, อีเมล หรือ Slack

**หน้าพนักงานเสร็จในโค้ดแล้ว** — `/admin/review` ครบ 3 คิว: `pendingMerge`, `customer_links`
และ partner `quarantined`/`pending_identity` · ใช้ Google OAuth + email allowlist · ทุกการกดมี audit
ยังต้องสร้าง Google OAuth credential และ `review_user` ก่อนเปิดใช้บน Vercel

**กับดัก `env:vercel` แก้แล้ว** — ถ้าไม่ใส่ `--keep-secrets` สคริปต์จะเขียน secret ที่สุ่มใหม่กลับ
`apps/web/.env.local` และอัปเดต `INTERNAL_HMAC_SECRET` ใน `.env` ของ n8n ด้วย
หลังรันต้อง restart n8n, วาง `vercel.env.txt` ใน Vercel และรัน AI scrub/mirror ใหม่เมื่อ pepper เปลี่ยน

**ลบ `__p` แล้ว (2026-08-31)** — Atlas dev มี 0 documents; เพิ่มใน cleanup script แบบรันซ้ำได้แล้ว

**Google Sheets layout ปัจจุบัน** มี 22 คอลัมน์ ตัด `สถานะ`/`ช่องทางที่มา` และเพิ่ม `เห็นเราจากช่องทางไหน`
คำเตือนเรื่อง Vercel ใช้โค้ดเก่าจากรอบก่อนหน้าไม่ใช่สถานะที่ยืนยันได้จาก repository อีกต่อไป
ก่อนล้างหรือ re-sync ชีตจริง ต้องตรวจ deployment และหัวตารางในชีตให้ตรงกันก่อนเสมอ ห้ามเดาจากเอกสารนี้

## งานที่เหลือ

| งาน | ความเร่งด่วน |
|---|---|
| **ย้าย n8n ไป VPS องค์กร** | สูงสุด — ปิดเครื่อง = ชีตกับ AI mirror หยุด (ข้อมูลไม่หาย ค้าง `dirty` รอ) |
| กรอก `TODO` ใน `apps/web/app/privacy/page.tsx` | สูง — ชื่อธุรกิจ + อีเมลติดต่อ |
| ตั้ง `LLM_BASE_URL` ชี้ Hermes แล้วลอง `npm run insights:ask -- --question "..."` | กลาง — ชั้น aggregation ใช้ได้แล้วด้วย `--query` |
| ขอ token Facebook Lead (ดู `docs/28` §10) | กลาง — โค้ดพร้อม ใส่ token แล้วรันได้เลย |
| ~~ตั้ง Partner secret จริง~~ | ✅ ออกให้แล้ว 2026-08-31 · อยู่ใน `.env.local` + `vercel.env.txt` + `tagger/.env` (fingerprint `26908a1c4a08`) · **ยังต้องวางลง Vercel env แล้ว redeploy** |
| ตั้ง Google OAuth + `review_user` + staff allowlist บน Vercel | กลาง — โค้ดหน้า Admin พร้อมแล้ว |
| ให้พนักงานเคลียร์ `customer_links` ที่ต้องใช้ ก่อนเริ่ม M5 | กลาง — ต้องมี legacy DB ต้นฉบับ |
| Presidio scrub จริง | ต่ำ — รอตอนเพิ่มคำถามปลายเปิด |
| import ไฟล์ลูกค้าเก่า `raw input/Inner.xlsx` | ยังไม่อยู่ในสโคป — 10,998 แถว ลูกค้าซ้ำ 1,648 คน ต้องมีแผน dedupe |

## Secret / credential

**`SECRETS.local.md`** (gitignored) รวมทุกอย่าง — URI ทั้ง 3 Mongo user, ตารางว่า key ไหนห้ามเปลี่ยนเพราะอะไร, LINE channel ID, Google service account

- `vercel.env.txt` (gitignored) = env สำหรับวางลง Vercel · สร้างใหม่ `npm run env:vercel -- --domain <d> --keep-secrets`
- `apps/web/.env.local` = env ตอน dev
- `.env` ที่รากโปรเจกต์ = env ของ n8n (docker-compose อ่านอัตโนมัติ)

หน้า Admin เพิ่ม `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `STAFF_EMAIL_ALLOWLIST`,
`ADMIN_MONGODB_URI`, `AI_MONGODB_DB`, `LEGACY_MONGODB_DB` · ห้ามใช้ `mirror_user` แทน `review_user`

**ห้ามเปลี่ยน** `AI_HASH_PEPPER` (hash ใน AI DB เป็นคนละชุด) · `INTERNAL_HMAC_SECRET` (ต้องตรงกับ n8n)

## คำสั่งที่ใช้บ่อย

```bash
cd "/Users/kanyakritbowornsuwan/Desktop/Claude Code/line-crm"

npm run db:test:up && RUN_MONGO_INTEGRATION=true npm test   # test แบบรันจริง
npm run typecheck
npm run build --workspace @line-crm/web

npm run create-indexes        # สร้าง collection + index (กู้ตอนเผลอ drop)
npm run seed:form             # ใส่แบบฟอร์มลง Atlas
npm run setup:sheet           # สร้างหัวตารางในชีต
npm run reset:demo            # ลบข้อมูลลูกค้า เก็บโครงสร้าง
npm run reset:demo -- --resync  # สั่ง sync ใหม่ ไม่ลบ + ปลด lock ค้าง
npm run smoke:line            # ยิง LINE webhook ปลอมที่ signature ถูก
npm run smoke:s4              # ทดสอบวงจร webhook→pending→upsert→ack
npm run env:vercel -- --domain liff-frontend-three.vercel.app --keep-secrets
npm run legacy:scrub -- --legacy-uri "<uri>" --ai-uri "<uri>" --ai-db line_crm_ai
npm run legacy:scrub -- --legacy-uri "<uri>" --ai-uri "<uri>" --ai-db line_crm_ai --verify
npm run legacy:scrub -- --legacy-uri "<uri>" --ai-uri "<uri>" --ai-db line_crm_ai --prune   # ลบของกำพร้าหลัง regen ฐาน legacy
npm run match:build -- --ai-uri "<uri>" --ai-db line_crm_ai --no-llm
npm run match:build -- --ai-uri "<uri>" --ai-db line_crm_ai_test --plant 25
npm run match:build -- --ai-uri "<uri>" --ai-db line_crm_ai_test --verify
npm run partner:reconcile
npm run partner:scrub -- --all
npm run partner:scrub -- --verify
npm run smoke:partner -- http://localhost:3000
npm run smoke:facebook -- --url http://localhost:3000
npm run leads:sync
npm run insights:ask -- --query '<AnalyticsQuery JSON>'
npm run status:check
npm run cleanup:db-obsolete          # dry-run
npm run cleanup:db-obsolete -- --apply

docker compose up -d
docker compose stop n8n
docker compose logs -f n8n
```

## URL

- production `https://liff-frontend-three.vercel.app`
- LIFF `https://liff.line.me/2011263761-R1cpqPt3` (publish แล้ว)
- health `https://liff-frontend-three.vercel.app/api/health`
- n8n `http://localhost:5678` (`admin` / รหัสใน `.env`)
- LINE OA `@543zipsl` · Messaging channel `2011262829` · Login channel `2011263761`

## วิธีทำงานที่ใช้ได้ผลกับโปรเจกต์นี้

1. เขียนสเปกละเอียดให้ Codex (แบบ `docs/13`) — มี request/response schema, เกณฑ์ผ่านงาน, กฎห้ามละเมิด
2. Codex ทำ → **รีวิวโดยรันเทสเองและยิง endpoint จริง ไม่เชื่อรายงาน**
3. บันทึกผลรีวิวเป็น `docs/NN-review.md` พร้อมผลรันจริง

ผู้ใช้ชอบให้ตอบเป็น**ภาษาไทย กระชับ** และให้บอกเหตุผล/trade-off/ความเสี่ยงทุกครั้งที่เสนอทางเลือก
