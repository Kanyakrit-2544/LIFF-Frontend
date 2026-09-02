# S14 — Local Admin Test Harness (spec สำหรับ Codex)

## เป้าหมาย
ให้ **แอดมิน (เจ้าของธุรกิจ) ทดสอบระบบทั้งหมดในเครื่องตัวเองได้** โดยไม่ต้องแตะโค้ด ไม่ต้อง deploy และไม่ต้องใช้ Google OAuth จริง

**ขอบเขต = เฉพาะ "ปลดล็อกการทดสอบ local"** — ไม่ใช่ฟีเจอร์ใหม่ ฟีเจอร์ผลิตภัณฑ์ (review 3 แท็บ, profile M5, analytics S13) เสร็จแล้ว งานนี้คือทำให้มันมีข้อมูล + เข้าถึงได้ในเครื่อง

## บริบทที่ต้องรู้ก่อน (อ่านไฟล์จริง)
- Auth: `apps/web/auth.ts` — NextAuth, provider เดียวคือ Google, `signIn` callback บังคับ `email_verified` + `isAllowedStaffEmail` (`apps/web/lib/adminAuth.ts`, อ่าน `STAFF_EMAIL_ALLOWLIST`)
- Admin อ่าน DB ผ่าน `apps/web/lib/adminDb.ts` — `ADMIN_MONGODB_URI` (client เดียว) + `AI_MONGODB_DB` + `LEGACY_MONGODB_DB` (db คนละชื่อบน client เดียวกัน); analytics/insights ใช้ `apps/web/lib/mirrorDb.ts` → `MONGODB_MIRROR_URI`
- หน้า review (`apps/web/app/admin/review/page.tsx`) มี 3 แท็บ ดึงด้วย `listPendingMergeReviews(mainDb)` · `listCustomerLinkReviews(mainDb, aiDb, legacyDb)` · `listPartnerReviews(mainDb)` — **seed ต้องทำให้ 3 ฟังก์ชันนี้คืนของ ไม่ใช่ว่าง**
- ETL ของจริงมีแล้ว: `npm run legacy:import` + `packages/core/src/legacy/importReal.ts`; mock legacy: `npm run legacy:generate`
- scrub/match ที่ต้องเรียก: `scrubCustomer` (`ai/scrubCustomer.ts`), `scrub-legacy.ts`, `buildCustomerLinks` (`match/engine.ts`), `ensureAiIndexes`
- **Mongo local เป็น replica set** ที่ประกาศ member เป็น `localhost:27017` → ทุก URI local ต้องมี `/?directConnection=true` ไม่งั้น driver วิ่งไป 27017 (connection refused)

## Deliverable 1 — Dev login (ข้าม Google, gate แน่น)
เพิ่ม **Credentials provider สำหรับ dev เท่านั้น** ใน `apps/web/auth.ts`:
- รวม provider นี้ **ก็ต่อเมื่อ** `process.env.NODE_ENV !== "production"` **และ** `process.env.DEV_AUTH_ENABLED === "true"` — เงื่อนไข `NODE_ENV` เป็น hard guard ต่อให้ env หลุด production ก็ต้องไม่มี provider นี้
- login เป็น `process.env.DEV_ADMIN_EMAIL` โดยไม่มีรหัส/ไม่ต่อภายนอก; ถ้า email นี้ไม่อยู่ใน `STAFF_EMAIL_ALLOWLIST` ให้ปฏิเสธ (ผ่าน guard เดิม)
- `signIn` callback เดิมต้องยังบังคับ allowlist กับ path นี้ด้วย (อย่าปิด guard)
- ปุ่ม "เข้าสู่ระบบ (dev)" ใน `apps/web/app/admin/login/page.tsx` แสดง **เฉพาะเมื่อ dev provider เปิด** (เช็คตัวแปรฝั่ง server)
- **เทส**: (ก) เมื่อ `NODE_ENV=production` แม้ตั้ง `DEV_AUTH_ENABLED=true` → ต้องไม่มี credentials provider; (ข) เมื่อ dev เปิด แต่ email ไม่อยู่ allowlist → เข้าไม่ได้; (ค) เมื่อ dev เปิด + email อยู่ allowlist → เข้าได้
- **ห้าม** log ค่า env, ห้ามฝัง default email ในโค้ด (ต้องมาจาก env เท่านั้น)

## Deliverable 2 — Unified local seed (`npm run seed:local`)
สคริปต์ `scripts/seed-local.ts` + npm script `seed:local` (ตาม pattern `--env-file=apps/web/.env.local`):
- **Guardrail บังคับ**: อ่าน target URI แล้ว **ปฏิเสธถ้า host ไม่ใช่ localhost/127.0.0.1** (throw ทันที) — กันเผลอเขียนทับ Atlas · รับ `--uri`/`--drop`, idempotent (drop เฉพาะข้อมูล seed ที่ตัวเองสร้าง เช่น tag `seedTag:"local-demo"` หรือ synthetic)
- ใส่ข้อมูลลง `line_crm_dev` / `line_crm_ai` / `line_crm_legacy` (db บน local client เดียว) ให้ **ทุกหน้า admin มีของ**:
  - **customers** ~40 คน หลากหลาย (`customerStatus` lead/prospect/customer, มี/ไม่มี เบอร์-อีเมล, มี 1–2 คน `status:"erased"` ไว้ทดสอบการซ่อน PII)
  - **pendingMerge** อย่างน้อย 3 คู่ (2 customers เบอร์/อีเมลตรงกัน + ตั้ง `pendingMerge`) → แท็บ "ลูกค้าซ้ำ" มีรายการ
  - **partner** purchases + intents รวม event ที่ `status:"pending_identity"` และ `"quarantined"` อย่างละ ≥2 → แท็บ "Partner" มีรายการ
  - **legacy**: ใช้ `legacy:generate` (mock) เป็นฐาน + (ถ้ามีของจริง 30 แถวที่ import ไว้ก็คงไว้ได้)
  - เรียก scrub + `buildCustomerLinks` ให้ `customer_links` ออกมา**คละสถานะ**: มี `needs_review` (คู่แข่งกำกวม), `auto`, และ seed `confirmed` ไว้ ≥2 (เพื่อให้ profile โชว์ประวัติเก่าได้เลย) → แท็บ "ประวัติเก่า" มีรายการ
  - purchases/enrollments กระจายช่วงเวลา/คอร์ส พอให้ **`runAnalytics` คืนค่าไม่ว่างครบ 6 metric**
- พิมพ์สรุปท้ายรัน: จำนวนต่อแท็บ (merge N · links needs_review N · partner N · customers N · analytics rows N) เพื่อให้ผู้ทดสอบรู้ว่าจะเห็นอะไร
- ข้อมูล seed ต้องเป็น synthetic/ติดป้ายชัด — ถ้าใช้ legacy จริง 30 แถว ให้เตือนว่าเป็น PII จริง local

## Deliverable 3 — Env preset + runbook
- เพิ่มบล็อก **LOCAL profile** ใน `apps/web/.env.local.example` (สร้างถ้ายังไม่มี) ค่า:
  `ADMIN_MONGODB_URI=mongodb://localhost:27018/?directConnection=true`, `AI_MONGODB_DB=line_crm_ai`, `LEGACY_MONGODB_DB=line_crm_legacy`, `MONGODB_MIRROR_URI=mongodb://localhost:27018/?directConnection=true`, `AI_MONGODB_DB`/`MONGODB_DB` ตามจริง, `AI_HASH_PEPPER=<dev>`, `STAFF_EMAIL_ALLOWLIST=admin@example.com`, `DEV_AUTH_ENABLED=true`, `DEV_ADMIN_EMAIL=admin@example.com`
  - อย่าแตะ `.env.local` จริง (มี Atlas + secret) — ทำเป็น `.example` ให้ผู้ใช้ก็อป
- `docs/37-admin-local-test-runbook.md` — ขั้นตอน + **เช็คลิสต์ทดสอบ**:
  1. สตาร์ท Mongo local → `npm run seed:local` → `npm run dev` (ใน apps/web)
  2. เปิด `/admin/login` → กด "เข้าสู่ระบบ (dev)"
  3. เช็คลิสต์แต่ละหน้า (สิ่งที่กด → สิ่งที่ควรเห็น):
     - แท็บ **ลูกค้าซ้ำ**: กด confirm 1 คู่ → รวมแล้ว; reject 1 คู่ → จำถาวร
     - แท็บ **ประวัติเก่า**: confirm 1 link → เปิด profile ลูกค้านั้น → **ประวัติซื้อเก่าโผล่** (ก่อน confirm ต้องซ่อน — D23)
     - แท็บ **Partner**: assign identity ให้ event `pending_identity`; reject `quarantined`
     - **โปรไฟล์ลูกค้า**: ยอดรวม/ที่นั่ง/คอร์สถูก; ลูกค้า `erased` ต้องซ่อนชื่อ-เบอร์
     - **Analytics**: เห็น 6 metric ตัวเลขไม่ว่าง; แถบเตือน synthetic (แดง)/estimate (เหลือง) ถ้ามี

## กติกา (ห้ามพลาด)
- Dev login **ต้องเป็นไปไม่ได้ใน production** — ทดสอบเงื่อนไข `NODE_ENV` ให้ครบ นี่คือ control ความปลอดภัย
- `seed:local` **ต้องปฏิเสธ URI ที่ไม่ใช่ local** — กันเขียนทับ Atlas
- ห้ามเปลี่ยนความหมาย `AI_HASH_PEPPER` / `INTERNAL_HMAC_SECRET`
- ตาม HANDOFF: ห้ามปิดเทสเดิม; เพิ่มเทสใหม่; ถ้าเทสเดิมพังเพราะพฤติกรรมเปลี่ยนโดยตั้งใจ ให้แก้เทสพร้อมอธิบาย
- ใช้ helper เดิม (`scrubCustomer`, `scrub-legacy`, `buildCustomerLinks`, `ensureAiIndexes`, `legacy:generate`) อย่าเขียน logic scrub/match ใหม่
- ทุก URI local เติม `/?directConnection=true`
- รันแล้วต้องผ่าน: `npm test` (core+web), `tsc --noEmit`, `next build`

## สิ่งที่ส่งกลับมาให้ตรวจ
รายงานสั้น: ไฟล์ที่แตะ, ผลรัน `seed:local` (สรุปต่อแท็บ), ผลเทส 3 เคสของ dev-login, ผล `npm test`/build, และ 1 บรรทัดยืนยันว่า production ไม่มีทางเปิด dev-login
