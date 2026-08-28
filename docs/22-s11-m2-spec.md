# S11-M2 — สเปกงาน: scrub ฐาน legacy เข้า `line_crm_ai`

> เอกสารนี้เป็น **สเปกสำหรับลงมือทำ** อ่านให้จบก่อนเขียนโค้ด
> อ้างอิง: [docs/09](09-pii-service.md) · [docs/20](20-s9-plaintext-ai-mirror.md) · [docs/21](21-legacy-mock-and-ai-matching.md)

---

## 1. เป้าหมาย

M1 สร้างฐาน `line_crm_legacy` (synthetic) เสร็จแล้ว — มีคน 1,550 การชำระ 2,017 รายการคอร์ส 2,239
**แต่ AI ยังมองไม่เห็นข้อมูลนี้** เพราะฐาน legacy เป็น plaintext และอยู่คนละ database กับ `line_crm_ai`

M2 คือการทำสำเนาที่ scrub แล้วเข้า `line_crm_ai` **โดยใช้ pepper ตัวเดียวกับฝั่งลูกค้า LINE**
เพื่อให้ M3 เอา `phoneHash` มา join ตรง ๆ ได้ว่าคนใน legacy กับลูกค้า LINE เป็นคนเดียวกันไหม

```
line_crm_legacy (plaintext)                     line_crm_ai
  legacy_persons      ──scrub──►  legacy_persons_scrubbed      ┐
  legacy_payments     ──scrub──►  legacy_payments_scrubbed     │ join ด้วย phoneHash / emailHash
  legacy_enrollments  ──scrub──►  legacy_enrollments_scrubbed  │
                                  customers_scrubbed (มีอยู่แล้ว จาก WF-D) ┘
```

### อยู่ในสโคป
1. แยก helper การทำ token/hash ออกมาใช้ร่วมกัน (ห้าม copy-paste)
2. `scrubLegacy.ts` — แปลง person / payment / enrollment เป็นฉบับ scrub
3. `safeSessionLabel()` — กันชื่อคนที่ฝังอยู่ในป้ายรอบเรียนหลุดออกไป
4. field `aiSync` ใน 3 collection ของ legacy + index คิว
5. index ฝั่ง `line_crm_ai` สำหรับ join
6. สคริปต์ `npm run legacy:scrub` (claim → scrub → เขียน → ack) + โหมด `--verify`
7. tests

### ❌ ไม่อยู่ในสโคป — อย่าทำ
- **ห้ามใช้ LLM / AI ใด ๆ ในงานนี้** M2 เป็นงาน deterministic ล้วน (AI เริ่มที่ M3)
- **ห้ามทำ match engine หรือ `customer_links`** — เป็นงาน M3
- ห้ามแตะ `line_crm_dev`, WF-A/C/D, Google Sheets, LIFF
- ห้ามสร้าง n8n workflow ใหม่ (ดู D24)
- ห้าม import ข้อมูลจริงจาก `Inner.xlsx` (ยังใช้ synthetic เท่านั้น)

---

## 2. Design Decision

| # | ประเด็น | ตัดสินใจ |
|---|---|---|
| **D23** | เอา link ไปใช้ยังไง | สถิติรวมเท่านั้น — โชว์ประวัติรายบุคคลต้องมีคนกดยืนยัน (docs/21) |
| **D24** | legacy scrub เดินด้วยอะไร | **สคริปต์ ไม่ใช่ n8n** — legacy เป็นข้อมูล batch ที่นิ่ง ไม่มีคนแก้ระหว่างวัน การตั้ง cron ทุก 10 นาทีไม่ได้ประโยชน์ แต่ยังทำ `aiSync` แบบเดียวกับ `customers` ไว้ ถ้าวันหลังอยากย้ายไป n8n จะย้ายได้โดยไม่ต้องแก้ core |
| **D25** | `raw` ของเซลล์คอร์ส | **ห้ามออกจาก `line_crm_legacy`** — มีชื่อคนจริงฝังอยู่ (`13-14 Jun คุณ<ชื่อ> เรียนแทน`) |
| **D26** | อายุใน AI DB | ส่งเป็น **ช่วง 10 ปี** (`"30-39"`) ไม่ส่งตัวเลขตรง — legacy ไม่มี consent ผ่านระบบนี้ และ analytics ใช้แค่ช่วงก็พอ |
| **D27** | เลขสลิป | **ไม่ส่งเลขจริง** ส่ง `slipGroupId` (hash 12 ตัว) แทน — ยังจับกลุ่ม "จ่ายรวมกัน" ได้โดยไม่เปิดเลขเอกสาร |

---

## 3. งานที่ต้องทำ

### 3.1 แยก helper hash/token ออกมาใช้ร่วมกัน

**ปัญหา**: ตอนนี้ `personToken()` ซ่อนอยู่ใน `packages/core/src/ai/scrubCustomer.ts` ถ้า M2 copy สูตรไปเขียนใหม่
วันหนึ่งมีคนแก้ฝั่งเดียว → hash คนละชุด → **join พังเงียบ ๆ ไม่มี error ให้เห็น**

**สร้าง `packages/core/src/ai/tokens.ts`** ย้าย logic เดิมมา ห้ามเปลี่ยนค่าที่ได้แม้แต่ตัวเดียว

```ts
/** <PERSON_xxxxxxxx> — ค่าเดิมได้ token เดิมเสมอ */
export function personToken(value: string | null | undefined): string | null;

/** hash เบอร์ — input ต้องเป็น E.164 ที่ผ่าน normalizePhone แล้ว */
export function phoneHash(e164: string | null | undefined): string | null;

/** hash อีเมล — lowercase ก่อนเสมอ */
export function emailHash(email: string | null | undefined): string | null;

/** ช่วงอายุ 10 ปี: 34 → "30-39" (D26) */
export function ageBand(age: number | null | undefined): string | null;

/** จับกลุ่มสลิปโดยไม่เปิดเลขจริง (D27) */
export function slipGroupId(slipNo: string | null | undefined): string | null;
```

สูตรที่ต้องคงไว้เป๊ะ (ค่าปัจจุบันของระบบ — เปลี่ยนเมื่อไร ข้อมูลใน AI DB ที่ sync ไปแล้วจะ join ไม่ติด):

| ฟังก์ชัน | input ที่ป้อนเข้า `hashValue()` |
|---|---|
| `personToken` | `` `PERSON|${trim + ยุบช่องว่าง + toLocaleLowerCase("th-TH")}` `` แล้วตัด 8 ตัวแรก ครอบด้วย `<PERSON_…>` |
| `phoneHash` | `` `PHONE|${e164}` `` |
| `emailHash` | `` `EMAIL|${email.toLowerCase()}` `` |
| `slipGroupId` | `` `SLIP|${slipNo.trim().toUpperCase()}` `` แล้วตัด 12 ตัวแรก |

แล้วแก้ `scrubCustomer.ts` ให้เรียก helper ตัวนี้แทนของเดิม — **test เดิมของ `scrubCustomer` ต้องผ่านโดยไม่ต้องแก้ค่าที่คาดหวัง**

### 3.2 `packages/core/src/ai/scrubLegacy.ts`

```ts
export interface ScrubbedLegacyPerson {
  _id: string;                    // lgp_… คงเดิม ใช้ join กลับฐาน legacy
  fullNameTh: string | null;      // <PERSON_…>
  fullNameEn: string | null;      // <PERSON_…>
  nickname: string | null;        // <PERSON_…>
  phone: string | null;           // maskPhone → "08x-xxx-5678"
  email: string | null;           // maskEmail → "so***@gmail.com"
  phoneHash: string | null;
  emailHash: string | null;
  ageBand: string | null;         // D26
  firstPaidAt: string | null;     // "YYYY-MM-DD"
  lastPaidAt: string | null;
  totalPaid: number;
  paymentCount: number;
  seatCount: number;
  courseCodes: string[];
  yearsActive: number[];          // ปีที่มีการชำระ เรียงจากน้อยไปมาก
  synthetic: boolean;
  syncedAt: string;               // ISO
  sourceUpdatedAt: string | null; // ISO
}

export interface ScrubbedLegacyPayment {
  _id: string;
  personId: string;
  slipGroupId: string | null;     // D27 — ไม่ใช่เลขสลิปจริง
  slipShared: boolean;
  amount: number | null;
  paidAt: string | null;          // "YYYY-MM-DD"
  year: number;
  month: number | null;           // 1–12 ไว้ทำสถิติรายเดือนโดยไม่ต้อง parse
  saleRep: string | null;         // รหัสพนักงาน ไม่ใช่ข้อมูลลูกค้า → ส่งได้
  synthetic: boolean;
  syncedAt: string;
}

export interface ScrubbedLegacyEnrollment {
  _id: string;
  personId: string;
  paymentId: string;
  courseCode: string;
  kind: EnrollmentKind;
  countsAsSeat: boolean;
  sessionLabel: string | null;    // ผ่าน safeSessionLabel()
  sessionStart: string | null;    // "YYYY-MM-DD"
  sessionYear: number | null;
  sessionPrecision: "day" | "month" | "none";
  substitute: boolean;
  synthetic: boolean;
  syncedAt: string;
}
```

**ห้ามส่งออกไปเด็ดขาด**: `raw` (D25) · `socialHandle` (เป็น handle ที่ค้นเจอตัวคนได้) · `sourceRefs` (ชี้แถวในไฟล์ต้นทาง) · `slipNo` · `ageAtImport` · `courseLabel` (ใช้ `courseCode` แทน)

### 3.3 `safeSessionLabel()` — อยู่ใน `scrubLegacy.ts`

ป้ายรอบเรียนบางช่องมีชื่อคนจริง `parseCourseCell` ตัดออกไปรอบหนึ่งแล้ว แต่ห้ามพึ่งชั้นเดียว

```ts
const SAFE_TH = ["หนังสือ","ห้องพัก","พักเดี่ยว","คืนเงิน","ค่าปรับ","ย้ายเรียน","ย้ายไป",
                 "เพิ่ม","เลื่อน","ตัดสิทธิ","ผ้าคลุม","เรียนแทน","ปรับ","เปลี่ยนเป็น","สิทธิ","คน"];

/** ถ้ายังเหลืออักษรไทยที่ไม่ใช่ศัพท์ธุรกิจ = อาจเป็นชื่อคน → คืน "«ข้อความอื่น»" */
export function safeSessionLabel(label: string | null): string | null;
```

ตรรกะ: ตัดคำใน `SAFE_TH` ออกจากข้อความชั่วคราว ถ้าที่เหลือยังมีอักษรไทย (ช่วง `฀-๿`) → คืน `"«ข้อความอื่น»"` ไม่งั้นคืนป้ายเดิม
วิธีเดียวกับที่ `scripts/legacy/profile_xlsx.py` ใช้ตอนทำ `profile.json` — ให้ผลตรงกัน

### 3.4 `aiSync` ใน 3 collection ของ legacy

เพิ่มลง `LegacyPersonDoc` / `LegacyPaymentDoc` / `LegacyEnrollmentDoc` รูปแบบเดียวกับ `CustomerDoc.aiSync`

```ts
aiSync: {
  dirty: boolean;        // ตอน generate ให้ตั้ง true
  syncedAt: Date | null;
  lockedAt: Date | null;
  attempts: number;
  claimId?: string;
};
```

- `generate.ts` ต้องใส่ `aiSync: { dirty: true, syncedAt: null, lockedAt: null, attempts: 0 }` ให้ทุก doc
- เพิ่ม index `ix_aiSyncQueue` = `{ "aiSync.dirty": 1, "aiSync.lockedAt": 1 }` ทั้ง 3 collection ใน `legacy/indexes.ts`
- ตรรกะ claim/ack **ให้ลอกพฤติกรรมจาก `packages/core/src/ai/aiMirror.ts`**: lease 5 นาที · `MAX_ATTEMPTS = 5` · ปลด lock ที่ค้างเกิน lease · ack ต้องผูก `claimId`
  เขียนเป็นฟังก์ชัน generic ใน `packages/core/src/legacy/aiQueue.ts` ที่รับชื่อ collection เข้าไป

### 3.5 สคริปต์ `scripts/scrub-legacy.ts`

```bash
npm run legacy:scrub -- --legacy-uri "<uri>" --ai-uri "<uri>"      # sync เฉพาะที่ dirty
npm run legacy:scrub -- --all                                       # ตั้ง dirty ใหม่ทั้งหมดแล้ว sync
npm run legacy:scrub -- --verify                                    # ไม่เขียนอะไร รายงานอย่างเดียว
npm run legacy:scrub -- --batch 500
npm run legacy:scrub -- --prune                                     # ลบของกำพร้าฝั่ง AI ที่ต้นทางไม่มีแล้ว
```

- `--legacy-uri` ← `LEGACY_MONGODB_URI` · `--ai-uri` ← `MONGODB_MIRROR_URI`
  **ห้ามใช้ `MONGODB_URI` (app_user) เขียน AI DB** — app_user มีสิทธิ์เฉพาะ `line_crm_dev`
- ทำงานเป็นรอบ: claim → scrub → `bulkWrite` upsert ลง AI DB → ack → วนจนไม่มี dirty
- upsert ด้วย `_id` (ULID ของเรา) — **ห้ามให้ driver cast เป็น ObjectId** (บทเรียนจาก WF-C)
- สคริปต์ **ห้ามเขียนอะไรลง `line_crm_dev`** แม้แต่ log
- ปิด client ทุกเส้นใน `finally` เสมอ

**`--verify` ต้องพิมพ์:**
```text
legacy_persons        1550  → scrubbed 1550   dirty เหลือ 0
legacy_payments       2017  → scrubbed 2017   dirty เหลือ 0
legacy_enrollments    2239  → scrubbed 2239   dirty เหลือ 0
ตรวจ PII ในฉบับ scrub: ไม่พบเบอร์เต็ม / อีเมลเต็ม / raw / socialHandle  ✅
join ได้กับ customers_scrubbed: phoneHash ตรงกัน N คน · emailHash ตรงกัน M คน
```
บรรทัดสุดท้ายคือของที่ M3 จะใช้ต่อ — ข้อมูล legacy เป็น synthetic จึงคาดว่า **N = 0** ถือว่าถูกต้อง ไม่ใช่บั๊ก

### 3.6 index ฝั่ง `line_crm_ai`

เพิ่มใน `AI_COLLECTIONS` (`packages/core/src/db/models.ts`) และสร้าง index:

| collection | index |
|---|---|
| `legacy_persons_scrubbed` | `ix_phoneHash {phoneHash:1}` sparse · `ix_emailHash {emailHash:1}` sparse · `ix_lastPaid {lastPaidAt:-1}` |
| `legacy_payments_scrubbed` | `ix_person {personId:1}` · `ix_yearMonth {year:1,month:1}` |
| `legacy_enrollments_scrubbed` | `ix_courseSession {courseCode:1,sessionStart:1,countsAsSeat:1}` · `ix_person {personId:1}` |

`customers_scrubbed` ต้องมี `ix_phoneHash` / `ix_emailHash` ด้วย — ถ้ายังไม่มีให้เพิ่ม (M3 จะ join ด้วยคีย์นี้)

---

## 4. Tests

### 4.1 Unit (`packages/core/tests/`) — ไม่ต้องใช้ Mongo

**`tokens.test.ts`**
- ⭐ `phoneHash("+66812345678")` ต้องได้ค่าเดียวกับที่ `scrubCustomer` เคยให้ (ยึด test เดิมของ `scrubCustomer` เป็นฐาน)
- ⭐ **hash parity**: person ใน legacy กับ customer ใน LINE ที่มีเบอร์เดียวกัน → `phoneHash` ต้องเท่ากันเป๊ะ (นี่คือหัวใจของ M3 ถ้าข้อนี้พัง งานทั้ง M3 ใช้ไม่ได้)
- เบอร์เขียนต่างกัน `081-234-5678` / `+66812345678` → normalize แล้ว hash ต้องเท่ากัน
- อีเมลตัวพิมพ์ใหญ่/เล็กต่างกัน → hash เท่ากัน
- `ageBand(34)` = `"30-39"` · `ageBand(null)` = `null` · `ageBand(9)` / `ageBand(120)` = `null`
- `slipGroupId` ค่าเดิมได้ค่าเดิม และไม่มีเลขสลิปจริงอยู่ในผลลัพธ์

**`scrubLegacy.test.ts`**
- ⭐ ผลลัพธ์ต้อง **ไม่มี** key: `raw`, `socialHandle`, `sourceRefs`, `slipNo`, `ageAtImport`, `courseLabel`
- ⭐ ชื่อทุกช่องกลายเป็น `<PERSON_…>` — `JSON.stringify(scrubbed)` ต้องไม่มีชื่อเดิมโผล่
- เบอร์ถูก mask (`08x-xxx-5678`) และอีเมลถูก mask
- `safeSessionLabel("13-14 Jun คุณสมชาย ใจดี เรียนแทน")` → `"«ข้อความอื่น»"`
- `safeSessionLabel("ย้ายเรียน Camp")` → คงเดิม (ศัพท์ธุรกิจ ไม่ใช่ชื่อคน)
- `safeSessionLabel("27-28 Jun")` → คงเดิม
- ชุดข้อมูลจาก `generateLegacy({scale:0.05})` → scrub ทั้งชุด แล้ว regex ทั้งก้อนต้องไม่เจอ `/0[689]\d{8}/` และไม่เจอ `/[ก-๙]{2,}\s[ก-๙]{2,}/` ที่ไม่ได้อยู่ใน SAFE_TH
- `synthetic: true` ติดมาครบทุก doc

**`legacyAiQueue.test.ts`** (ส่วน pure)
- ack ที่ `claimId` ไม่ตรง ต้องไม่เคลียร์ dirty
- `attempts` ครบ 5 → ไม่ถูก claim อีก

### 4.2 Integration (`RUN_MONGO_INTEGRATION=true`)
- claim → ack ครบรอบ: dirty เหลือ 0
- claim ซ้อนกัน 2 รอบ ไม่ได้ doc ทับกัน
- lock ค้างเกิน 5 นาที ถูกปลดแล้ว claim ใหม่ได้
- รันสคริปต์ซ้ำ 2 ครั้งติด → จำนวน doc ใน AI DB เท่าเดิม (idempotent ด้วย upsert `_id`)

### 4.3 รันจริงก่อนบอกว่าเสร็จ
```bash
npm run db:test:up
npx tsx scripts/generate-legacy-mock.ts --uri "mongodb://localhost:27018/?directConnection=true" --db line_crm_legacy --drop
npm run legacy:scrub -- --legacy-uri "mongodb://localhost:27018/?directConnection=true" --ai-uri "mongodb://localhost:27018/?directConnection=true" --ai-db line_crm_ai_test
npm run legacy:scrub -- ... --verify
RUN_MONGO_INTEGRATION=true npm test
```

---

## 5. เกณฑ์ผ่านงาน

- [ ] `RUN_MONGO_INTEGRATION=true npm test` ผ่านหมด **skipped = 0** (ฐานปัจจุบัน core 167 · web 50 — ต้องไม่น้อยกว่านี้)
- [ ] `npm run typecheck` ผ่านทั้ง core และ web
- [ ] `npm run legacy:scrub -- --verify` รายงานว่า scrub ครบ 1550 / 2017 / 2239 และ dirty เหลือ 0
- [ ] ไม่มี `raw` / `socialHandle` / `slipNo` / เบอร์เต็ม / อีเมลเต็ม ใน `line_crm_ai` แม้แต่ doc เดียว
- [ ] test hash parity ผ่าน (legacy กับ LINE เบอร์เดียวกัน → hash เท่ากัน)
- [ ] รันสคริปต์ซ้ำแล้วจำนวน doc ไม่เพิ่ม
- [ ] test เดิมของ `scrubCustomer` ผ่านโดยไม่ได้แก้ค่าที่คาดหวัง (พิสูจน์ว่า refactor ไม่เปลี่ยน hash)
- [ ] เขียน `docs/23-s11-m2-report.md` พร้อม **ผลรันจริงที่ copy มาจาก terminal** ไม่ใช่สรุปลอย ๆ

---

## 6. ข้อมูลที่ยังไม่มี — ทำงานให้ได้โดยไม่ต้องรอ

| ยังไม่มี | ทำยังไงระหว่างนี้ |
|---|---|
| Mongo user `legacy_user` บน Atlas | รันทุกอย่างบน Mongo local `:27018` ให้จบก่อน |
| `MONGODB_MIRROR_URI` ในเครื่อง | ใช้ URI local เดียวกัน ชี้คนละ dbName (`line_crm_ai_test`) |
| ข้อมูลลูกค้า LINE จริงให้ join | ไม่ต้องรอ — `N = 0` ถือว่าถูกต้องสำหรับข้อมูล synthetic |

---

## 7. เอกสารที่ต้องอัปเดตเมื่อทำเสร็จ

- `docs/23-s11-m2-report.md` (ใหม่) — ผลรันจริง
- `README.md` — เพิ่มบรรทัด index + D24–D27 ลงตาราง design decision
- `HANDOFF.md` — อัปเดตสถานะ M2
- `.env.example` — เพิ่ม `LEGACY_MONGODB_URI`, `LEGACY_MONGODB_DB`, `AI_MONGODB_DB`

---

## 8. กฎที่ห้ามละเมิด

1. **ห้ามเปลี่ยน `AI_HASH_PEPPER`** — hash ที่ sync ไปแล้วจะ join ไม่ติดทันที
2. **ห้าม copy สูตร hash/token ไปเขียนซ้ำ** ต้องเรียกจาก `tokens.ts` ที่เดียว
3. **ห้ามส่ง `raw` ออกจาก `line_crm_legacy`** (D25) — มีชื่อคนจริงอยู่ข้างใน
4. **ห้ามใช้ LLM ในงานนี้** M2 ต้อง deterministic 100% รันกี่ครั้งก็ได้ผลเดิม
5. **ห้ามเขียนอะไรลง `line_crm_dev`** จากสคริปต์นี้
6. **ห้าม log PII** — `logger.ts` redact อยู่แล้ว อย่าปิด
7. **ห้ามลด/ปิด test เดิม** พังเพราะพฤติกรรมเปลี่ยนให้แก้ให้ตรงพร้อมอธิบายเหตุผล
8. business logic อยู่ใน `packages/core` — สคริปต์เป็นแค่ตัวต่อสาย

---

## 9. สิ่งที่มีอยู่แล้ว ใช้ซ้ำได้เลย อย่าเขียนใหม่

| ของที่มี | ที่อยู่ |
|---|---|
| `hashValue` · `maskPhone` · `maskEmail` | `packages/core/src/security/pii.ts` |
| `personToken` (ย้ายออกมาใน 3.1) | `packages/core/src/ai/scrubCustomer.ts` |
| ตรรกะ claim/ack/lease/attempts | `packages/core/src/ai/aiMirror.ts` |
| `normalizePhone` · `normalizeEmail` | `packages/core/src/identity/normalize.ts` |
| โครง doc + `EnrollmentKind` | `packages/core/src/legacy/models.ts` · `courseCell.ts` |
| ตัวสร้างข้อมูลทดสอบ | `generateLegacy({ scale })` ใน `packages/core/src/legacy/generate.ts` |
| แบบอย่างสคริปต์ (arg parsing, ไม่พิมพ์ URI) | `scripts/verify-db-users.ts` |
| รายการคำไทยที่ปลอดภัย | `scripts/legacy/profile_xlsx.py` → `SAFE_TH` |
