# S4 — สเปกงาน: n8n WF-A (Event → Customer)

> เอกสารนี้เป็น **สเปกสำหรับลงมือทำ** อ่านให้จบก่อนเขียนโค้ด
> อ้างอิง: [docs/01](01-architecture.md) · [docs/02](02-database.md) · [docs/04](04-n8n-workflows.md) · [docs/07](07-local-dev.md) · [docs/12](12-s3-review.md)

---

## 1. เป้าหมาย

ตอนนี้ event จาก LINE ถูกเก็บใน `inbound_events` แล้ว (S2) และมี `upsertFromLine` ที่แปลง event เป็นลูกค้าได้แล้ว (S3)
**แต่ยังไม่มีใครเชื่อมสองอย่างนี้เข้าด้วยกัน** — S4 คือการทำให้ n8n มาดึงงานจากคิวแล้วเรียก API

```
inbound_events (pending)
      ↑                     ┌── Schedule Trigger (ทุก 15 วิ)
      │                     │
   GET /api/internal/events/pending  ◄── n8n WF-A
      │                     │
      │                     ├─→ [ถ้า needsProfile] GET api.line.me/v2/bot/profile/{userId}
      │                     ├─→ POST /api/internal/customers/upsert-from-line
      │                     └─→ POST /api/internal/events/ack
      ▼
   customers + identities + interactions
```

### อยู่ในสโคป
1. field `channelId` ใน `inbound_events` + เขียนค่าจาก `destination`
2. endpoint `GET /api/internal/events/pending`
3. endpoint `POST /api/internal/events/ack`
4. `docker-compose.yml` สำหรับ n8n
5. n8n workflow **WF-A** (export เป็น JSON ลง `workflows/`)
6. n8n **WF-E** error handler (บันทึก log อย่างเดียว)
7. tests + สคริปต์ทดสอบ

### ❌ ไม่อยู่ในสโคป — อย่าทำ
- **ห้ามส่งข้อความต้อนรับ / push / reply ใด ๆ กลับไปหาลูกค้า** (D20 — ค่อยทำตอน S6 พร้อมปุ่มเปิดฟอร์ม)
- **ห้ามต่อ Slack / LINE Notify / อีเมล** สำหรับ alert (D21 — เก็บ log ในระบบก่อน)
- ห้ามแตะ LIFF, Google Sheets, PII service
- ห้ามเขียน business logic ลง n8n (ดู §8)

---

## 2. Design Decision ที่ยืนยันแล้ว

| # | ประเด็น | ตัดสินใจ |
|---|---|---|
| **D20** | ข้อความต้อนรับตอน follow | **ยังไม่ส่ง** — WF-A จบที่การบันทึกข้อมูล |
| **D21** | ปลายทาง alert เวลาระบบพัง | **เก็บ log ในระบบ** ยังไม่ต่อช่องทางแจ้งเตือนภายนอก |
| **D22** | ค่าของ `channelId` | ใช้ **`destination`** ที่ LINE ส่งมากับ webhook body |

### ⚠️ D22 มีผลกระทบที่ต้องแก้ก่อน

`channelId` เป็นส่วนหนึ่งของกุญแจระบุตัวลูกค้า — `unique(provider, channelId, externalId)`
**ถ้าค่านี้เปลี่ยนภายหลัง ลูกค้าเดิมทุกคนจะกลายเป็นคนใหม่หมด** จึงต้องถูกต้องตั้งแต่ event แรก

ปัญหาปัจจุบัน: `destination` อยู่ที่ **ระดับ body** ส่วน `inbound_events.raw` เก็บแค่ **event รายตัว** → **ตอนนี้ `destination` ถูกทิ้งไปแล้ว ไม่มีเก็บที่ไหนเลย**

---

## 3. งานที่ต้องทำ

### 3.1 เพิ่ม `channelId` ลง `inbound_events`

**`packages/core/src/db/models.ts`**
```ts
export interface InboundEventDoc {
  // ...ของเดิม
  /** LINE: body.destination — เป็นส่วนหนึ่งของกุญแจระบุตัวลูกค้า (D22) */
  channelId: string | null;
}
```

**`packages/core/src/events/inbox.ts`** — `EnqueueInput` เพิ่ม `channelId: string | null` และเขียนลง document

**`packages/core/src/db/indexes.ts`** — เพิ่ม index
```ts
{ key: { provider: 1, channelId: 1, status: 1 }, name: "ix_providerChannelStatus" }
```

**`apps/web/app/api/webhook/line/route.ts`**
```ts
const channelId = body.destination ?? null;
if (!channelId) log.warn("LINE webhook ไม่มี destination", { requestId });
// ส่ง channelId เข้า enqueueEvents ทุก item
```
> `destination` เป็น field ที่ LINE ส่งมาเสมอตามสเปก แต่ถ้าไม่มีให้เก็บ `null` แล้ว **ปล่อยให้ endpoint pending เป็นคนปฏิเสธ** (§3.2) — อย่าเดาค่าแทน

**Migration:** ข้อมูลใน dev cluster ตอนนี้เป็นข้อมูลทดสอบ ลบทิ้งได้ ไม่ต้องเขียน migration script

---

### 3.2 `GET /api/internal/events/pending`

**ไฟล์:** `apps/web/app/api/internal/events/pending/route.ts`

**Auth:** HMAC เหมือน `upsert-from-line` — `verifyInternal(rawBody, x-signature, x-timestamp, INTERNAL_HMAC_SECRET)`
⚠️ GET ไม่มี body → ให้เซ็นสตริงว่าง `""` แล้วเช็คแบบเดียวกัน **หรือ**เปลี่ยนเป็น `POST` เพื่อให้ signing สม่ำเสมอกับ endpoint อื่น
→ **เลือก `POST`** จะสอดคล้องและป้องกัน query string ติด log ของ proxy (ให้ตั้งชื่อ route ว่า `pending` แต่รับ `POST`)

**Request**
```jsonc
{ "limit": 50, "olderThanSec": 0, "provider": "line" }
```
| field | default | หมายเหตุ |
|---|---|---|
| `limit` | 50 | เพดาน 200 |
| `olderThanSec` | 0 | ให้ WF-D ในอนาคตใช้ตอนกวาดของค้าง |
| `provider` | `"line"` | |

**สิ่งที่ต้องทำก่อน claim**
1. เรียก `releaseStaleClaims()` — ปลดงานที่ค้างสถานะ `processing` เกิน lease (worker ตายกลางคัน) ทำที่นี่จะได้ไม่ต้องมี workflow แยก
2. `claimPending({ limit, olderThanSec, provider })`

**สิ่งที่ต้องทำหลัง claim — สำคัญ**
Endpoint นี้ต้อง **แปลง raw event เป็นรูปที่พร้อมใช้** ไม่ใช่โยน raw ให้ n8n ไปแกะเอง (§8 กฎข้อ 1)

```ts
// map แต่ละ event
const src = raw.source ?? {};
const lineUserId = src.type === "user" ? src.userId : null;
const eventType = raw.type;  // follow | unfollow | message | อื่น ๆ
```

**การคัดกรอง — event ที่ทำต่อไม่ได้ ต้องปิดตรงนี้ ไม่ส่งให้ n8n**
| เงื่อนไข | ทำอะไร |
|---|---|
| `channelId` เป็น null | `failEvent(eventId, "ไม่มี channelId (destination)")` → **ไม่ใส่ใน response** |
| `lineUserId` เป็น null (event จากกลุ่ม/ห้อง) | `ackEvents([eventId])` เป็น `done` → ไม่ใส่ใน response |
| `eventType` ไม่ใช่ `follow` / `unfollow` / `message` | `ackEvents` เป็น `done` → ไม่ใส่ใน response |
> เหตุผล: ถ้าปล่อยผ่านไป n8n มันจะวนพังแล้ว retry ไม่รู้จบ ปิดที่ต้นทางแล้วรายงานจำนวนกลับมา

**`needsProfile` — ตัดสินฝั่ง server**
```ts
// true  = n8n ต้องเรียก LINE Profile API
// false = มีชื่อ+รูปอยู่แล้ว ข้ามได้ ประหยัด API call
const identity = await identities.findOne(
  { provider, channelId, externalId: lineUserId },
  { projection: { customerId: 1 } }
);
let needsProfile = true;
if (identity) {
  const c = await customers.findOne(
    { _id: identity.customerId },
    { projection: { lineDisplayName: 1, pictureUrl: 1 } }
  );
  needsProfile = !(c?.lineDisplayName && c?.pictureUrl);
}
```
> ทำแบบ batch ได้ (`$in`) ถ้าอยากลด query — ไม่บังคับ แต่อย่ายิงทีละ event แบบ N+1 ถ้า limit เป็น 50

**Response**
```jsonc
{
  "ok": true,
  "requestId": "job_01...",
  "claimed": 3,
  "skipped": { "noChannelId": 0, "notUserEvent": 1, "unsupportedType": 0 },
  "events": [
    {
      "eventId": "01JQZX8K3M...",
      "provider": "line",
      "channelId": "U206d25c2ea6bd87c17655609a1c37cb8",
      "eventType": "follow",
      "lineUserId": "U4af4980629...",
      "occurredAt": "2026-08-26T04:11:00.000Z",
      "messageType": null,
      "needsProfile": true,
      "attempts": 0
    }
  ]
}
```
- ไม่มีงาน → `{ "ok": true, "claimed": 0, "events": [] }` **ไม่ใช่ 404**
- `occurredAt` มาจาก `raw.timestamp` (มิลลิวินาที) → แปลงเป็น ISO string; ถ้าไม่มีให้ใช้ `receivedAt`
- ⚠️ `messageType` เอาจาก `raw.message.type` ซึ่งผ่าน redact มาแล้ว — **ห้ามมี `text` หลุดออกมาเด็ดขาด** (D4)

---

### 3.3 `POST /api/internal/events/ack`

**ไฟล์:** `apps/web/app/api/internal/events/ack/route.ts` · Auth: HMAC

**Request**
```jsonc
{
  "provider": "line",
  "results": [
    { "eventId": "01JQZX...", "status": "done", "customerId": "cus_01..." },
    { "eventId": "01JQZY...", "status": "failed", "error": "upsert ตอบ 500" }
  ]
}
```

**พฤติกรรม**
| status | ทำอะไร |
|---|---|
| `done` | `ackEvents([eventId], provider)` |
| `failed` | `failEvent(eventId, error, provider)` → backoff อัตโนมัติ, ครบ 5 ครั้งเป็น `dead` |

**Response**
```jsonc
{ "ok": true, "requestId": "job_01...", "done": 2, "failed": 1, "dead": 0 }
```
- `results` ว่าง → `200` `{ done: 0, failed: 0 }`
- `eventId` ที่ไม่มีอยู่จริง → ข้าม ไม่ error (idempotent)
- `error` ที่ส่งมา **ต้องผ่าน `redact()` ก่อนเขียนลง `lastError`** — ข้อความ error จาก n8n อาจมี payload ติดมา

---

### 3.4 `GET /api/internal/events/dead` (สำหรับ D21)

**ไฟล์:** `apps/web/app/api/internal/events/dead/route.ts` · Auth: HMAC · `POST` เช่นกัน

เนื่องจากยังไม่ต่อช่องทางแจ้งเตือน ต้องมีที่ให้ "เปิดดูว่ามีอะไรพังบ้าง"

**Request** `{ "limit": 50 }`
**Response**
```jsonc
{ "ok": true, "count": 2, "events": [
  { "eventId": "...", "provider": "line", "eventType": "follow",
    "attempts": 5, "lastError": "...", "receivedAt": "...", "processedAt": "..." }
]}
```
⚠️ **ห้ามคืน `raw`** — มี userId อยู่ข้างใน ให้คืนเฉพาะ metadata

เพิ่ม `deadCount` เข้าไปใน `GET /api/health` ด้วย (มี `queueStats()` อยู่แล้ว — แค่ทำให้เห็นชัดว่ามีของค้าง)

---

### 3.5 `docker-compose.yml`

วางที่ราก `line-crm/`

```yaml
services:
  n8n:
    image: n8nio/n8n:latest
    container_name: line-crm-n8n
    restart: unless-stopped
    ports: ["5678:5678"]
    environment:
      - N8N_BASIC_AUTH_ACTIVE=true
      - N8N_BASIC_AUTH_USER=${N8N_USER:-admin}
      - N8N_BASIC_AUTH_PASSWORD=${N8N_PASSWORD}
      - N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY}
      - GENERIC_TIMEZONE=Asia/Bangkok
      - TZ=Asia/Bangkok
      - EXECUTIONS_DATA_PRUNE=true
      - EXECUTIONS_DATA_MAX_AGE=168          # 7 วัน — execution log มีข้อมูลลูกค้า
      - EXECUTIONS_DATA_SAVE_ON_SUCCESS=none # เก็บเฉพาะที่พัง ลดโอกาสข้อมูลค้าง
      - N8N_DIAGNOSTICS_ENABLED=false
    volumes:
      - ./.n8n-data:/home/node/.n8n
    extra_hosts:
      - "host.docker.internal:host-gateway"   # ให้ n8n เรียก Next dev server บนเครื่องได้
```

- เพิ่ม `.n8n-data/` ลง `.gitignore` (มีอยู่แล้ว — ตรวจซ้ำ)
- เพิ่ม `docker-compose.override.yml.example` หรือส่วนในเอกสารบอกวิธีสร้าง `N8N_ENCRYPTION_KEY`
- npm scripts: `n8n:up`, `n8n:down`, `n8n:logs`
- ⚠️ **`N8N_ENCRYPTION_KEY` หายเมื่อไหร่ credential ทั้งหมดใน n8n อ่านไม่ได้** — ต้องเขียนเตือนใน README

---

### 3.6 n8n WF-A

**ชื่อ:** `WF-A — LINE Event Processing`
**Export ไปที่:** `workflows/WF-A-line-event.json` (strip credential ก่อน commit)

#### Trigger — มีสองทาง ทำงานเหมือนกัน

| Node | Type | ตั้งค่า |
|---|---|---|
| 1a | **Schedule Trigger** | ทุก **15 วินาที** (dev) — ใส่ comment ว่า prod เปลี่ยนเป็น 1 นาที |
| 1b | **Webhook** | `POST /webhook/line-event` — เผื่อ prod เปิด `N8N_PUSH_ENABLED=true` |

> **ทั้งสอง trigger ไม่ต้องรับ eventId ใด ๆ** — หน้าที่เดียวคือ "ไปล้างคิว"
> ต่างจากที่ [docs/04](04-n8n-workflows.md) ร่างไว้เดิม (ให้ webhook ส่ง `eventIds` มาแล้วดึงเฉพาะตัวนั้น)
> เหตุผลที่เปลี่ยน: ถ้าดึงเฉพาะ eventIds ที่ push มา event ที่ push พลาดจะค้างจนกว่าจะมี reconciler แยก
> การให้ทุก trigger "ล้างคิวทั้งหมด" ทำให้ WF-A เป็น reconciler ในตัว **ไม่ต้องมี WF-D แยก**
> → ให้อัปเดต docs/04 ให้ตรงกับของจริงด้วย

#### สายประมวลผล

| # | Node | Type | รายละเอียด |
|---|---|---|---|
| 2 | `Claim Events` | HTTP Request | `POST {{$env.API_BASE}}/api/internal/events/pending`<br/>body `{ "limit": 50, "provider": "line" }`<br/>header HMAC (ดู §3.7) · **Retry On Fail: 3, wait 2000ms** |
| 3 | `Has Events?` | IF | `{{ $json.events.length > 0 }}` — false → จบเงียบ ๆ (อย่าให้ error) |
| 4 | `Split Events` | Split Out / Item Lists | field `events` → 1 item ต่อ 1 event |
| 5 | `Needs Profile?` | IF | `{{ $json.needsProfile }}` |
| 6 | `Get LINE Profile` | HTTP Request | `GET https://api.line.me/v2/bot/profile/{{ $json.lineUserId }}`<br/>credential: `LINE Messaging API` (Header Auth)<br/>⚠️ **Continue On Fail = true** (ผู้ใช้บล็อกบอท → 404 ต้องทำงานต่อได้) |
| 7 | `Build Payload` | Set / Code | รวมเป็น body ของ upsert (ดูรูปด้านล่าง) — โปรไฟล์ที่ดึงไม่ได้ให้เป็น `null` |
| 8 | `Upsert Customer` | HTTP Request | `POST {{$env.API_BASE}}/api/internal/customers/upsert-from-line`<br/>HMAC · Retry 3 · **Continue On Fail = true** (ต้องเก็บผลลัพธ์ล้มเหลวไป ack) |
| 9 | `Collect Results` | Code | รวมทุก item เป็น `results[]` ตามรูปของ `/events/ack` |
| 10 | `Ack Events` | HTTP Request | `POST {{$env.API_BASE}}/api/internal/events/ack` · HMAC · Retry 3 |

**body ของ node 7 → 8**
```json
{
  "eventId":   "={{ $json.eventId }}",
  "channelId": "={{ $json.channelId }}",
  "lineUserId":"={{ $json.lineUserId }}",
  "eventType": "={{ $json.eventType }}",
  "occurredAt":"={{ $json.occurredAt }}",
  "profile": {
    "displayName": "={{ $json.profile?.displayName ?? null }}",
    "pictureUrl":  "={{ $json.profile?.pictureUrl ?? null }}"
  },
  "message": { "type": "={{ $json.messageType }}" }
}
```

**การ map ผลลัพธ์ที่ node 9**
```
upsert ตอบ 2xx  → { eventId, status: "done", customerId }
upsert ตอบอื่น  → { eventId, status: "failed", error: "<statusCode>: <ข้อความสั้น ๆ>" }
```
⚠️ `error` ต้องสั้น **ห้ามยัด response body ทั้งก้อน** (มี userId อยู่ข้างใน)

**Error Workflow:** ตั้งเป็น `WF-E`

---

### 3.7 การเซ็น HMAC ใน n8n

ทุก request ไป `/api/internal/*` ต้องมี
```
x-signature: sha256=HMAC-SHA256(`${rawBody}.${timestamp}`, INTERNAL_HMAC_SECRET)
x-timestamp: <unix seconds>
```
`timestamp` ต่างจากปัจจุบันเกิน 300 วินาที = ถูกปฏิเสธ

ทำเป็น **Code node ที่ใช้ซ้ำได้** วางก่อนทุก HTTP Request node:
```js
const crypto = require('crypto');
const body = JSON.stringify($json.payload);
const ts = Math.floor(Date.now() / 1000);
const sig = 'sha256=' + crypto.createHmac('sha256', $env.INTERNAL_HMAC_SECRET)
  .update(`${body}.${ts}`).digest('hex');
return [{ json: { body, headers: { 'content-type': 'application/json', 'x-signature': sig, 'x-timestamp': String(ts) } } }];
```
⚠️ body ที่เซ็นกับ body ที่ส่ง **ต้องเป็นสตริงเดียวกันเป๊ะ** — ตั้ง HTTP Request node เป็น `Body Content Type: Raw/JSON` แล้วส่ง `{{ $json.body }}` ตรง ๆ **ห้ามให้ n8n สร้าง JSON ใหม่จาก object** ไม่งั้นลำดับ key เปลี่ยนแล้ว signature ไม่ตรง (บทเรียนเดียวกับ LINE signature ใน S2)

**env ของ n8n container ที่ต้องเพิ่ม**
```
API_BASE=http://host.docker.internal:3100      # dev; prod = https://<project>.vercel.app
INTERNAL_HMAC_SECRET=<ค่าเดียวกับใน apps/web/.env.local>
```

---

### 3.8 n8n WF-E (Error Handler)

**ชื่อ:** `WF-E — Error Handler` → `workflows/WF-E-error-handler.json`

| # | Node | รายละเอียด |
|---|---|---|
| 1 | `Error Trigger` | รับ `execution.id`, `workflow.name`, `error.message`, node ที่พัง |
| 2 | `Redact` (Code) | ตัด `userId`, เบอร์, อีเมล, token ออกจาก error payload **ก่อน**ส่งต่อ |
| 3 | `Log` (HTTP) | `POST {{$env.API_BASE}}/api/internal/logs/n8n-error` · HMAC |

**endpoint ใหม่:** `apps/web/app/api/internal/logs/n8n-error/route.ts`
เขียนลง `audit_logs`
```jsonc
{ "actor": "n8n:WF-A", "action": "workflow.error", "customerId": null,
  "before": null, "after": { "executionId": "...", "node": "...", "message": "..." },
  "reason": "n8n execution failed", "at": "..." }
```
⚠️ ผ่าน `redact()` อีกชั้นฝั่ง server — อย่าเชื่อว่า n8n redact มาแล้ว (D21 บอกให้เก็บ log ไม่ได้บอกให้เก็บ PII)

---

## 4. Tests

### 4.1 Unit / Integration (vitest, ต้องมี `RUN_MONGO_INTEGRATION=true`)

**`packages/core`**
- [ ] `enqueueEvents` เก็บ `channelId` ลง document ถูกต้อง
- [ ] `claimPending` คืน `channelId` มาด้วย
- [ ] `releaseStaleClaims` ยังทำงานเหมือนเดิม (regression)

**`apps/web` — เขียนเป็น integration test ยิง route handler ตรง ๆ**
| เคส | คาดหวัง |
|---|---|
| `/events/pending` ไม่มี HMAC | `401` |
| `/events/pending` timestamp เก่า 10 นาที | `401` |
| คิวว่าง | `200` `{ claimed: 0, events: [] }` |
| มี 3 event | `200` `claimed: 3` และทุกตัวมี `channelId`, `lineUserId`, `eventType`, `occurredAt` |
| **event ที่ `channelId` เป็น null** | ไม่อยู่ใน `events`, `skipped.noChannelId = 1`, สถานะใน DB เป็น `pending` (attempts เพิ่ม) |
| **event จากกลุ่ม (ไม่มี `source.userId`)** | ไม่อยู่ใน `events`, `skipped.notUserEvent = 1`, สถานะเป็น `done` |
| **event type `join`** | ไม่อยู่ใน `events`, `skipped.unsupportedType = 1`, สถานะเป็น `done` |
| เรียกซ้ำทันที | รอบสองได้ `claimed: 0` (ตัวแรก claim ไปแล้ว) |
| **`limit` เกิน 200** | ถูกบีบเหลือ 200 ไม่ใช่ error |
| `/events/ack` `status: done` | สถานะเป็น `done`, `processedAt` ถูกตั้ง |
| `/events/ack` `status: failed` | กลับเป็น `pending`, `attempts` +1, `nextAttemptAt` เลื่อนไปอนาคต |
| `/events/ack` failed 5 ครั้ง | สถานะเป็น `dead` |
| `/events/ack` eventId ไม่มีจริง | `200` ไม่ error |
| **`/events/ack` error ที่มีเบอร์โทร** | `lastError` ใน DB **ต้องไม่มีเบอร์** |
| `/events/dead` | คืน metadata และ **ไม่มี field `raw`** |

### 4.2 สคริปต์ End-to-End

**`scripts/smoke-s4.ts`** — ต้องรันได้ด้วย `npm run smoke:s4`

จำลองทั้งวงจรโดย**ไม่ต้องมี n8n**:
```
1. ยิง /api/webhook/line (signature จริง) ด้วย follow event
2. เรียก /api/internal/events/pending  → ได้ event กลับมา 1 ตัว
3. เรียก /api/internal/customers/upsert-from-line ด้วยข้อมูลนั้น
4. เรียก /api/internal/events/ack       → done
5. ตรวจ: customers 1, identities 1, interactions 1 (type=follow), inbound_events status=done
6. ทำซ้ำข้อ 1 ด้วย event เดิม → ต้องไม่เกิดลูกค้าเพิ่ม
7. ล้างข้อมูลทดสอบทิ้ง
```
พิมพ์ผลเป็น ✅/❌ ต่อบรรทัด และ `process.exitCode = 1` เมื่อมีข้อไหนไม่ผ่าน

### 4.3 ทดสอบกับ n8n จริง

- [ ] `docker compose up -d` แล้วเข้า `http://localhost:5678` ได้
- [ ] import `WF-A.json` แล้วกด Execute Workflow ครั้งเดียว → event ถูกดึงและ ack
- [ ] เปิด Schedule Trigger ทิ้งไว้ 1 นาที → ยิง webhook เข้ามา → ลูกค้าโผล่ในฐานภายใน ~15 วินาที
- [ ] **ปิด Next dev server แล้วยิง webhook** → event ค้างเป็น `pending` (ไม่หาย) → เปิด server กลับมา → WF-A เก็บได้เอง
- [ ] ทำให้ upsert พังชั่วคราว → ดูว่า `attempts` เพิ่ม, `nextAttemptAt` เลื่อน, ครบ 5 ครั้งเป็น `dead`
- [ ] **เปิด n8n execution log แล้วหาเบอร์โทร/ชื่อลูกค้า → ต้องไม่เจอ**

---

## 5. เกณฑ์ผ่านงาน

1. `npm test` ผ่านทั้งหมด (รวมของเดิม 86 เคส) เมื่อตั้ง `RUN_MONGO_INTEGRATION=true`
2. `npm run typecheck` ผ่านทั้ง `packages/core` และ `apps/web`
3. `npm run build --workspace @line-crm/web` ผ่าน
4. `npm run smoke:s4` ผ่านทุกข้อ
5. ยิง webhook จริง → รอ ≤ 20 วินาที → มีลูกค้าใน MongoDB โดยไม่ต้องแตะอะไรด้วยมือ
6. ปิด server ระหว่างทางแล้วเปิดใหม่ → ไม่มี event หาย
7. `workflows/*.json` commit แล้วและ **ไม่มี credential ค่าจริงอยู่ในไฟล์**
8. เอกสารอัปเดต: `docs/04` (WF-A ที่เปลี่ยนไป, ไม่มี WF-D แยกแล้ว), `docs/03` (endpoint ใหม่), `README` (D20–D22, n8n setup, สถานะ S4)

---

## 6. ข้อมูลที่ยังไม่มี — ทำงานให้ได้โดยไม่ต้องรอ

| สิ่งที่ขาด | ทำยังไง |
|---|---|
| **LINE Channel Access Token** | node 6 ตั้ง `Continue On Fail = true` อยู่แล้ว → ไม่มี token = ลูกค้าถูกสร้างแบบไม่มีชื่อ/รูป **ระบบต้องไม่พัง** เขียน test ครอบเคสนี้ด้วย |
| **Vercel deployment** | dev ใช้ `API_BASE=http://host.docker.internal:3100` ชี้ Next dev server บนเครื่อง — ไม่ต้อง deploy |
| **LINE webhook จริง** | ใช้ `scripts/smoke-line-webhook.ts` ที่มีอยู่แล้วยิง event ปลอมที่ signature ถูกต้อง |

---

## 7. เอกสารที่ต้องอัปเดตเมื่อทำเสร็จ

- `docs/03-api.md` — เพิ่ม `/internal/events/pending`, `/ack`, `/dead`, `/logs/n8n-error`
- `docs/04-n8n-workflows.md` — WF-A ใช้ trigger สองทางและล้างคิวทั้งหมด; **ลบ WF-D** ออก (รวมเข้า WF-A แล้ว); WF-E เหลือแค่ log
- `docs/07-local-dev.md` — วิธีรัน n8n ด้วย docker compose
- `README.md` — D20–D22, สถานะ S4, npm scripts ใหม่
- `docs/14-s4-report.md` — **ไฟล์ใหม่** สรุปสิ่งที่ทำ + ผลทดสอบจริง (คัดลอกผลรันจริงมาแปะ ไม่ใช่เขียนว่า "ผ่าน" เฉย ๆ)

---

## 8. กฎที่ห้ามละเมิด

1. **n8n ห้ามมี business logic** — ห้ามตัดสินว่า event นี้เป็น first message ไหม, ห้ามคำนวณสถานะลูกค้า, ห้ามเดา channelId ทุกการตัดสินใจอยู่ใน `packages/core` และ endpoint
2. **n8n ห้ามต่อ MongoDB โดยตรง** — ผ่าน `/api/internal/*` เท่านั้น
3. **ห้าม log PII** — ไม่มี userId, เบอร์, อีเมล, ข้อความลูกค้า ในทั้ง log ของ API และ execution ของ n8n
4. **ห้าม hardcode secret** — ทั้งในโค้ด ใน workflow JSON และใน docker-compose (ใช้ `${...}` จาก env)
5. **ทุก endpoint ที่เขียนข้อมูลต้อง idempotent** — เรียกซ้ำแล้วผลเหมือนเดิม
6. **`/api/internal/*` ทุกตัวต้องมี HMAC + replay window** ไม่มีข้อยกเว้น
7. **ห้ามแก้ `upsertFromLine` หรือ `resolve.ts`** — เพิ่งรีวิวและแก้บั๊กไป 4 จุด (docs/12) ถ้าคิดว่าต้องแก้จริง ให้เขียนเหตุผลไว้ใน `docs/14` แล้วเพิ่ม test คุมด้วย
8. **ห้ามลด/ปิด test เดิม** — ถ้า test เดิมพังเพราะโครงสร้างเปลี่ยน ให้แก้ test ให้ตรงกับพฤติกรรมใหม่ **พร้อมอธิบายว่าทำไม** ห้ามลบทิ้งเฉย ๆ

---

## 9. สิ่งที่มีอยู่แล้ว ใช้ซ้ำได้เลย อย่าเขียนใหม่

| ของที่มี | ที่อยู่ |
|---|---|
| `claimPending`, `ackEvents`, `failEvent`, `releaseStaleClaims`, `queueStats` | `packages/core/src/events/inbox.ts` |
| `verifyInternal`, `signInternal` | `packages/core/src/events/publisher.ts` |
| `upsertFromLine` | `packages/core/src/customers/upsertFromLine.ts` |
| `redact` | `packages/core/src/logger.ts` |
| `ok()`, `fail()`, `newRequestId()` | `apps/web/lib/http.ts` |
| ตัวอย่าง route ที่ทำ HMAC ถูกต้องแล้ว | `apps/web/app/api/internal/customers/upsert-from-line/route.ts` |
| สคริปต์ยิง LINE webhook ปลอม | `scripts/smoke-line-webhook.ts` |
