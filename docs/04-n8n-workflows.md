# Phase 4 — n8n Workflow Design (Node-by-Node)

## 4.0 กฎประจำทุก Workflow

1. **ห้ามใช้ MongoDB node เขียนข้อมูลลูกค้า** — เขียนผ่าน `/api/internal/*` เท่านั้น (ดู RISK-5)
2. ทุก HTTP Request node → `Retry On Fail: 3, waitBetweenTries: 2000ms`
3. ทุก workflow ตั้ง **Error Workflow = WF-E**
4. Credential เก็บใน n8n Credential Store เท่านั้น — ห้ามพิมพ์ค่าใน Function node
5. Execution data: ตั้ง `Save successful executions = none` และเก็บเฉพาะ error เพื่อลดข้อมูลลูกค้าค้างใน n8n

---

## WF-A — LINE Event Processing

**S4 actual:** WF-A มี trigger สองทาง แต่ทั้งสองทางทำอย่างเดียวกันคือ "ล้างคิวทั้งหมด"

| Trigger | ใช้เมื่อ | หมายเหตุ |
|---|---|---|
| `Schedule Trigger` | dev/pull mode | ทุก 15 วินาที; production ปรับเป็น 1 นาทีได้ |
| `Webhook Trigger` | prod/push mode | Vercel push มาเพื่อเร่ง latency แต่ workflow ยังล้างคิวทั้งหมด |

เหตุผลที่ไม่ดึงเฉพาะ `eventIds` จาก push: ถ้า push หาย event จะค้างจนต้องมี reconciler แยก การล้างคิวทุกครั้งทำให้ WF-A เป็น reconciler ในตัว

| # | Node | Type | รายละเอียด |
|---|---|---|---|
| 1a | `Schedule Trigger` | Schedule | ทุก 15 วินาทีใน dev |
| 1b | `Webhook Trigger` | Webhook | `POST /webhook/line-event`, response on received |
| 2 | `Sign Claim Request` | Code | สร้าง HMAC ให้ body `{ limit: 50, olderThanSec: 0, provider: "line" }` |
| 3 | `Claim Events` | HTTP | `POST /api/internal/events/pending` — server ปลด stale claim, claim งาน, และแปลง raw เป็น payload ที่พร้อมใช้ |
| 4 | `Has Events?` | IF | ไม่มีงานให้จบเงียบ ๆ |
| 5 | `Split Events` | Split Out | แตก `events[]` เป็น 1 item ต่อ event |
| 6 | `Needs Profile?` | IF | ใช้ค่า `needsProfile` ที่ server คำนวณให้ |
| 7 | `Get LINE Profile` | HTTP | `GET https://api.line.me/v2/bot/profile/{lineUserId}`; ใช้ env `LINE_CHANNEL_ACCESS_TOKEN`; Continue On Fail |
| 8 | `Build Payload` | Code | สร้าง body สำหรับ `/customers/upsert-from-line`; ถ้าดึง profile ไม่ได้ให้เป็น `null` |
| 9 | `Sign Upsert Request` | Code | HMAC จาก raw JSON string เดียวกับที่จะส่ง |
| 10 | `Upsert Customer` | HTTP | `POST /api/internal/customers/upsert-from-line`; server ตัดสิน first message / idempotency เอง |
| 11 | `Collect Results` | Code | 2xx → `done`; อื่น ๆ → `failed` พร้อม error สั้น ๆ |
| 12 | `Sign Ack Request` | Code | HMAC สำหรับ ack |
| 13 | `Ack Events` | HTTP | `POST /api/internal/events/ack` |

**ห้ามใน S4:** ยังไม่ส่ง welcome/reply/push กลับไปหาลูกค้า และไม่ต่อ alert ภายนอก

**Export:** `workflows/WF-A-line-event.json`

> `message` event: n8n ไม่ตัดสินว่าเป็นข้อความแรกหรือไม่ ส่งเข้า `/upsert-from-line` เหมือนกันหมด แล้วให้ database conditional update ใน core เป็นตัวกัน race condition

---

## WF-B — LIFF Form Submitted

**Trigger:** Webhook `POST /webhook/form-submitted`
> ⚠️ **ข้อมูลถูกเขียนลง Mongo โดย Vercel ไปแล้ว** ก่อนถึง n8n — WF-B ทำเฉพาะ side-effect

| # | Node | Type | รายละเอียด |
|---|---|---|---|
| 1 | `Webhook: form-submitted` | Webhook | `{ customerId, revision, merged, requestId }` |
| 2 | `Verify HMAC` | Code | เหมือน WF-A |
| 3 | `Get Customer` | HTTP | `GET /api/internal/customers/{customerId}` (ได้ค่า masked มาแล้ว) |
| 4 | `Was Merged?` | IF | ถ้า `merged` → 4a |
| 4a | `Notify Merge` | Slack/LINE | แจ้งพนักงานว่ามีการรวมลูกค้า (ให้คนตรวจได้) |
| 5 | `Mark Sheet Dirty` | NoOp | (Vercel ตั้ง flag ไว้แล้ว — WF-C จะเก็บเอง) |
| 6 | `High Value Lead?` | IF | เช่น `budget in ["100k_500k","500k+"]` |
| 7 | `Alert Sales` | HTTP | LINE Notify / push เข้ากลุ่มเซลส์ |
| 8 | `Ack` | HTTP | `POST /api/webhook/n8n { type:"form_processed", customerId }` |

**ทำไม Sheets ไม่อยู่ใน WF-B:** ถ้า sync ตรงนี้จะชน quota ตอนคนกรอกพร้อมกัน และเกิด duplicate row (RISK-4)

---

## WF-C — Google Sheets Sync (Cron)

**Trigger:** Schedule — ทุก 2 นาที

| # | Node | Type | รายละเอียด |
|---|---|---|---|
| 1 | `Cron` | Schedule | `*/2 * * * *` |
| 2 | `Claim Pending` | HTTP | `POST /api/internal/sheets/pending` `{ limit: 200 }` (server lock ให้แล้ว) — ได้**ข้อมูลจริง** |
| 3 | `Has Rows?` | IF | `rows.length > 0` ไม่งั้นจบ |
| 4 | `Read Key Column` | Google Sheets | `range = Customers!A2:A` → array ของ customerId |
| 5 | `Build Row Map` | Code | `{ customerId → rowIndex }` (index เริ่มที่ 2) |
| 6 | `Partition` | Code | แยกเป็น `toUpdate[]` (มี rowIndex) กับ `toAppend[]` |
| 7a | `Batch Update` | HTTP (Sheets API) | `POST spreadsheets/{id}/values:batchUpdate`<br/>`valueInputOption=RAW`, data = หลาย range ในครั้งเดียว |
| 7b | `Append` | Google Sheets | `values:append` `insertDataOption=INSERT_ROWS` |
| 8 | `Merge Results` | Merge | รวมผลทั้งสองสาย |
| 9 | `Ack` | HTTP | `POST /api/internal/sheets/ack { results }` |
| E | `On Error` | — | ส่ง `status:"error"` กลับให้ ack แล้วต่อ WF-E |

### Privacy Layer ใน WF-C

WF-C เขียนข้อมูลสำหรับพนักงาน จึงอ่าน row ที่ Vercel แปลงไว้แล้วจาก `/api/internal/sheets/pending` และส่งเข้า Google Sheets ตรง ๆ
ไม่มี AI, ไม่มี `_Schema`, ไม่มี scrub/restore ใน flow นี้แล้ว

### flow LINE (WF-A) — ไม่ผ่าน AI

คุณให้เลือกแบบที่ง่ายกว่า → **WF-A ไม่มี AI**
เหตุผล: `follow` / `first_message` มีแค่ `displayName` + timestamp ไม่มี free text ให้ตีความ เขียนตรงได้เลย
ประหยัดค่า token, ไม่มี latency, ไม่มีจุดล้มเหลวเพิ่ม — AI อยู่เฉพาะเส้นทางข้อมูลจาก LIFF

**ทำไมใช้ HTTP node แทน Google Sheets node ตอน update:** Sheets node ทำทีละแถว → 200 แถว = 200 request ชน quota แน่นอน; `values:batchUpdate` ยิงครั้งเดียวได้หลาย range
**Layout ของ Sheet:**
- `Customers` (A=customerId ล็อกไว้, คอลัมน์ท้ายสุด = หมายเหตุพนักงาน — ระบบไม่แตะ)
- layout เต็มอยู่ที่ [docs/08 §8.3](08-liff-fields-and-sheets.md#83-google-sheets-layout)
- ตั้ง Protected Range บนคอลัมน์ A เพื่อเตือนก่อนลบ `customerId` ซึ่งเป็น key หาแถว

**Scaling limit:** ~10,000 แถวเริ่มช้า → ตอนนั้นแยก sheet ตามเดือน หรือย้ายไป BigQuery/Looker Studio

---

## WF-D — AI Mirror (S9)

**Trigger:** Schedule ทุก 10 นาที

```
Schedule
  → Sign Claim (HMAC)
  → POST /api/internal/ai-mirror/pending
  → ถ้ามี rows
  → Upsert MongoDB line_crm_ai.customers_scrubbed
  → Sign Ack (HMAC)
  → POST /api/internal/ai-mirror/ack
```

กฎสำคัญ:

- n8n ไม่อ่าน `line_crm_dev` ตรง ๆ
- payload จาก `/pending` เป็นข้อมูล scrubbed แล้วเท่านั้น
- MongoDB credential ใน n8n ต้องเป็น `mirror_user` ที่ `readWrite` เฉพาะ `line_crm_ai`
- ถ้า Mongo node เขียนล้มเหลว workflow จะไม่ ack; lock จะถูกปลดหลัง lease หมดและลองใหม่

**Export:** `workflows/WF-D-ai-mirror.json`

---

## WF-E — Error Handler

**Trigger:** Error Trigger (ตั้งเป็น Error Workflow ของทุก WF)

| # | Node | รายละเอียด |
|---|---|---|
| 1 | `Error Trigger` | ได้ `execution.id`, `workflow.name`, `error.message`, node ที่พัง |
| 2 | `Redact` (Code) | ลบ userId, phone, email, token ออกจากข้อความ error |
| 3 | `Sign Log Request` | HMAC สำหรับ internal API |
| 4 | `Log` | `POST /api/internal/logs/n8n-error` เพื่อเขียน `audit_logs` |

S4 ยังไม่ต่อ Slack / LINE Notify / email ตาม D21

**Export:** `workflows/WF-E-error-handler.json`

---

## WF-F — Meta Lead Ads (Phase 2 — ยังไม่ build)

โครงที่รอไว้ พิสูจน์ว่า architecture ขยายได้จริงโดยไม่แตะ WF-A/B/C:

```
Meta Webhook (leadgen)
  → Verify x-hub-signature-256
  → GET https://graph.facebook.com/v21.0/{leadgen_id}?access_token=...
  → Map field_data → { fullName, phone, email, campaignId, adId }
  → POST /api/internal/leads/ingest
       ├─ resolveCustomer("lead_ads", pageId, leadgen_id, hints:{phone, email})
       ├─ เจอลูกค้าเดิม → link identity + $addToSet sources:"facebook"
       └─ ไม่เจอ → สร้างใหม่ source.channel = "facebook"
  → sheetSync.dirty = true  (WF-C เก็บต่อเอง ไม่ต้องเขียน Sheets ที่นี่)
```
**สิ่งที่ต้องเตรียมล่วงหน้า (ทำแล้วใน Phase 2/3):** collection `identities` รองรับ provider ใหม่, `sources` เป็น array, `/internal/leads/ingest` วางไว้ใน endpoint map แล้ว

---

## 4.1 Idempotency & Retry Matrix

| Workflow | Idempotency Key | ทำซ้ำแล้วเป็นยังไง |
|---|---|---|
| WF-A | `eventId` (unique index) | interaction ไม่ถูกสร้างซ้ำ, customer upsert = no-op |
| WF-B | `customerId + revision` | alert อาจส่งซ้ำ (ยอมรับได้) — ป้องกันด้วย dedupe cache |
| WF-C | `customerId` = row key | เขียนทับแถวเดิมด้วยค่าเดิม = ปลอดภัย |
| WF-D | `customerId` | upsert `_id` เดิมใน `line_crm_ai.customers_scrubbed`; ack ซ้ำไม่ทำให้ข้อมูลเพี้ยน |

## 4.2 n8n Credential ที่ต้องตั้ง
| ชื่อ | Type | ใช้ที่ |
|---|---|---|
| `LINE Messaging API` | Header Auth `Bearer <token>` | WF-A node 6a, 11 |
| `Internal API HMAC` | Header Auth (คำนวณใน Code node) | ทุก `/api/internal/*` |
| `Google Sheets SA` | Service Account | WF-C |
| `mirror_user line_crm_ai` | MongoDB | WF-D — readWrite เฉพาะ `line_crm_ai` |
| `Alert Channel` | — | ยังไม่ใช้ใน S4; WF-E log เข้า `audit_logs` เท่านั้น |

## 4.3 Export & Version Control
`workflows/*.json` ต้อง commit ลง git ทุกครั้งที่แก้ (`n8n export:workflow --all --pretty --output=workflows/`)
ก่อน commit ต้องรันสคริปต์ strip credential id/data ออก — n8n export มี field ที่หลุด secret ได้
