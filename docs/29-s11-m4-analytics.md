# S11-M4 — สเปกงาน: Analytics + `insights` (ให้ AI ตอบคำถามธุรกิจ)

> เอกสารนี้เป็น **สเปกสำหรับลงมือทำ** อ่านให้จบก่อนเขียนโค้ด
> อ้างอิง: [docs/21](21-legacy-mock-and-ai-matching.md) · [docs/24](24-s11-m3-spec.md) · [docs/26](26-purchase-intake-contract.md) · [docs/28](28-s11-m6-facebook-lead.md)

---

## 1. เป้าหมาย

ทุกท่อเข้าครบแล้ว (LIFF · legacy · ระบบ tag · Facebook Lead) แต่**ยังไม่มีใครถามข้อมูลได้**
M4 คือชั้นที่ตอบคำถามจริงของเจ้าของธุรกิจ

| คำถามที่ต้องตอบได้ | ใช้ข้อมูลจาก |
|---|---|
| สัปดาห์ที่ผ่านมาขายอะไรได้บ้าง อย่างละเท่าไร | `purchases` + `purchase_items` |
| เดือนนี้ลูกค้าใหม่กี่คน เก่ากี่คน | `purchases` + `legacy_payments` + `customer_links` |
| ลูกค้ามาจากช่องทางไหน | `customers.heardFrom` |
| มาจาก content ไหน ยิงแอดหรือ organic | `leadAttribution` |
| คอร์ส Inner ไตรมาสที่แล้วขายได้กี่ที่นั่ง | `purchase_items` + `legacy_enrollments` |
| เซลคนไหนปิดยอดได้เท่าไร | `purchases.saleRep` |
| คนที่เคยลังเลเพราะงบ สุดท้ายซื้อกี่คน | `customer_intents` + `purchases` |

### อยู่ในสโคป
1. งานที่ต้องทำก่อน (§3) — ส่ง `leadAttribution` เข้า AI DB
2. `packages/core/src/analytics/` — query schema + aggregation จริง
3. ชั้น LLM: คำถามภาษาไทย → พารามิเตอร์ · และเขียนสรุปจากตัวเลขที่ได้
4. `insights` collection — เก็บคำถาม พารามิเตอร์ ผลลัพธ์ ไว้ตรวจย้อน
5. `npm run insights:ask` (มีโหมด `--no-llm` ที่รับ JSON ตรง ๆ)
6. tests

### ❌ ไม่อยู่ในสโคป — อย่าทำ
- **ห้ามทำหน้าจอ/dashboard/กราฟ** — งานนี้จบที่ API + สคริปต์
- ห้ามทำรายงานอัตโนมัติรายวัน/ส่งเข้า LINE
- ห้ามแตะ intake, WF-A/C/E, LIFF, ระบบ tag
- **ห้ามแก้ WF-D นอกเหนือจากงานใน §3.2** (เพิ่งเคลียร์ไป อย่าไปยุ่งเกินจำเป็น)
- ห้ามเขียนอะไรกลับเข้า `line_crm_dev` — M4 **อ่านอย่างเดียว**

---

## 2. Design Decision

| # | ประเด็น | ตัดสินใจ |
|---|---|---|
| **D36** | ใครเป็นคนบอกตัวเลข | **aggregation ใน `packages/core` เท่านั้น** · LLM ทำได้แค่ 2 อย่าง: แปลงคำถามเป็นพารามิเตอร์ และเขียนสรุป**จากตัวเลขที่ได้มาแล้ว** |
| **D37** | ข้อมูล synthetic | `includeSynthetic: false` เป็น**ค่าเริ่มต้น** — ตราบใดที่ legacy ยังเป็นของปลอม คำตอบต้องไม่มีตัวเลขปลอมปนโดยไม่ได้ขอ · ขอเข้ามาต้องกำกับป้ายทุกบรรทัด |
| **D38** | เขตเวลา | ตัดวัน/สัปดาห์/เดือนตาม **Asia/Bangkok** เสมอ · เก็บใน Mongo เป็น UTC แต่ขอบเขตต้องคำนวณด้วย offset +07:00 |
| **D39** | intent (ความสนใจ) | เป็น **ค่าประเมินจาก AI ไม่ใช่ข้อเท็จจริง** · ห้ามอยู่ในตารางเดียวกับยอดขายโดยไม่กำกับป้าย · ต้องบอกรุ่นโมเดลและเกณฑ์ confidence ที่ใช้ |
| **D40** | ตรวจย้อนหลัง | ทุกคำตอบเก็บ `params` + `result` ลง `insights` — ต้องรันซ้ำแล้วได้ผลเดิม ถ้าข้อมูลไม่เปลี่ยน |

---

## 3. งานที่ต้องทำก่อน (ไม่ทำก่อน = ตอบคำถามเรื่องช่องทางไม่ได้)

### 3.1 ส่ง `leadAttribution` เข้า AI DB

M6 เพิ่ม `CustomerDoc.leadAttribution` แล้ว แต่ **`scrubCustomer` ยังไม่ส่งออกไป** → `customers_scrubbed` ไม่มีฟิลด์นี้

เพิ่มใน `packages/core/src/ai/scrubCustomer.ts`

```ts
leadAttribution: c.leadAttribution
  ? {
      // ไม่ส่ง pageId/formId/adId — เป็น id ของแพลตฟอร์ม ไม่จำเป็นต่อการวิเคราะห์
      courseCode: c.leadAttribution.courseCode,
      campaignName: c.leadAttribution.campaignName,
      adOrOrganic: c.leadAttribution.adOrOrganic,
      attributionPending: c.leadAttribution.attributionPending,
    }
  : null,
```

### 3.2 อัปเดต WF-D

เพิ่ม `leadAttribution` ในรายการ `fields` ของ node **Upsert AI DB** ใน `workflows/WF-D-ai-mirror.json`

⚠️ **วิธี import ที่ไม่ทำ credential หลุด** (บทเรียนจาก 2026-08-28)
ใส่ `id` ของ MongoDB credential ที่ผูกอยู่เดิมลงในไฟล์ JSON **ก่อน** import แล้ว import ทับ
ห้าม import ดิบ ๆ แล้วไปผูกใหม่ใน UI

หลังอัปเดตต้องสั่ง re-sync ลูกค้า ไม่งั้นฟิลด์ใหม่จะว่างเปล่าเงียบ ๆ

### 3.3 ตรวจก่อนไปต่อ
`customers_scrubbed` อย่างน้อย 1 doc ต้องมี key `leadAttribution` — ถ้าไม่มี อย่าเริ่ม §4

---

## 4. โครง Query และ Result

### 4.1 `AnalyticsQuery` — ต้อง validate ด้วย zod ก่อนรันทุกครั้ง

```ts
export const analyticsQuerySchema = z.object({
  metric: z.enum([
    "revenue",          // ยอดเงิน
    "seats",            // จำนวนที่นั่งที่ขายได้
    "people",           // จำนวนคน (นับหัวไม่ซ้ำ)
    "new_vs_returning", // ลูกค้าใหม่ vs เคยซื้อมาก่อน
    "channel_mix",      // มาจากช่องทางไหน
    "intent_funnel",    // ความสนใจ → ซื้อจริง
  ]),
  from: z.string().date(),   // "2026-08-01" ตีความตาม Asia/Bangkok
  to: z.string().date(),     // รวมวันสุดท้ายด้วย (inclusive)
  courseCodes: z.array(z.string()).optional(),
  groupBy: z.enum(["course", "month", "week", "day", "saleRep", "channel", "adOrOrganic"]).optional(),
  sources: z.array(z.enum(["legacy", "partner"])).default(["legacy", "partner"]),
  includeSynthetic: z.boolean().default(false),          // D37
  /** intent_funnel เท่านั้น — ต่ำกว่านี้ไม่นับ */
  minConfidence: z.number().min(0).max(1).default(0.6),
  hesitationReason: z.string().optional(),
});
```

### 4.2 `AnalyticsResult`

```ts
export interface AnalyticsResult {
  metric: string;
  rows: Array<{
    key: string;              // ค่า groupBy เช่น "INNER" หรือ "2026-07"
    label: string;            // ชื่อที่คนอ่านออก เช่น "Inner Makeover"
    value: number;
    /** ค่าที่คำนวณต่อยอด — ต้องคำนวณที่นี่ ไม่ใช่ให้ LLM คิดเอง */
    share?: number;           // สัดส่วนต่อผลรวม 0–1
    delta?: number;           // เทียบช่วงก่อนหน้าเท่ากัน
  }>;
  total: number;
  meta: {
    from: string; to: string; timezone: "Asia/Bangkok";
    sourcesUsed: string[];
    /** true = มีข้อมูลปลอมปนอยู่ ต้องกำกับป้ายในคำตอบ */
    containsSynthetic: boolean;
    /** true = ตัวเลขมาจากค่าประเมินของ AI ไม่ใช่ข้อเท็จจริง (D39) */
    isEstimate: boolean;
    rowsScanned: number;
    warnings: string[];
    generatedAt: string;
  };
}
```

**`share` และ `delta` ต้องคำนวณในชั้นนี้** เพราะ LLM ต้องไม่คิดเลขเอง (ดู §5.3)

---

## 5. สูตรที่ต้องถูก — จุดที่พลาดแล้วตัวเลขเพี้ยน

### 5.1 `revenue` — เงินอยู่ที่ payment เท่านั้น

```
revenue = SUM(legacy_payments.amount) + SUM(purchases.amount)
```

**ห้าม** `$lookup` จาก enrollments/items แล้วบวก `amount` — 1 การชำระมีได้หลายคอร์ส
ทำผิดข้อนี้ยอดเกินจริง **14.5%** (วัดจากข้อมูลจริงแล้ว ดู docs/21 §21.4)

- `purchases.status = "voided"` ไม่นับ
- `slipShared: true` ของ legacy = คนละคนจ่ายรวมกันมา **นับตามที่บันทึกไว้ ห้ามหารเอง**

### 5.2 `seats` — นับเฉพาะที่ขายได้จริง

```
seats = COUNT(legacy_enrollments WHERE countsAsSeat) + COUNT(purchase_items WHERE countsAsSeat)
```

`relearn` / `free` / `waitlist` / `refund` / `merchandise` **ไม่นับ** — ของจริงเป็นการขายจริงแค่ 81.8%
ถ้านับทุกแถวที่ไม่ว่าง ตัวเลขพองขึ้น 22%

### 5.3 `people` — นับหัวไม่ซ้ำข้ามสองแหล่ง

คนเดียวกันอาจมีทั้ง `legacyPersonId` และ `customerId` → ต้องยุบผ่าน `customer_links`
**ใช้เฉพาะ link ที่ `status: "auto"` หรือ `"confirmed"`** — `needs_review` ยังไม่ยืนยันว่าเป็นคนเดียวกัน

### 5.4 `new_vs_returning` — ตัดสินที่ "เวลาที่ซื้อ" ไม่ใช่เวลาที่ลิงก์

สำหรับการซื้อแต่ละครั้งที่เวลา T ของคน P:
```
ถ้ามีการชำระของ P (แหล่งไหนก็ได้) ที่ paidAt < T  → returning
ไม่มี                                              → new
```
**ห้ามใช้ "มี link = เก่า"** เพราะ link บอกแค่ว่าเป็นคนเดียวกัน ไม่ได้บอกว่าซื้อก่อนหน้านั้น

### 5.5 `channel_mix`

- `groupBy: "channel"` → จาก `customers_scrubbed.heardFrom`
- `groupBy: "adOrOrganic"` → จาก `leadAttribution.adOrOrganic`
- `attributionPending: true` ต้องแยกเป็นกลุ่ม **"ยังไม่รู้"** ห้ามยัดรวมกับ `unknown` ที่แปลว่า "รู้แล้วว่าไม่ทราบ"

### 5.6 `intent_funnel` (D39)

- ใช้เฉพาะ **แถวปัจจุบัน** (`supersededAt: null`, `voidedAt: null`) เว้นแต่ถามถึงประวัติ
- ตัด `belowThreshold` และ `confidence < minConfidence` ออก
- "คนที่เคยลังเลเพราะงบ สุดท้ายซื้อ" ต้องดู**ประวัติ** ไม่ใช่แถวปัจจุบัน — มี intent `hesitant/budget` ที่เวลา T แล้วมี payment ที่ `paidAt > T`
- `meta.isEstimate = true` เสมอ และ `warnings` ต้องมีรุ่นโมเดลที่ประเมิน

### 5.7 ขอบเขตเวลา (D38)

`from: "2026-08-01"` → `>= 2026-07-31T17:00:00Z` · `to: "2026-08-31"` → `<= 2026-08-31T16:59:59.999Z`
เขียนเป็น helper ตัวเดียว `bangkokRange(from, to)` แล้วใช้ทุกที่ **ห้ามคำนวณ offset ซ้ำในแต่ละ metric**

---

## 6. ชั้น LLM

### 6.1 แปลงคำถาม → พารามิเตอร์

```ts
export async function parseQuestion(
  provider: LlmProvider, question: string, today: string
): Promise<{ ok: true; query: AnalyticsQuery } | { ok: false; clarify: string }>;
```

- ส่งไปให้ LLM แค่ **คำถาม + วันที่วันนี้ + รายการคอร์สที่มี** — ห้ามส่งข้อมูลลูกค้าใด ๆ
- ผลลัพธ์ต้องผ่าน `analyticsQuerySchema` ถ้าไม่ผ่าน → retry 1 ครั้ง → ยังไม่ผ่านให้คืน `clarify` ถามกลับ
- **ห้ามเดาช่วงเวลาเมื่อคำถามไม่ระบุ** — "ขายดีไหม" ต้องถามกลับว่าช่วงไหน

### 6.2 เขียนสรุป

```ts
export async function renderAnswer(
  provider: LlmProvider, query: AnalyticsQuery, result: AnalyticsResult
): Promise<string>;
```

ส่งให้ LLM แค่ `result` (ตัวเลขที่คำนวณเสร็จแล้ว) + `meta` · **ห้ามส่งข้อมูลดิบรายคน**

### 6.3 ⭐ ตัวกันโกหก — ต้องมี ไม่ใช่ทางเลือก

```ts
/** ตัวเลขทุกตัวในข้อความต้องมีอยู่จริงใน result — ถ้าไม่มี แปลว่า LLM แต่งขึ้น */
export function verifyAnswerNumbers(answer: string, result: AnalyticsResult): {
  ok: boolean; invented: string[];
};
```

ดึงตัวเลขทุกตัวออกจากข้อความ (รวม % และตัวเลขที่มีคอมมา) แล้วเทียบกับเซ็ตของ
`value` / `share` / `delta` / `total` ที่คำนวณไว้ (ยอมให้ปัดเศษได้ตามที่กำหนด)

- เจอตัวเลขที่ไม่มีในผล → **ไม่ส่งคำตอบนั้นออกไป** ให้คืนตารางดิบแทน พร้อมบอกว่า LLM แต่งตัวเลข
- นี่คือเหตุผลที่ `share`/`delta` ต้องคำนวณในชั้น aggregation (§4.2) — ไม่งั้น LLM คิด % เองแล้วจะโดนตัวกันโกหกจับทุกครั้ง

### 6.4 ไม่มี LLM ก็ต้องใช้งานได้ (เหมือน D30)
`--no-llm` รับ JSON query ตรง ๆ แล้วพิมพ์ตารางออกมา · ทุก metric ต้องทำงานได้เต็มที่ในโหมดนี้

---

## 7. `insights` collection (ใน `line_crm_ai`)

```ts
export interface InsightDoc {
  _id: string;                 // ins_<ULID>
  question: string | null;     // null เมื่อมาจาก --no-llm
  params: AnalyticsQuery;
  result: AnalyticsResult;
  answer: string | null;
  answerVerified: boolean;     // ผ่าน verifyAnswerNumbers ไหม
  model: string | null;
  promptVersion: string;
  runAt: Date;
  elapsedMs: number;
}
```

index: `ix_runAt {runAt:-1}` · `ix_metric {"params.metric":1, runAt:-1}`

---

## 8. Tests

**Unit (pure ไม่ต้องต่อ DB)**
- ⭐ `bangkokRange("2026-08-01","2026-08-31")` ได้ขอบเขต UTC ที่ถูก และวันสุดท้ายรวมอยู่ด้วย
- `analyticsQuerySchema` ปฏิเสธ `from` > `to` · metric ที่ไม่รู้จัก · confidence นอกช่วง
- ⭐ `verifyAnswerNumbers` จับได้เมื่อ LLM แต่งตัวเลข ("โต 23%" ที่ไม่มีใน result)
- `verifyAnswerNumbers` ยอมรับเลขที่ปัดเศษจากค่าจริง และเลขที่มีคอมมา
- `parseQuestion` ที่ LLM คืน JSON เพี้ยน → retry แล้วคืน `clarify` ไม่ throw
- คำถามที่ไม่ระบุช่วงเวลา → ต้องได้ `clarify` ไม่ใช่เดาเป็น "เดือนนี้"

**Integration (`RUN_MONGO_INTEGRATION=true`)**
- ⭐ `revenue` จาก 1 การชำระที่มี 3 คอร์ส = ยอดครั้งเดียว **ไม่ใช่ 3 เท่า**
- ⭐ `seats` ไม่นับ `relearn`/`free`/`refund`
- ⭐ `includeSynthetic: false` (ค่าเริ่มต้น) → ข้อมูล legacy ปลอมไม่โผล่ในผลเลย และมี warning
- `includeSynthetic: true` → โผล่ แต่ `meta.containsSynthetic = true`
- ⭐ `new_vs_returning`: คนที่มี legacy payment ก่อนหน้า = returning · คนที่มี link แต่ไม่มีการซื้อก่อนหน้า = **new**
- `people` ไม่นับซ้ำเมื่อคนเดียวกันมีทั้ง legacy และ partner (ผ่าน link ที่ auto/confirmed)
- link ที่ `needs_review` ไม่ถูกใช้ยุบคน
- `purchases.status = "voided"` ไม่ถูกนับใน revenue
- `intent_funnel` ตัด `belowThreshold` ออก และ `meta.isEstimate = true`
- ⭐ ขอบเขตเดือน: การซื้อเวลา 2026-08-01 00:30 (+07:00) ต้องอยู่ในเดือน ส.ค. ไม่ใช่ ก.ค.
- รัน query เดิมซ้ำ → ผลเท่ากันทุกครั้ง (D40)

---

## 9. เกณฑ์ผ่านงาน

- [ ] `RUN_MONGO_INTEGRATION=true npm test` ผ่าน **skipped = 0** (ฐานปัจจุบัน core 253 · web 64)
- [ ] `npm run typecheck` ผ่านทั้ง 3 ชุด
- [ ] ทุก metric ทำงานได้ครบใน `--no-llm`
- [ ] `leadAttribution` โผล่ใน `customers_scrubbed` จริง (§3.3)
- [ ] มีเทสพิสูจน์ว่ายอดเงินไม่คูณตามจำนวนคอร์ส
- [ ] `verifyAnswerNumbers` จับ LLM ที่แต่งตัวเลขได้จริง (มีเทส)
- [ ] ข้อมูล synthetic ไม่โผล่โดยไม่ได้ขอ
- [ ] เขียน `docs/30-s11-m4-report.md` พร้อมผลรันจริงจาก terminal

---

## 10. กฎที่ห้ามละเมิด

1. **ตัวเลขทุกตัวมาจาก aggregation** LLM ห้ามคำนวณเอง แม้แต่เปอร์เซ็นต์ (D36)
2. **ห้ามส่งข้อมูลลูกค้ารายคนให้ LLM** — ส่งได้แค่ผลรวมที่คำนวณเสร็จแล้ว
3. **ห้ามให้ข้อมูล synthetic โผล่โดยไม่ได้ขอ** (D37)
4. **ห้ามเอาค่าประเมินจาก intent ไปปนกับยอดขายโดยไม่กำกับป้าย** (D39)
5. **ห้ามเขียนอะไรกลับเข้า `line_crm_dev`** — M4 อ่านอย่างเดียว
6. ห้ามคำนวณ timezone offset ซ้ำในแต่ละ metric — ใช้ helper ตัวเดียว
7. ห้ามลด/ปิด test เดิม
8. business logic อยู่ใน `packages/core`

---

## 11. สิ่งที่มีอยู่แล้ว ใช้ซ้ำได้เลย อย่าเขียนใหม่

| ของที่มี | ที่อยู่ | ใช้ทำอะไร |
|---|---|---|
| `LlmProvider` + `createLlmProvider()` | `packages/core/src/ai/llm/provider.ts` | เรียก Hermes — OpenAI-compatible ตั้งผ่าน env แล้ว |
| แบบอย่างการบังคับ schema กับผลจาก LLM | `packages/core/src/ai/llm/match.ts` | retry · validate · fallback เมื่อโมเดลตอบเพี้ยน |
| `COURSES` / `courseByCode` | `packages/core/src/legacy/courses.ts` | ชื่อคอร์สที่คนอ่านออก + รายการคอร์สที่ส่งให้ LLM ตอนแปลงคำถาม |
| `AI_COLLECTIONS` | `packages/core/src/db/models.ts` | ชื่อ collection ทั้งหมดใน AI DB |
| `CustomerLinkDoc` | `packages/core/src/db/models.ts` | ยุบคนข้ามสองแหล่ง (§5.3) |
| `countsAsSeat` | `legacy/courseCell.ts` · `partner/models.ts` | คำนวณไว้แล้วตั้งแต่ตอน import/intake **อย่าคำนวณใหม่** |
| แบบอย่าง aggregation + index | `packages/core/src/legacy/indexes.ts` `ix_courseSession` | ออกแบบมาเพื่อคำถาม "คอร์สนี้ ช่วงนี้ กี่ที่นั่ง" อยู่แล้ว |
| แบบอย่างสคริปต์ | `scripts/scrub-legacy.ts` · `scripts/build-matches.ts` | arg parsing · exit code · ไม่พิมพ์ URI |
| `env()` แบบแบ่งกลุ่ม | `packages/core/src/env.ts` | กลุ่ม `llm` มีอยู่แล้ว ไม่ต้องเพิ่มใหม่ |
