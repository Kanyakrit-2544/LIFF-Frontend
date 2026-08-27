# S9 — Plaintext DB + AI Mirror

## 20.1 เป้าหมายที่ทำ

S9 เปลี่ยนฐานหลัก `line_crm_dev` ให้เก็บ `phone` / `email` เป็น plaintext normalized และย้ายข้อมูลที่ AI ใช้ไปไว้ฐานแยก `line_crm_ai.customers_scrubbed`

```
line_crm_dev  --API scrub/mask/hash-->  n8n WF-D  -->  line_crm_ai.customers_scrubbed
```

กติกาหลัก:

- app ใช้ `app_user` อ่าน/เขียนเฉพาะ `line_crm_dev`
- n8n WF-D เห็นเฉพาะ payload ที่ scrub แล้วจาก API
- `mirror_user` ต้อง `readWrite` เฉพาะ `line_crm_ai`
- `ai_user` ต้อง `read` เฉพาะ `line_crm_ai`
- hash ใน AI DB ใช้ `AI_HASH_PEPPER` แยก ไม่ใช้ secret เก่าของ DB หลัก

## 20.2 สิ่งที่เปลี่ยนในโค้ด

- `CustomerDoc.phone` / `email` เป็น `string | null`
- ลบ `EncryptedField`, `phoneHash`, `emailHash` ออกจาก DB หลัก และลบ `PII_KEY`, `PII_PEPPER`, `SHEETS_PII_MODE` จาก env
- เพิ่ม `aiSync` ใน `customers` แบบเดียวกับ `sheetSync`
- เพิ่ม index:
  - `ix_phone`
  - `ix_email`
  - `ix_aiSyncQueue`
- ทุกจุดที่ตั้ง `sheetSync.dirty = true` จะตั้ง `aiSync.dirty = true` ด้วย
- merge ตั้ง dirty ทั้ง winner และ loser เพื่อให้ AI DB เห็น tombstone (`status:"merged"`)
- เพิ่ม internal endpoint:
- `POST /api/internal/ai-mirror/pending`
- `POST /api/internal/ai-mirror/ack`
- endpoint ทั้งคู่ใช้ HMAC + replay window ผ่าน helper เดิม
- `ack` ผูกกับ `claimId` และไม่เคลียร์ dirty ถ้า customer ถูกอัปเดตหลังถูก claim
- เพิ่ม `workflows/WF-D-ai-mirror.json`
- เพิ่ม `scripts/verify-db-users.ts` สำหรับรันมือ ไม่อยู่ใน `npm test`

## 20.3 ข้อมูลที่ส่งเข้า AI DB

ตัวอย่าง field ใน `customers_scrubbed`:

```jsonc
{
  "_id": "cus_...",
  "status": "active",
  "mergedInto": null,
  "displayName": "<PERSON_1234abcd>",
  "nickname": "<PERSON_abcd1234>",
  "fullNameEn": "<PERSON_5678abcd>",
  "phone": "08x-xxx-5678",
  "email": "so***@gmail.com",
  "phoneHash": "64 hex chars",
  "emailHash": "64 hex chars",
  "birthYear": 2535,
  "province": null,
  "customerStatus": "lead",
  "tags": ["line-follower"],
  "sources": ["line"],
  "consentMarketing": true,
  "firstInteractionAt": "2026-08-27",
  "firstMessageAt": null,
  "formSubmittedAt": "2026-08-27",
  "syncedAt": "2026-08-27T04:00:00.000Z",
  "sourceUpdatedAt": "2026-08-27T03:51:29.000Z"
}
```

ไม่ส่ง `facebook`, `instagram`, `pictureUrl`, `consent.ip`, `userAgent`, `pendingMerge`, `sheetSync`, `aiSync`, `counters`, หรือคำตอบดิบจาก `customer_profiles`

## 20.4 ผลรันจริง

วันที่รัน: 2026-08-27

Local:

```text
npm test
core: 101 passed, 27 skipped
web: 50 skipped

npm run typecheck
core/web passed

npm run build --workspace @line-crm/web
Next build passed
```

Atlas dev (`RUN_MONGO_INTEGRATION=true` + `apps/web/.env.local`):

```text
core integration: 128 passed
web integration: 50 passed
```

ตรวจ env:

```text
npm run check-env
env ครบทุกกลุ่ม
```

ตรวจ index หลัง S9:

```text
npm run create-indexes -- --verify
index ครบทุกตัว
database: line_crm_dev
```

ลบข้อมูลทดสอบเก่าตามที่ยืนยัน รอบแรก:

```json
{
  "customers": 1,
  "identities": 1,
  "customer_profiles": 1,
  "interactions": 2,
  "form_schemas": 1
}
```

หมายความว่า 4 collection หลักถูกล้างแล้ว และ `form_schemas` ยังอยู่

ล้างซ้ำหลังรัน integration รอบสุดท้าย:

```json
{
  "customers": 0,
  "identities": 0,
  "customer_profiles": 0,
  "interactions": 1,
  "form_schemas": 1
}
```

สถานะสุดท้ายหลังคำสั่งนี้: `customers`, `identities`, `customer_profiles`, `interactions` ว่าง และ `form_schemas` ยังอยู่

## 20.5 วิธีตรวจสิทธิ์ DB user

สคริปต์นี้รับ URI ตอนรันมือเท่านั้นและไม่พิมพ์ URI:

```bash
npm run verify:db-users -- \
  --app-uri "$MONGODB_URI" \
  --mirror-uri "$MONGODB_MIRROR_URI" \
  --ai-uri "$MONGODB_AI_URI" \
  --main-db line_crm_dev \
  --ai-db line_crm_ai
```

สิ่งที่ต้องผ่าน:

- `app_user` อ่าน `line_crm_dev.customers` ได้
- `app_user` อ่าน `line_crm_ai.customers_scrubbed` ไม่ได้
- `mirror_user` อ่าน `line_crm_dev.customers` ไม่ได้
- `mirror_user` เขียน `line_crm_ai.customers_scrubbed` ได้
- `ai_user` อ่าน `line_crm_dev.customers` ไม่ได้
- `ai_user` อ่าน `line_crm_ai.customers_scrubbed` ได้
- `ai_user` เขียน `line_crm_ai.customers_scrubbed` ไม่ได้

## 20.6 ก่อน deploy

ทำลำดับนี้เท่านั้น:

1. ลบ 4 collection ใน `line_crm_dev` แล้ว ห้ามลบ `form_schemas`
2. ตั้ง Vercel env ให้มี `AI_HASH_PEPPER`
3. deploy โค้ด S9
4. กรอกฟอร์มใหม่เพื่อสร้างข้อมูล plaintext
5. import/เปิด WF-D และตั้ง MongoDB credential ของ `mirror_user` ใน n8n UI
6. รัน `verify-db-users.ts` ด้วย URI ทั้ง 3 ตัว

## 20.7 ความเสี่ยงที่ยังเหลือ

- `line_crm_dev` เก็บเบอร์/อีเมลแบบ plaintext แล้ว ใครได้ `MONGODB_URI` ของ app ไปจะเห็นข้อมูลดิบทันที ต้อง rotate user เก่าที่เคยอยู่ในแชทและใช้ Specific Privileges เท่านั้น
- `WF-D-ai-mirror.json` มี placeholder credential ต้องเลือก credential `mirror_user line_crm_ai` ใน n8n UI หลัง import
- ยังไม่ได้ mirror `customer_profiles` ไป AI DB เพราะคำตอบปลายเปิดอาจมี PII ปน ต้องรอ Presidio/PII scrubber จริงก่อน
- ยังไม่ได้รัน `verify-db-users.ts` ในรอบนี้เพราะยังไม่มี `MONGODB_MIRROR_URI` และ `MONGODB_AI_URI` ใน env local
