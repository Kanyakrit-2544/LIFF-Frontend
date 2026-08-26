# S4 — ผลรีวิว

Codex ส่งงานมาพร้อมรายงานว่า typecheck/test/build/smoke ผ่านทั้งหมด
**โค้ดฝั่ง API ถูกต้องทั้งหมด** แต่ **workflow ของ n8n ใช้งานไม่ได้เลย** — เพราะไม่เคยถูกรันจริง

> Codex ระบุเองในหมายเหตุว่า "ยังไม่ได้ import workflow เข้า n8n UI แล้วกด Execute จริงในรอบนี้"
> ทั้ง 8 บั๊กด้านล่างมองไม่เห็นจากการอ่านโค้ดหรือรัน unit test — ต้องรัน n8n จริงเท่านั้น

---

## 15.1 สิ่งที่ Codex ทำได้ดี

| | |
|---|---|
| endpoint ทั้ง 4 ตัว | HMAC + replay window ถูกต้อง, ใช้ `readSignedJson` ร่วมกันไม่เขียนซ้ำ |
| การคัดกรอง event | `channelId` null → `failEvent` · event จากกลุ่ม / type ไม่รองรับ → `ackEvents` เป็น done ตรงตามสเปก |
| `needsProfile` | ทำแบบ batch ด้วย `$or` + `$in` ไม่ใช่ N+1 |
| `/events/dead` | ไม่คืน `raw` ตามที่สเปกกำหนด |
| `ack` | ผ่าน `redact()` ก่อนเขียน `lastError` |
| tests | ครบทั้ง 15 เคสที่สเปกระบุ, cleanup จำกัดขอบเขตด้วย `runId` ไม่ล้างข้อมูลจริง |
| `Build Payload` | มี fallback `$('Split Events')` เผื่อ Get LINE Profile ล้มเหลว — คิดมาดี |

---

## 15.2 บั๊กที่เจอตอนรัน n8n จริง

### 🔴 1. `Module 'crypto' is disallowed`
n8n task runner บล็อก Node builtin ใน Code node โดย default
→ **Code node ที่เซ็น HMAC ทั้ง 3 ตัวพังหมด → workflow ไม่ทำงานเลยแม้แต่ครั้งเดียว**
**แก้:** `NODE_FUNCTION_ALLOW_BUILTIN=crypto` ใน docker-compose

### 🔴 2. `access to env vars denied`
workflow อ่าน `$env.INTERNAL_HMAC_SECRET` และ `$env.API_BASE` แต่ n8n บล็อก `$env` ใน Code node โดย default
→ **workflow พังทุกรอบ ยิงไม่ถึง API เลยสักครั้ง**
**แก้:** `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`
> ⚠️ ข้อแลกเปลี่ยน: Code node ทุกตัวอ่าน env ได้หมด — รับได้เพราะ n8n ตัวนี้ใช้คนเดียว ถ้าเปิดให้หลายคนแก้ workflow ควรย้ายไปใช้ n8n Credentials แทน `$env`

### 🔴 3. `Build Payload` ทิ้ง event ทั้งหมดยกเว้นตัวแรก
Code node อยู่ในโหมด `runOnceForAllItems` (default) แต่เขียนโดยอ่าน `$json` ซึ่งเป็น **item แรกเท่านั้น** แล้ว `return [{...}]` ตัวเดียว
→ **claim มา 50 event ประมวลผลจริง 1 event อีก 49 ค้างเป็น `processing` ตลอดไป**

ยืนยันจากการรันจริง: ยิง 2 follow event → เกิดลูกค้า **1 คน**, `POST /api/internal/customers/upsert-from-line` ถูกเรียก **1 ครั้ง**
**แก้:** เปลี่ยนเป็น `runOnceForEachItem` + ใช้ `$('Split Events').item.json` ซึ่ง n8n resolve paired item ให้ถูกตัวเสมอ

### 🔴 4. `Collect Results` หา `eventId` ไม่เจอ → ack ไม่ปิดงานจริง
`Upsert Customer` ตั้ง `fullResponse: true` → `$json` เป็น `{ body, headers, statusCode }` **ไม่มี `eventId`**
โค้ดอ่าน `item.json.eventId` ได้ `undefined` แล้ว fallback `item.pairedItem?.item?.json?.eventId` ก็ `undefined` (n8n เก็บ `pairedItem` เป็นตัวเลข ไม่ใช่ object ที่มี `.json`)
→ `.filter(r => r.eventId)` ตัดทิ้งหมด → ส่ง `results: []` ไป ack → **event ค้าง `processing` แล้ววนกลับมาทำใหม่ทุก 5 นาทีไม่รู้จบ**

ยืนยันจาก log: `POST /api/internal/events/ack 200` แต่ event ยังเป็น `processing`
**แก้:** ดึง `eventId` จาก `$('Sign Upsert Request').all()[i].json.eventId`

### 🟠 5. `errorWorkflow` อ้างด้วยชื่อ ไม่ใช่ id
`settings.errorWorkflow: "WF-E — Error Handler"` → n8n log: `Could not find workflow "WF-E — Error Handler"`
→ **WF-E ไม่เคยทำงาน** ทั้งที่สร้างไว้แล้ว
**แก้:** ใส่ `id` คงที่ให้ทั้งสอง workflow แล้วอ้างด้วย id

### 🟠 6. `n8n import:workflow` ใช้ไม่ได้
JSON ไม่มี field `id` → `SQLITE_CONSTRAINT: NOT NULL constraint failed: workflow_entity.id`
→ วิธี import ที่ทำซ้ำได้ (CLI) พังตั้งแต่ขั้นแรก
**แก้:** ใส่ `id` คงที่ (แก้พร้อมข้อ 5)

### 🟡 7. `retryOnFail` ไม่มีผล
สเปกกำหนด Retry 3 ครั้ง แต่ Codex ใส่ไว้ใน `parameters.options.retry` ซึ่ง n8n ไม่อ่าน — ต้องเป็น property ระดับ node
**แก้:** ย้ายไป `retryOnFail` / `maxTries` / `waitBetweenTries`

### 🟡 8. `continueOnFail` เลิกใช้แล้ว
n8n 2.x ใช้ `onError: "continueRegularOutput"` **แก้:** เปลี่ยนแล้ว

---

## 15.3 ผลทดสอบหลังแก้ (n8n 2.36.7 ใน Docker จริง)

**เคสรวม — ยิง 5 event ผสม**
```
inbound_events:  ทั้ง 5 → status=done
  follow ×3, message ×1, join ×1 (จากกลุ่ม)

customers (3):
  cus_...NB  first=09:01:09  firstMsg=-         tags=line-follower
  cus_...F1  first=09:01:09  firstMsg=-         tags=line-follower
  cus_...AQ  first=09:01:09  firstMsg=09:01:09  tags=engaged,line-follower

interactions (4):  follow ×3 + first_message ×1
```
✅ `join` จากกลุ่มถูกคัดออกและปิดงานถูกต้อง — ไม่หลุดไปทำให้ workflow พัง

**เคสเว็บล่มกลางทาง**
```
1. ยิง 2 follow event → accepted 2
2. ปิด Next dev server
3. n8n พยายามดึงงาน 50 วินาที → error 14 บรรทัด, event เป็น processing
4. เปิดเว็บกลับมา + lease หมดอายุ
5. ผล: ทั้ง 2 event → done, ลูกค้า 2 คน, interactions 2 รายการ
```
✅ **ไม่มี event หาย และไม่มี interaction ซ้ำ** แม้ event หนึ่งสร้างลูกค้าไปแล้วก่อนเว็บดับ (idempotency ทำงาน)

⚠️ **ข้อจำกัดที่พบ:** การกู้คืนใช้เวลาถึง **5 นาที** (ความยาวของ lease) ไม่ใช่ทันที — งานที่ค้าง `processing` ต้องรอ `releaseStaleClaims` ปลดก่อน ยอมรับได้สำหรับ POC แต่ถ้าต้องการเร็วกว่านี้ให้ลด `CLAIM_LEASE_MS`

**ชุดทดสอบ**
```
tests:      86 + 15 = 101 passed
typecheck:  0 errors
build:      Compiled successfully
smoke:s4:   6/6 ผ่าน
```

⚠️ `npm run smoke:s4` จะล้มถ้า **n8n ทำงานอยู่พร้อมกัน** เพราะแย่ง event กัน — ต้อง `docker compose stop n8n` ก่อนรัน (ควรเขียนไว้ใน README)

---

## 15.4 ไฟล์ที่ยังขาด

`docker-compose.yml` อ่านตัวแปรจาก `.env` ที่ราก repo แต่ **ไม่มีไฟล์นี้และไม่มี `.env.example` สำหรับ compose**
→ `npm run n8n:up` เฉย ๆ จะได้ n8n ที่ `INTERNAL_HMAC_SECRET` ว่าง แล้วทุก request โดน 401

ตัวแปรที่ต้องมี: `N8N_USER`, `N8N_PASSWORD`, `N8N_ENCRYPTION_KEY`, `API_BASE`, `INTERNAL_HMAC_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`

---

## 15.5 บทเรียนสำหรับรอบต่อไป

เกณฑ์ผ่านงานข้อที่ระบุว่า "import workflow แล้วกด Execute จริง" ถูกข้ามไป และนั่นคือข้อเดียวที่จับบั๊กทั้ง 8 ตัวได้
**unit test, typecheck, build และ smoke test ผ่านหมด ทั้งที่ workflow ทำงานไม่ได้เลยแม้แต่ครั้งเดียว** — เพราะทุกอย่างที่ทดสอบเป็นฝั่ง API ซึ่งไม่มีปัญหา

รอบหน้าที่มี n8n เข้ามาเกี่ยว ให้ถือว่า **"รัน workflow จริงแล้วเห็นข้อมูลเปลี่ยนในฐาน"** เป็นเกณฑ์บังคับ ไม่ใช่ข้อเสริม
