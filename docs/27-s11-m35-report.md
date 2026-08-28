# S11-M3.5 Purchase Intake Report

วันที่ตรวจ: 2026-08-28

## ขอบเขตที่ทำ

- เพิ่ม `POST /api/partner/intake` พร้อม HMAC secret แยกต่อ partner, replay window 300 วินาที, body สูงสุด 1 MB, 1-100 events และ rate limit 60 requests/นาที
- เพิ่ม `partner_events`, `purchases`, `purchase_items`, `customer_intents`, `partner_quarantine` และ indexes ตามสเปก
- รองรับ purchase, purchase.void, intent, intent.void, revision, idempotency และ quarantine แบบราย event
- แยกเงินหนึ่งก้อนไว้ที่ purchase และแยกคอร์สเป็น items โดย items ไม่มี amount
- จับลูกค้าตามลำดับ LINE identity, phone, email โดยไม่เดาหรือ merge อัตโนมัติ
- เพิ่ม `reconcilePartnerIdentities()` และ `npm run partner:reconcile`
- เพิ่ม partner AI mirror แยกเป็น `npm run partner:scrub` พร้อม `--all`, `--verify`, `--prune`
- ย้าย purchase/items/intents เมื่อ merge ลูกค้า และคำนวณ intent ปัจจุบันใหม่
- `type: "tag"` เข้า quarantine เท่านั้น ไม่แตะ `customers.tags`

## ผลทดสอบจริง

### Integration ทั้งระบบ

คำสั่ง:

```text
RUN_MONGO_INTEGRATION=true npm test
```

ผล:

```text
core: Test Files 30 passed (30) · Tests 234 passed (234)
web:  Test Files 5 passed (5) · Tests 54 passed (54)
skipped: 0
```

### Typecheck

คำสั่ง:

```text
npm run typecheck
```

ผล: ผ่านทั้ง `@line-crm/core`, `@line-crm/web` และ `tsconfig.scripts.json`

### End-to-end smoke

คำสั่ง:

```text
npm run smoke:partner -- http://localhost:3100
```

ผล:

```text
smoke:partner ผ่าน
- HMAC และ replay window ถูกต้อง
- event เดิม 10 ครั้ง = 1 purchase + 3 items
- ยอดรวม 12345 THB ไม่ถูกคูณตามจำนวนคอร์ส
```

### Partner scrub

ทดสอบกับ `line_crm_test` ไป `line_crm_ai_m35_test` บน MongoDB local:

```text
purchases                 1 -> scrubbed 1 · dirty 0 · PII ไม่พบ
purchase_items            1 -> scrubbed 1 · dirty 0 · PII ไม่พบ
customer_intents          0 -> scrubbed 0 · dirty 0 · PII ไม่พบ
indexes ครบ
```

จงใจลบ `purchases_scrubbed` หนึ่งรายการแล้วรัน `--verify` ซ้ำ: exit code 1 ตามที่กำหนด จากนั้น sync คืนและ verify ผ่านอีกครั้ง

### Reconciliation

รัน `npm run partner:reconcile` สองรอบกับข้อมูล pending ชุดเดียวกัน ได้ผลเท่ากันทั้งสองรอบ:

```text
ตรวจ 1 · ผูกได้ 0 · ยังรอ 1 · กำกวม 0
```

integration test เพิ่มเติมพิสูจน์กรณีผูกได้หนึ่งคน, กำกวมสองคน, คำนวณ intent ใหม่ และ merge lifecycle แล้ว

## ไฟล์สำคัญที่เพิ่มหรือแก้

- API/web: `apps/web/app/api/partner/intake/route.ts`, `apps/web/lib/partner.ts`
- Core partner: `packages/core/src/partner/auth.ts`, `schema.ts`, `identity.ts`, `intake.ts`, `intents.ts`, `reconcile.ts`, `models.ts`
- AI scrub/index: `packages/core/src/ai/scrubPartner.ts`, `packages/core/src/ai/indexes.ts`
- DB/shared: `packages/core/src/db/models.ts`, `db/indexes.ts`, `identity/merge.ts`, `legacy/courseCell.ts`, `legacy/courses.ts`, `ids.ts`, `env.ts`, `index.ts`
- Scripts: `scripts/scrub-partner.ts`, `scripts/reconcile-partner.ts`, `scripts/smoke-partner.ts`
- Tests: `packages/core/tests/partnerSchema.test.ts`, `partnerIntake.integration.test.ts`, `scrubPartner.test.ts`, `apps/web/tests/partnerRoute.integration.test.ts` และ test setup
- Config/docs: `.env.example`, `package.json`, `tsconfig.scripts.json`, เอกสารฉบับนี้

## Design deviation และความเสี่ยง

- เพิ่ม `updatedAt` ใน `CustomerIntentDoc` แม้ตัวอย่าง B3 ไม่แสดง field นี้ เพราะ generic `aiSync` queue ที่สเปกระบุให้ใช้ซ้ำต้องอาศัย `updatedAt` เพื่อกันการ ack ทับข้อมูลที่เปลี่ยนหลัง claim
- model ภายในของ `partner_events.type` รองรับ `tag` เพื่อเก็บ event ตาม A10 แต่ไม่มี business behavior ใดสำหรับ tag
- ยังไม่ได้ตั้ง partner secret จริงใน environment; ก่อน deploy ต้องกำหนด `PARTNER_HMAC_SECRETS_JSON` แยก secret ต่อ partner และเก็บ secret ฝั่งผู้ส่งให้ตรงกัน
- ทดสอบทั้งหมดกับ MongoDB local replica set ตามคำสั่งงาน ยังไม่ได้แตะ Atlas
- `.env.local`, WF-D, analytics/insights และไฟล์ใน `workflows/` ไม่ถูกแก้


---

## ผลรีวิว (โดยผู้รีวิว ไม่ใช่ผู้ทำ) — 2026-08-28

รันเองทั้งหมด ไม่ยึดตามรายงานข้างบน

```text
RUN_MONGO_INTEGRATION=true npm test
core 234 passed (30 files) · web 54 passed (5 files) · skipped 0
npm run typecheck  ผ่านทั้ง core / web / scripts
```

### ทดสอบด้วย payload ที่จงใจโกหก

ยิง `intakePartnerEvents()` ด้วย event ที่ **ยัด `countsAsSeat: true` มาให้คอร์สที่ `kind: "relearn"`**
(relearn = ใช้สิทธิ์เรียนซ้ำ ไม่ใช่การขาย) และยิง `eventId` เดิมซ้ำ **10 ครั้ง**
ทั้งก้อนเป็น 1 การชำระ 33,900 บาท ที่มี 3 คอร์ส

```text
purchases = 1        (ไม่ใช่ 10)
items     = 3
ยอดรวม    = 33,900   (ไม่ใช่ 101,700 — ไม่คูณตามจำนวนคอร์ส)
item มีฟิลด์เงินไหม: ไม่มี ✅

countsAsSeat ที่ระบบคำนวณเอง:
  INNER   kind=enrolled  countsAsSeat=true
  COMMU   kind=relearn   countsAsSeat=false   ← ไม่เชื่อค่าที่ partner ส่งมา ✅
  DEEPIN  kind=enrolled  countsAsSeat=true
```

ผ่านทั้ง 3 ข้อที่เป็นหัวใจของความถูกต้องทางตัวเลข

### ตรวจเกณฑ์ผ่านงานอื่น

- `workflows/` **ไม่ถูกแตะแม้แต่ไฟล์เดียว** (`git status workflows/` ว่าง) ตามที่ B7 กำหนด
- ชื่อเทสครอบคลุมเคสยากครบ โดยเฉพาะ **"staff soft ถูก AI ที่ใหม่กว่าทับได้"**
  ซึ่งเป็นข้อที่ทีมระบบ tag ทักมาว่าถ้าทำผิดสถานะลูกค้าจะค้างตลอดกาล
- `type: "tag"` เข้า quarantine และไม่แตะ `customers.tags` ตาม A10

**สรุป: ผ่านเกณฑ์ใน docs/26 §B7 ครบ**
