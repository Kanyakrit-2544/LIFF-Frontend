# S11-M3 — สเปกงาน: Match Engine (จับคู่ลูกค้า LINE ↔ ประวัติซื้อ legacy)

> เอกสารนี้เป็น **สเปกสำหรับลงมือทำ** อ่านให้จบก่อนเขียนโค้ด
> อ้างอิง: [docs/20](20-s9-plaintext-ai-mirror.md) · [docs/21](21-legacy-mock-and-ai-matching.md) · [docs/22](22-s11-m2-spec.md) · [docs/23](23-s11-m2-report.md)

---

## 1. เป้าหมาย

M2 ทำให้ทั้งสองฝั่งอยู่ใน `line_crm_ai` ด้วย hash ชุดเดียวกันแล้ว (พิสูจน์แล้วว่า join ติด)
M3 คือการตอบให้ได้ว่า **"คนที่แอด LINE เข้ามาคนนี้ เคยซื้อคอร์สกับเราหรือยัง"**

```
customers_scrubbed ─┐
                    ├─► MATCH ENGINE ─► customer_links ─► (M4 analytics ใช้ต่อ)
legacy_persons_scrubbed ─┘
      ชั้น 1  phoneHash ตรง   → auto
      ชั้น 2  emailHash ตรง   → auto
      ชั้น 3  ไม่มี hash ตรง  → LLM ช่วยตัดสิน → needs_review เสมอ
```

### อยู่ในสโคป
1. `customer_links` + index
2. ชั้นจับคู่แบบ deterministic (hash) — ต้องทำงานได้เต็มที่**โดยไม่ต้องมี LLM เลย**
3. ชั้น LLM: สร้าง candidate → สกัด feature → ถาม LLM → บันทึกเป็น `needs_review`
4. `LlmProvider` แบบ OpenAI-compatible ตั้งค่าผ่าน env (ชี้ Hermes ในเครื่องตอนนี้ ชี้ VPS องค์กรทีหลัง)
5. สคริปต์ `npm run match:build` (`--dry-run` / `--verify` / `--no-llm`)
6. สคริปต์ปลูก fixture เพื่อทดสอบ (`--plant`)
7. tests

### ❌ ไม่อยู่ในสโคป — อย่าทำ
- **ห้ามทำ analytics / `insights` / การตอบคำถามภาษาไทย** — เป็นงาน M4
- **ห้ามทำหน้าจอให้พนักงานกดยืนยัน** — คนละงาน ตอนนี้แค่บันทึก `needs_review` ไว้
- **ห้าม merge ข้อมูลลูกค้าจริง** M3 สร้างแค่ "ความเชื่อมโยง" ไม่ใช่การรวมร่าง (D3, D23)
- ห้ามแตะ `line_crm_dev`, `line_crm_legacy` (อ่านได้จาก `line_crm_ai` อย่างเดียว — ดู §3.1)
- ห้ามส่งชื่อ/เบอร์/อีเมลจริงออกไปหา LLM (D28)

---

## 2. Design Decision

| # | ประเด็น | ตัดสินใจ |
|---|---|---|
| **D23** | เอา link ไปใช้ยังไง | สถิติรวมเท่านั้น · โชว์ประวัติรายบุคคลต้องมีคนกดยืนยันก่อน |
| **D28** | LLM เห็นอะไรได้บ้าง | **เห็นได้แค่ feature ที่ไม่ระบุตัวคน** — คะแนนความคล้ายของชื่อ (เลข 0–1 ที่คำนวณมาแล้ว), ช่วงอายุ, เลขท้ายเบอร์ 4 ตัว, คอร์สที่ซ้อนกัน, ระยะห่างของวันที่ · **ห้ามส่งชื่อจริงหรือ token ที่ผูกกับคนจริง** |
| **D29** | hash ตรงกับหลายคน | **ห้าม auto-link** → `needs_review` ทุกกรณี (ครอบครัวใช้เบอร์เดียวกันเป็นเรื่องปกติในชีตนี้ — เบอร์ซ้ำ 1,795 เบอร์ และมีสลิปที่จ่ายรวมกัน) |
| **D30** | ไม่มี LLM ให้ใช้ | ระบบต้องเดินต่อได้ — ชั้น 1–2 ทำงานปกติ ชั้น 3 ข้ามไปเฉย ๆ พร้อมรายงานจำนวนที่ข้าม |

### ⚠️ D28 มีเหตุผลที่ต้องเข้าใจก่อนเขียนโค้ด

Hermes ขององค์กรใช้ **ChatGPT เป็น model เบื้องหลัง** แปลว่าอะไรที่ส่งเข้าไปจะออกไปที่ผู้ให้บริการภายนอก
การส่ง "ชื่อ-นามสกุลลูกค้า" ออกไปจึงเป็นการส่ง PII ออกนอกองค์กร ซึ่งขัดกับทั้งเจตนาของ S9 และ D25

**ผลที่ตามมาที่ต้องยอมรับ**: LLM จะเทียบชื่อเองไม่ได้ (เพราะไม่เห็นชื่อ)
งานเทียบชื่อจึงต้องทำแบบ deterministic ในสคริปต์ที่เชื่อถือได้ แล้วส่งออกไปแค่ "คะแนน"
ถ้าภายหลังตัดสินใจว่าจะให้ LLM เห็นชื่อจริง ต้องเปิดเป็น decision ใหม่พร้อมเหตุผลเป็นลายลักษณ์อักษร
โครงในสเปกนี้เตรียม flag `--send-name-pairs` ไว้แต่ **ต้อง default ปิด และ throw ถ้าไม่มี env ยืนยันเจตนา**

---

## 3. งานที่ต้องทำ

### 3.1 แหล่งข้อมูล

อ่านจาก `line_crm_ai` อย่างเดียว — ทั้ง `customers_scrubbed` และ `legacy_persons_scrubbed` อยู่ที่นี่แล้ว
**ห้ามเปิด connection ไปหา `line_crm_dev` หรือ `line_crm_legacy` ในงานนี้**

ปัญหาที่ต้องแก้ให้ได้: ชื่อในทั้งสองฝั่งเป็น `<PERSON_xxxxxxxx>` แล้ว จึงเทียบความคล้ายไม่ได้
**ทางออก**: `personToken` เป็น deterministic — ชื่อที่เหมือนกันเป๊ะจะได้ token เดียวกัน
ดังนั้นชั้น deterministic เทียบได้แค่ "ชื่อตรงกันเป๊ะ" ส่วนความคล้ายแบบ fuzzy ต้องมี **feature ที่คำนวณตั้งแต่ตอน scrub**

**ต้องเพิ่มใน M3**: field `nameKeys` ในฉบับ scrub ของทั้งสองฝั่ง — เป็น hash ของชิ้นส่วนชื่อ ไม่ใช่ชื่อ

```ts
/** hash ของคำแต่ละคำในชื่อ (ตัดคำนำหน้าแล้ว) — เทียบว่ามีคำร่วมกันกี่คำได้โดยไม่เห็นชื่อ */
nameKeys: string[];      // hashValue(`NAMEPART|${word}`).slice(0, 12) ของแต่ละคำ
nicknameKey: string | null;   // hashValue(`NAMEPART|${nickname}`).slice(0, 12)
```

ทำใน `packages/core/src/ai/tokens.ts` (`nameKeys()`) แล้วเพิ่มลงทั้ง `scrubCustomer` และ `scrubLegacyPerson`
แล้ว **ต้อง re-scrub ทั้งสองฝั่ง** (`legacy:scrub --all` และ WF-D รอบใหม่) ไม่งั้น field นี้จะว่าง

> ⚠️ การเพิ่ม field ในฉบับ scrub = เปลี่ยนสัญญากับ WF-D ด้วย ให้ตรวจว่า WF-D ยังทำงานได้ (ไม่ต้องแก้ workflow ถ้ามันส่งทั้ง object อยู่แล้ว)

### 3.2 `customer_links` (อยู่ใน `line_crm_ai`)

```ts
export interface CustomerLinkDoc {
  _id: string;                    // lnk_<ULID>
  customerId: string;             // cus_…
  legacyPersonId: string;         // lgp_…
  method: "phone_hash" | "email_hash" | "llm_features";
  /** high = ยืนยันด้วยคีย์ที่ตรงกันตัวเดียว · medium/low = ต้องมีคนดู */
  confidence: "high" | "medium" | "low";
  /** 0–1 คะแนนรวมที่คำนวณได้ (deterministic) */
  score: number;
  status: "auto" | "needs_review" | "confirmed" | "rejected";
  evidence: {
    phoneHashMatch: boolean;
    emailHashMatch: boolean;
    /** จำนวนคำในชื่อที่ hash ตรงกัน */
    nameKeyOverlap: number;
    nicknameMatch: boolean;
    ageBandMatch: boolean | null;
    /** เหตุผลจาก LLM — ห้ามมีชื่อคนอยู่ในข้อความนี้ */
    llmReason?: string;
    llmModel?: string;
    /** มีคู่แข่งกี่ตัวตอนตัดสิน — >0 แปลว่ากำกวม (D29) */
    competingCandidates: number;
  };
  decidedBy: "rule" | "llm" | "staff";
  decidedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  schemaVersion: number;
}
```

**index**
- `ux_pair` = `{ customerId: 1, legacyPersonId: 1 }` **unique** — กันสร้างซ้ำเวลารันหลายรอบ
- `ix_customer` = `{ customerId: 1, status: 1 }`
- `ix_legacy` = `{ legacyPersonId: 1 }`
- `ix_status` = `{ status: 1, confidence: 1 }`

### 3.3 ชั้น 1–2 — deterministic (`packages/core/src/match/rules.ts`)

```ts
export interface MatchCandidate {
  customerId: string;
  legacyPersonId: string;
  evidence: CustomerLinkDoc["evidence"];
}

/** ตัดสินจากหลักฐานล้วน ไม่มี LLM — ต้อง pure ทดสอบได้โดยไม่ต้องต่อ DB */
export function decideByRules(c: MatchCandidate): {
  method: CustomerLinkDoc["method"];
  confidence: CustomerLinkDoc["confidence"];
  score: number;
  status: "auto" | "needs_review";
} | null;
```

กติกา (เรียงตามลำดับ):

| เงื่อนไข | ผล |
|---|---|
| `phoneHash` ตรง **และ** ฝั่งใดฝั่งหนึ่งมีคู่แข่ง >0 | `needs_review` · confidence `medium` (D29) |
| `phoneHash` ตรง แบบ 1:1 | `auto` · `high` · score 0.95 |
| `emailHash` ตรง แบบ 1:1 | `auto` · `high` · score 0.9 |
| `emailHash` ตรง แต่มีคู่แข่ง | `needs_review` · `medium` |
| ไม่มี hash ตรง แต่ `nameKeyOverlap ≥ 2` **และ** `nicknameMatch` | `needs_review` · `medium` · score 0.6 |
| ไม่มี hash ตรง และ `nameKeyOverlap ≤ 1` | คืน `null` → ส่งต่อให้ชั้น LLM |

**ห้าม auto-link ด้วยชื่ออย่างเดียวเด็ดขาด** ชื่อซ้ำกันเป็นเรื่องปกติ และ D3 มีอยู่เพราะเรื่องนี้

### 3.4 ชั้น 3 — LLM (`packages/core/src/ai/llm/`)

**`provider.ts`** — OpenAI-compatible chat completions

```ts
export interface LlmProvider {
  name: string;
  /** ต้องคืน JSON ที่ผ่าน schema แล้วเท่านั้น ถ้า parse ไม่ได้ให้ retry ตามที่กำหนด */
  complete<T>(input: { system: string; user: string; schema: ZodType<T>; maxTokens?: number }): Promise<T>;
}

export function createLlmProvider(): LlmProvider | null;  // null เมื่อไม่ได้ตั้ง env
```

env (เพิ่มใน `env.ts` เป็นกลุ่ม `llm` และทุกตัว optional — ขาดแล้วต้องไม่พังทั้งระบบ):

```
LLM_BASE_URL=http://localhost:11434/v1     # ตอนเทส · เปลี่ยนเป็น Hermes ขององค์กรทีหลัง
LLM_API_KEY=
LLM_MODEL=
LLM_TIMEOUT_MS=20000
LLM_MAX_RETRIES=2
```

**สิ่งที่ส่งให้ LLM ได้ (D28) — เท่านี้เท่านั้น**

```jsonc
{
  "pairId": "p1",                    // ตัวอ้างอิงชั่วคราวในรอบนี้ ไม่ผูกกับ id จริง
  "nameKeyOverlap": 1,
  "nameKeyTotalA": 2,
  "nameKeyTotalB": 3,
  "nicknameMatch": false,
  "ageBandMatch": true,
  "phoneLast4Match": true,           // เลขท้าย 4 ตัวตรงกันไหม (จากค่า mask ที่มีอยู่แล้ว)
  "emailDomainMatch": true,
  "courseOverlap": 0,
  "daysBetweenFirstSeen": 412
}
```

**ห้ามส่ง**: `customerId`, `legacyPersonId`, `<PERSON_…>` token, เบอร์ mask เต็ม ๆ, อีเมล mask, ข้อความไทยใด ๆ จากข้อมูลลูกค้า

**สิ่งที่ LLM ต้องคืน** (validate ด้วย zod ก่อนใช้ ถ้าไม่ผ่านให้ retry แล้วถือว่า `unsure`)

```ts
z.object({
  pairId: z.string(),
  decision: z.enum(["same", "different", "unsure"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(200),   // ต้องไม่มีชื่อคน — มีแค่ feature ให้อ้างอยู่แล้ว
})
```

**ผลลัพธ์เข้า `customer_links` เป็น `needs_review` เสมอ** ไม่ว่า LLM มั่นใจแค่ไหน
`decision: "different"` → ไม่สร้าง link · `"unsure"` → ไม่สร้าง link แต่ต้องนับไว้ในรายงาน

ส่งเป็น batch (แนะนำ 20 คู่ต่อ request) และ **ห้ามให้ LLM เห็นข้อมูลข้ามรอบ** (ไม่มี conversation history)

### 3.5 สคริปต์ `scripts/build-matches.ts`

```bash
npm run match:build -- --ai-uri "<uri>" --ai-db line_crm_ai            # ชั้น 1–3
npm run match:build -- --no-llm                                        # ชั้น 1–2 อย่างเดียว (D30)
npm run match:build -- --dry-run                                       # คำนวณ ไม่เขียน DB
npm run match:build -- --verify                                        # รายงานอย่างเดียว
npm run match:build -- --plant 25                                      # ปลูก fixture สำหรับทดสอบ (§3.6)
```

ขั้นตอน:
1. โหลด `phoneHash` / `emailHash` ของทั้งสองฝั่งเป็น Map แล้วหา candidate (ห้ามใช้ `$lookup` ข้าม collection ขนาดใหญ่ — ทำในหน่วยความจำแล้ววัดเวลาไว้)
2. นับคู่แข่งของแต่ละฝั่งก่อนตัดสิน (D29)
3. `decideByRules` → ได้ผลก็เขียน link
4. ที่เหลือ (`null`) → ทำ feature → ถ้ามี LLM ก็ถาม เป็น batch
5. เขียนด้วย `bulkWrite` upsert ที่ `{customerId, legacyPersonId}` — **รันซ้ำต้องไม่เกิด link ซ้ำ**
6. **ห้ามทับ link ที่ `status` เป็น `confirmed` หรือ `rejected`** (คนตัดสินแล้ว เครื่องห้ามเปลี่ยน)

**รายงานตอนจบ** ต้องพิมพ์:
```text
customers 1,240 · legacy persons 1,550
ชั้น 1 phoneHash : auto 118 · needs_review 12 (มีคู่แข่ง)
ชั้น 2 emailHash : auto 34  · needs_review 3
ชั้น 3 LLM       : ถาม 96 คู่ · same 21 · different 63 · unsure 12 · ข้าม 0
รวม link ใหม่ 188 · อัปเดต 4 · ไม่แตะของที่คนตัดสินแล้ว 7
เวลา 4.2 วิ
```

### 3.6 fixture สำหรับทดสอบ (`--plant N`)

ข้อมูล legacy เป็น synthetic จึงไม่มีทางตรงกับลูกค้า LINE จริง — ถ้าไม่ปลูก fixture จะวัดอะไรไม่ได้เลย

`--plant N` ต้อง (และเขียนลง **AI DB ที่ระบุเท่านั้น** ห้ามแตะฐาน production):
- หยิบ legacy person N คน แล้วสร้าง doc ใน `customers_scrubbed` ที่มี `phoneHash` เดียวกัน (`_id` ขึ้นต้น `cus_PLANT_`)
- สร้างเคสยาก ๆ ให้ครบ: 3 คนใช้ `phoneHash` เดียวกัน (ครอบครัว) · ตรงเฉพาะ email · ชื่อคล้ายแต่ไม่มี hash ตรง · ไม่ตรงอะไรเลย
- มี `--unplant` ลบทิ้งได้หมด (ลบทุก doc ที่ `_id` ขึ้นต้น `cus_PLANT_` และ link ที่เกี่ยวข้อง)

---

## 4. Tests

### 4.1 Unit — `packages/core/tests/matchRules.test.ts`
- ⭐ phoneHash ตรง 1:1 → `auto` / `high`
- ⭐ phoneHash ตรงแต่มีคู่แข่ง → `needs_review` **ห้ามเป็น auto** (D29)
- emailHash ตรง 1:1 → `auto` · มีคู่แข่ง → `needs_review`
- ⭐ ชื่อคล้ายอย่างเดียว (ไม่มี hash ตรง) → **ห้าม auto ไม่ว่ากรณีใด**
- `nameKeyOverlap ≤ 1` และไม่มี hash → คืน `null` (ส่งต่อชั้น LLM)
- score อยู่ในช่วง 0–1 เสมอ

### 4.2 Unit — `packages/core/tests/llmMatch.test.ts` (ใช้ provider ปลอม ไม่ยิงเน็ตจริง)
- ⭐ payload ที่ส่งออกต้อง **ไม่มี** `customerId`, `legacyPersonId`, `<PERSON_`, อักษรไทย, `@`, หรือเลข 9–10 หลักติดกัน (assert ด้วย regex บน `JSON.stringify`)
- LLM ตอบ JSON เพี้ยน → retry แล้วสุดท้ายเป็น `unsure` ไม่ throw
- LLM ตอบ `same` ด้วย confidence 0.99 → ยังต้องเป็น `needs_review` (ไม่มีทางเป็น auto)
- LLM timeout → ไม่ทำให้ทั้ง batch ล้ม
- `createLlmProvider()` คืน `null` เมื่อไม่ตั้ง env และสคริปต์ยังเดินต่อได้ (D30)

### 4.3 Integration (`RUN_MONGO_INTEGRATION=true`)
- ปลูก fixture → รัน → จำนวน link ตรงกับที่ปลูกไว้
- รันซ้ำ → จำนวน link เท่าเดิม (unique index ทำงาน)
- link ที่ `status: "confirmed"` ไม่ถูกทับเมื่อรันใหม่
- ครอบครัว 3 คนใช้เบอร์เดียวกัน → ได้ `needs_review` ทั้งหมด ไม่มี `auto` แม้แต่ตัวเดียว

### 4.4 รันจริงก่อนบอกว่าเสร็จ
```bash
npm run db:test:up
npx tsx scripts/generate-legacy-mock.ts --uri "mongodb://localhost:27018/?directConnection=true" --db line_crm_legacy --drop
npm run legacy:scrub -- --legacy-uri "…" --ai-uri "…" --ai-db line_crm_ai_test --all --prune
npm run match:build -- --ai-uri "…" --ai-db line_crm_ai_test --plant 25
npm run match:build -- --ai-uri "…" --ai-db line_crm_ai_test --no-llm
npm run match:build -- --ai-uri "…" --ai-db line_crm_ai_test --verify
RUN_MONGO_INTEGRATION=true npm test
```
ถ้าต่อ LLM ได้จริง ให้รันโหมดมี LLM แล้วแปะผลมาด้วย ถ้าต่อไม่ได้ ให้บอกตรง ๆ ว่าทดสอบด้วย provider ปลอมอย่างเดียว

---

## 5. เกณฑ์ผ่านงาน

- [ ] `RUN_MONGO_INTEGRATION=true npm test` ผ่านหมด **skipped = 0** (ฐานปัจจุบัน core 185 · web 50)
- [ ] `npm run typecheck` ผ่าน (รวม `typecheck:scripts`)
- [ ] ชั้น 1–2 ทำงานได้เต็มที่ด้วย `--no-llm` — ไม่มีที่ไหนใน code path นี้เรียก LLM
- [ ] ไม่มี `auto` link ที่เกิดจากชื่ออย่างเดียว หรือจาก hash ที่ตรงกับหลายคน
- [ ] test payload ยืนยันว่าไม่มี PII หลุดไปหา LLM
- [ ] รันซ้ำแล้ว link ไม่ซ้ำ และของที่คนตัดสินแล้วไม่ถูกทับ
- [ ] `--plant 25 → --verify` รายงานตัวเลขที่ตรงกับที่ปลูก
- [ ] เขียน `docs/25-s11-m3-report.md` พร้อม **ผลรันจริงที่ copy จาก terminal**

---

## 6. ข้อมูลที่ยังไม่มี — ทำงานให้ได้โดยไม่ต้องรอ

| ยังไม่มี | ทำยังไงระหว่างนี้ |
|---|---|
| endpoint ของ Hermes องค์กร | ใช้ `LLM_BASE_URL` ชี้ Ollama ในเครื่อง (`http://localhost:11434/v1`) หรือ provider ปลอมใน test |
| ลูกค้า LINE จริงให้จับคู่ | ใช้ `--plant` เท่านั้น — **ห้ามเอาข้อมูลลูกค้าจริงมาทดสอบ** |
| หน้าจอให้พนักงานกดยืนยัน | ยังไม่ทำ แค่ทิ้ง `needs_review` ไว้ให้ M-later |

---

## 7. เอกสารที่ต้องอัปเดตเมื่อทำเสร็จ

- `docs/25-s11-m3-report.md` (ใหม่) — ผลรันจริง + จำนวนที่ LLM ถูกถาม/ถูกข้าม
- `README.md` — index + D28–D30
- `HANDOFF.md` — สถานะ + คำสั่งใหม่
- `.env.example` — กลุ่ม `LLM_*`

---

## 8. กฎที่ห้ามละเมิด

1. **ห้ามส่งชื่อ/เบอร์/อีเมล/token ที่ผูกกับคนจริง ออกไปหา LLM** (D28) — Hermes ใช้ ChatGPT เบื้องหลัง ข้อมูลออกนอกองค์กร
2. **ห้าม auto-link จากชื่อ** และ **ห้าม auto-link เมื่อ hash ตรงกับหลายคน** (D29)
3. **LLM ไม่มีสิทธิ์ตัดสินขั้นสุดท้าย** ผลจาก LLM = `needs_review` เสมอ
4. **ระบบต้องเดินได้โดยไม่มี LLM** (D30)
5. **ห้ามทับ link ที่คนตัดสินแล้ว** (`confirmed` / `rejected`)
6. ห้ามเปลี่ยน `AI_HASH_PEPPER` · ห้าม copy สูตร hash ไปเขียนซ้ำ ใช้ `ai/tokens.ts` ที่เดียว
7. ห้ามเขียนอะไรลง `line_crm_dev` หรือ `line_crm_legacy`
8. ห้ามลด/ปิด test เดิม
9. business logic อยู่ใน `packages/core` สคริปต์เป็นแค่ตัวต่อสาย

---

## 9. สิ่งที่มีอยู่แล้ว ใช้ซ้ำได้เลย อย่าเขียนใหม่

| ของที่มี | ที่อยู่ |
|---|---|
| `personToken` · `phoneHash` · `emailHash` · `ageBand` · `slipGroupId` | `packages/core/src/ai/tokens.ts` |
| ฉบับ scrub ทั้งสองฝั่ง + ชื่อ collection | `packages/core/src/ai/scrubLegacy.ts` · `db/models.ts` (`AI_COLLECTIONS`) |
| แบบอย่างการสร้าง index | `packages/core/src/ai/indexes.ts` |
| แบบอย่างสคริปต์ (arg parsing, exit code, ไม่พิมพ์ URI) | `scripts/scrub-legacy.ts` |
| ตัวสร้างข้อมูลทดสอบ | `generateLegacy({ scale })` |
| แบบอย่าง env เป็นกลุ่ม + optional | `packages/core/src/env.ts` |
