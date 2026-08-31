# S11-M3.5 — สัญญาการเชื่อมต่อ: ระบบติด Tag ลูกค้า → LINE CRM

> เอกสารนี้ใช้ 2 ทาง
> **§A** = ข้อกำหนดที่ระบบติด tag ต้องทำตาม — ส่งให้ทีม/AI ที่พัฒนาระบบนั้นอ่าน
> **§B** = สเปกฝั่งรับที่โปรเจกต์นี้ต้องสร้าง — ส่งให้ Codex ทำ
> ทั้งสองฝั่งพัฒนาแยกกันได้ทันที ไม่ต้องรอกัน เพราะสัญญาตรงกลางนิ่งแล้ว

---

## 1. ทำไมต้องมีเอกสารนี้

ตอนนี้ฟอร์ม LIFF เก็บแค่ **ตัวตนลูกค้า** (ชื่อ เบอร์ อีเมล เห็นเราจากช่องทางไหน) ไม่เก็บว่า
"ซื้อคอร์สอะไร รอบไหน จ่ายเท่าไร" ทำให้ตอบคำถามธุรกิจไม่ได้ เช่น

- สัปดาห์ที่ผ่านมาขายอะไรได้บ้าง อย่างละเท่าไร
- เดือนนี้ลูกค้าใหม่กี่คน ลูกค้าเก่ากี่คน
- ลูกค้ามาจาก content ไหน ยิงแอดหรือ organic

ระบบติด tag ที่กำลังพัฒนาอยู่จะเป็นคนรู้ข้อมูลส่วนที่ขาดนี้
เอกสารนี้กำหนดว่าจะส่งต่อกันด้วยรูปแบบอะไร เพื่อให้ **โยนเข้ามาแล้วทำงานได้ทันที** โดยไม่ต้องแก้ทั้งสองฝั่ง

### หน้าที่ของแต่ละฝั่ง — อย่าทำงานทับกัน

| ระบบ | รับผิดชอบ | ไม่ต้องทำ |
|---|---|---|
| ระบบติด tag | รู้ว่าใครซื้ออะไร จ่ายเท่าไร เมื่อไร ใครขาย | ไม่ต้อง dedupe ลูกค้า · ไม่ต้องรู้ว่าใครเป็นลูกค้าเก่า · ไม่ต้องคิดสถิติ |
| LINE CRM (โปรเจกต์นี้) | ระบุตัวลูกค้า · จับคู่กับประวัติเก่า · กันข้อมูลซ้ำ · scrub · คิดสถิติ | ไม่ยุ่งกับวิธีที่ฝ่ายขายติด tag |

**หลักการ**: ระบบ tag เป็นแหล่งความจริงของ "การซื้อ" · LINE CRM เป็นแหล่งความจริงของ "ตัวตนลูกค้า"

---

# §A ข้อกำหนดสำหรับระบบติด Tag

## A1. Endpoint

```
POST https://liff-frontend-three.vercel.app/api/partner/intake
Content-Type: application/json
```

### Header ที่ต้องส่งทุกครั้ง

| Header | ค่า |
|---|---|
| `x-partner-id` | รหัสระบบผู้ส่ง เช่น `tagger` (เราออกให้) |
| `x-timestamp` | Unix timestamp **หน่วยวินาที** ตอนส่ง |
| `x-signature` | `sha256=` + HMAC-SHA256 ของ `` `${rawBody}.${timestamp}` `` ด้วย secret ที่เราออกให้ |

ตัวอย่างการเซ็น (Node.js) — ต้องเซ็น **body ดิบทั้งก้อน ก่อน parse** ไม่ใช่ object ที่ stringify ใหม่

```js
const ts = Math.floor(Date.now() / 1000);
const raw = JSON.stringify(payload);
const sig = "sha256=" + crypto.createHmac("sha256", PARTNER_SECRET).update(`${raw}.${ts}`).digest("hex");
```

- หน้าต่างเวลา **300 วินาที** — นาฬิกาเครื่องคลาดเกินนี้จะถูกปฏิเสธ ต้องซิงก์เวลาเครื่อง
- secret แยกต่างหากต่อ partner ไม่ใช่ตัวเดียวกับ n8n — เพิกถอนได้โดยไม่กระทบระบบอื่น
- **ห้ามใส่ secret ใน URL, query string หรือ log**

## A2. รูปแบบข้อมูลที่ส่ง

```jsonc
{
  "events": [
    {
      // ── บังคับ ───────────────────────────────────────────────
      "eventId": "tagger-2026-08-28-000123",   // ไม่ซ้ำตลอดกาล ใช้กันข้อมูลซ้ำ (ดู A3)
      "type": "purchase",                       // purchase | purchase.void | intent | intent.void
      "occurredAt": "2026-08-28T10:15:00Z",     // ISO 8601 มี timezone เสมอ
      "revision": 1,                            // แก้ข้อมูลเดิม = eventId เดิม + revision เพิ่ม

      // ── ระบุว่าเป็นใคร: ส่งเท่าที่รู้ อย่างน้อย 1 อย่าง ──────────
      "subject": {
        "lineUserId": "Uxxxxxxxxxxxxxxxx",      // ⭐ ดีที่สุด ถ้ามีให้ส่งเสมอ
        "phone": "0812345678",                  // รูปแบบไหนก็ได้ เรา normalize เอง
        "email": "somchai@gmail.com",
        "fullName": "สมชาย ใจดี"                // ใช้ช่วยยืนยันเท่านั้น ไม่ใช้ระบุตัวคนเดี่ยว ๆ
      },

      // ── มีเมื่อ type = purchase ───────────────────────────────
      "payment": {
        "externalPaymentId": "IN-6908-00123",   // เลขสลิป/ใบเสร็จ — ถ้าไม่มีให้ใส่ id ของระบบคุณ
        "amount": 19710,                        // ⭐ ยอดของ "การชำระครั้งนี้" ทั้งก้อน ไม่ใช่ต่อคอร์ส
        "currency": "THB",
        "paidAt": "2026-08-28",
        "saleRep": "OO",                        // รหัส/ชื่อย่อพนักงานขาย
        "lines": [                              // คอร์สที่อยู่ในการชำระครั้งนี้ 1 ครั้งมีได้หลายคอร์ส
          {
            "courseLabel": "Inner",             // ชื่อที่ระบบคุณใช้ ส่งมาตามจริง
            "courseCode": "INNER",              // ถ้ารู้รหัสมาตรฐานให้ส่งด้วย (ดู A5)
            "sessionLabel": "27-28 Jun",
            "sessionStart": "2026-06-27",
            "kind": "enrolled"                  // enrolled | relearn | free | waitlist | transfer | refund | merchandise
          }
        ]
      },

      // ── มีเมื่อ type = intent (ดู A9) ─────────────────────────
      "intent": {
        "courseCode": "INNER",                  // null ได้ ถ้าสนใจแบบยังไม่เจาะจงคอร์ส
        "status": "hesitant",                   // interested | not_interested | hesitant | unknown
        "hesitationReason": "budget",           // มีเมื่อ status = hesitant
        "confidence": 0.93,                     // 0–1 จากโมเดล
        "source": "ai",                         // ai | staff
        "model": "hermes/gpt-4o-mini@2026-08"   // ระบุรุ่นที่ประเมิน ไว้ย้อนตรวจ
      },

      // ⚠️ `tags` และ `type: "tag"` ยังไม่รองรับใน M3.5 (ดู A10) ส่งมาได้แต่จะถูกพักไว้
      "attribution": {
        "source": "facebook",                   // facebook | instagram | tiktok | line | referral | walkin | other
        "adOrOrganic": "ad",                    // ad | organic | unknown
        "campaignId": "23851234567890",
        "contentRef": "#InnerMakeover"          // hashtag/โพสต์ที่ลูกค้ามาจาก
      }
    }
  ]
}
```

### ข้อจำกัดขนาด
- สูงสุด **100 event ต่อ 1 request** · body ไม่เกิน **1 MB**
- ส่งถี่ได้ไม่เกิน 60 request/นาที ต่อ partner

## A3. ⭐ กฎที่สำคัญที่สุด: `eventId` ต้องไม่ซ้ำและต้องคงที่

ทุก event ต้องมี `eventId` ที่ **ไม่ซ้ำกับ event อื่นตลอดกาล** และ **คงเดิมเมื่อส่งซ้ำ**

- ส่ง `eventId` เดิมซ้ำ → เราตอบ `duplicate` และ**ไม่ทำอะไรเลย** ปลอดภัย 100%
- ถ้าส่ง timeout / เน็ตหลุด / ไม่แน่ใจว่าถึงไหม → **ส่งใหม่ด้วย `eventId` เดิม** อย่าสร้างใหม่
- ถ้าสร้าง `eventId` ใหม่ทุกครั้งที่ retry → **ยอดขายจะถูกนับซ้ำ** และตัวเลขทั้งระบบผิด

แนะนำ: `${partnerId}-${วันที่}-${running number}` หรือ UUID ที่บันทึกคู่กับ record ในฝั่งคุณ

### การแก้ข้อมูลย้อนหลัง
- แก้ยอด/คอร์สของรายการเดิม → ส่ง `eventId` **เดิม** + `revision` เพิ่มขึ้น + ข้อมูลชุดใหม่ทั้งก้อน
- ยกเลิก/คืนเงิน → ส่ง event ใหม่ `type: "purchase.void"` พร้อม `"voids": "<eventId เดิม>"`
- **ห้ามลบข้อมูลด้วยการเงียบ** เราไม่มีทางรู้ว่าอะไรหายไป

## A4. ⭐ เงิน 1 ก้อน = 1 payment ห้ามแตกเป็นหลาย event

ถ้าลูกค้าจ่าย 33,900 บาทครั้งเดียวแล้วได้ 2 คอร์ส ต้องส่งเป็น

```jsonc
{ "payment": { "amount": 33900, "lines": [ {คอร์ส A}, {คอร์ส B} ] } }   // ✅ ถูก
```

**ห้าม**ส่งเป็น 2 event ที่มี amount 33,900 ทั้งคู่ (ยอดจะเบิ้ล) หรือหาร amount เอง (ราคาคอร์สไม่เท่ากัน หารแล้วผิด)

นี่ไม่ใช่ทฤษฎี — ข้อมูลขายจริงของ Inner Power มี 15% ของรายการที่ 1 การชำระครอบคลุมมากกว่า 1 คอร์ส
ถ้าทำผิดข้อนี้ ยอดขายรวมจะเกินจริงประมาณ **14.5%**

ถ้าคนหลายคนจ่ายรวมกันมาในสลิปเดียว: ส่งแยก event ต่อคน แต่ใส่ `externalPaymentId` เดียวกัน แล้วใส่ `amount` เฉพาะส่วนของคนนั้น (ถ้าแยกไม่ได้ ให้ใส่ยอดเต็มที่คนแรกคนเดียว แล้วคนอื่น `amount: null`)

## A5. ชื่อคอร์ส

ส่ง `courseLabel` ตามที่ระบบคุณใช้ได้เลย เราแปลงเป็นรหัสมาตรฐานให้ ถ้าแปลงไม่ได้เราจะ**เก็บไว้ในห้องพักรอ (quarantine) แล้วแจ้งกลับ ไม่ทิ้งเงียบ**

รหัสมาตรฐานปัจจุบัน (ถ้าระบบคุณอ้างอิงได้เลยยิ่งดี ส่งมาใน `courseCode`)

| courseCode | ชื่อคอร์ส | ชื่อที่เคยเจอในชีตขาย |
|---|---|---|
| `INNER` | Inner Makeover | Inner, Inner Makeover |
| `COMMU` | Communication | Commu, Communication, Mas Com |
| `PRESENT` | Presentation | Present, Presentation |
| `TTRT` | The Trainer | TTRT, TTRT'63, TTRT'64 |
| `DEEPIN` | Deep In | Deep In |
| `INNERCAMP` | Inner Camp | Inner Camp |
| `OTHER` | อื่น ๆ / สินค้า | อื่น ๆ, หนังสือ, ห้องพัก |

`kind` ต้องแยกให้ถูก เพราะมีผลกับ "ยอดคนเรียนที่ขายได้จริง"

| kind | ความหมาย | นับเป็นการขาย |
|---|---|---|
| `enrolled` | ลงเรียนปกติ | ✅ |
| `relearn` | ใช้สิทธิ์เรียนซ้ำ | ❌ |
| `free` | ได้ฟรี/แถม | ❌ |
| `waitlist` | รอคิว | ❌ |
| `transfer` | ย้ายคอร์ส | ❌ |
| `refund` | คืนเงิน | ❌ |
| `merchandise` | หนังสือ/ห้องพัก/ของขาย | ❌ |

## A9. ⭐ Intent — ผลวิเคราะห์ว่าลูกค้าสนใจหรือไม่

ระบบ tag อ่านแชตด้วย AI แล้วสรุปว่าลูกค้า **สนใจ / ไม่สนใจ / ลังเล** และ **ลังเลเพราะอะไร**
ส่งเข้ามาเป็น `type: "intent"` — **ส่งเฉพาะผลสรุป ห้ามส่งข้อความแชท** (ดู A6)

### ค่าที่รับได้ — รายการปิด ส่งค่าอื่นมาจะถูก quarantine

```text
status
├─ interested        สนใจ อยากได้ข้อมูล / กำลังตัดสินใจซื้อ
├─ not_interested    ปฏิเสธชัดเจน
├─ hesitant          สนใจแต่ยังไม่ตัดสินใจ
└─ unknown           อ่านแล้วสรุปไม่ได้

hesitationReason (ส่งเมื่อ status = hesitant)
├─ budget            งบยังไม่พร้อม / ราคาสูงเกิน
├─ not_needed        ยังไม่จำเป็นตอนนี้
├─ timing_conflict   รอบเรียนชนธุระ / ไม่ว่างวันนั้น
├─ not_ready         ยังไม่พร้อมด้านอื่น (ยังไม่มั่นใจ ยังไม่กล้า)
├─ needs_approval    ต้องปรึกษาคนอื่นก่อน (คู่สมรส/หัวหน้า)
└─ unknown           ลังเลแต่ไม่รู้เหตุผล
```

`timing_conflict` กับ `needs_approval` เพิ่มจากที่เสนอมา เพราะคอร์สมีรอบตายตัว
"ไม่ว่างรอบนี้" กับ "ไม่มีงบ" เป็นคนละปัญหาและแก้คนละวิธี (อันแรกเสนอรอบถัดไป อันหลังเสนอผ่อน)
ถ้ายุบรวมเป็น `not_ready` จะเสียข้อมูลที่เอาไปใช้ได้จริง

### กฎของ intent

**1. หนึ่ง event = หนึ่งคอร์ส** สนใจ 2 คอร์สในบทสนทนาเดียว → ส่ง 2 event (`eventId` คนละตัว)
ห้ามใส่ array ของคอร์สใน event เดียว เพราะแต่ละคอร์สมีสถานะและเหตุผลของตัวเอง

**2. `occurredAt` คือเวลาที่ลูกค้าพูด ไม่ใช่เวลาที่ AI ประมวลผล**
ถ้าประมวลผลย้อนหลังต้องใส่เวลาจริงของข้อความ ไม่งั้น timeline เพี้ยนทั้งระบบ

> **ชื่อฟิลด์**: ฝั่งส่งมีฟิลด์เวลาตัวเดียวคือ `occurredAt` (ระดับ event)
> ฝั่งรับเก็บลง `customer_intents.observedAt` โดย **`observedAt = occurredAt` เสมอ**
> ไม่มีฟิลด์ `observedAt` ใน payload — ทุกที่ในเอกสารที่พูดถึง `observedAt` หมายถึงค่านี้

**3. ⭐ ความสนใจเปลี่ยนได้ — เราเก็บเป็นประวัติ ไม่ทับของเก่า**
ประเมินใหม่เมื่อไรให้ส่ง **`eventId` ใหม่** ทุกครั้ง
`revision` ใช้เฉพาะตอน **แก้ผลที่ส่งผิด** ไม่ใช่ตอนลูกค้าเปลี่ยนใจ

เหตุผล: ต้องตอบคำถามอย่าง *"คนที่เคยลังเลเพราะงบ สุดท้ายซื้อกี่คน"* ให้ได้
ถ้าทับของเก่า คำถามนี้จะตอบไม่ได้ตลอดกาล และนี่คือคำถามที่มีค่าที่สุดของการเก็บ intent

**4. `confidence` ต่ำกว่า 0.6 → เราเก็บไว้แต่ไม่นับในสถิติ** ส่งมาตามจริง อย่าปัดขึ้นให้ดูดี

**5. ห้ามส่ง `purchased` / `repeat_customer` เป็น intent หรือ tag**
ตรงกับที่ทีม tag เสนอ — CRM ตัดสินจาก `purchase` จริง ซึ่งเชื่อถือได้กว่าการอ่านแชท

**6. `source: "staff"` ชนะ `source: "ai"` — แต่ชนะเฉพาะ "ช่วงเวลาที่เขาตัดสิน" ไม่ใช่ตลอดกาล** (ดู A9.2)

**7. ต้องส่ง `model` ทุกครั้ง**
วันที่เปลี่ยนโมเดลแล้วตัวเลข "คนสนใจ" กระโดด เราต้องแยกออกว่าเพราะโมเดลเปลี่ยนหรือลูกค้าเปลี่ยนจริง

**8. ตัวเลขจาก intent เป็น "ค่าประเมิน" ไม่ใช่ข้อเท็จจริง**
ทุกรายงานที่ใช้ intent จะถูกกำกับว่ามาจากการประเมินของ AI พร้อมบอกรุ่นโมเดลและช่วง confidence
ต่างจากยอดขายที่เป็นข้อเท็จจริง — ห้ามเอาสองอย่างนี้ไปวางในตารางเดียวกันโดยไม่แยกป้าย

**9. ส่งเมื่อผลเปลี่ยนเท่านั้น** ถ้า AI ประเมินทุกข้อความแล้วได้ผลเดิม 20 ครั้ง **ห้ามส่ง 20 event**
ให้จำผลล่าสุดที่ส่งไปแล้ว แล้วส่งเฉพาะตอนที่ `status` หรือ `hesitationReason` เปลี่ยน
(หรือ `confidence` เปลี่ยนเกิน 0.2) ไม่งั้นตารางประวัติจะเต็มไปด้วยแถวซ้ำจนอ่านไม่ออก

---

## A9.1 คีย์และกติกาการทับกัน (supersede)

**คีย์ของความสนใจ 1 เรื่อง = `(customerId, courseCode)`**
`courseCode: null` เป็นคีย์ของตัวเอง — "สนใจแบบยังไม่เจาะจงคอร์ส" ไม่ใช่ตัวแทนของทุกคอร์ส
ลูกค้าเป็น `not_interested` ที่ `null` แต่ `interested` ที่ `INNER` พร้อมกันได้ ไม่ถือว่าขัดกัน

**"ตัวปัจจุบัน" ตัดสินจาก `observedAt` ไม่ใช่ลำดับที่มาถึง**

```text
current = แถวที่ observedAt มากที่สุดของคีย์นั้น (ที่ยังไม่ถูก void)
```

event ที่มาถึงทีหลังแต่ `observedAt` เก่ากว่า (คิวค้าง / ประมวลผลย้อนหลัง) จะถูกใส่เป็นประวัติ
และ **ตั้ง `supersededAt` ให้ตัวเองทันที** ไม่ขึ้นเป็นตัวปัจจุบัน

**`observedAt` เท่ากันเป๊ะ** ตัดสินตามลำดับ: `source: staff` มาก่อน → `confidence` สูงกว่า → มาถึงทีหลัง
(ต้องมีกฎตายตัวไม่งั้นผลจะไม่เหมือนกันทุกครั้งที่รัน)

## A9.2 ⭐ Staff lock — แก้ได้ แต่ไม่ล็อกตลอดกาล

ปัญหาที่ต้องกันคือ **"สถานะค้างอยู่กับคำแก้ของ staff เมื่อ 6 เดือนก่อน"**
เจ้าหน้าที่แก้เมื่อ ส.ค. ว่า "ไม่ได้ลังเลเพราะงบ แค่ไม่ว่าง" → พ.ย. ลูกค้าพิมพ์เองว่า "ตอนนี้พร้อมแล้ว อยากสมัคร"
ถ้า AI ทับไม่ได้เลย สถานะจะค้างที่ `hesitant/timing_conflict` ตลอดไป ทั้งที่ลูกค้าบอกเองว่าเปลี่ยนใจแล้ว

**กติกา: staff ชนะเฉพาะเรื่องที่เกิดขึ้นก่อนหรือพร้อมกับตอนที่เขาตัดสิน**

```text
AI intent จะทับ staff intent ที่เป็นตัวปัจจุบันได้ ก็ต่อเมื่อ
    ai.observedAt  >  staff.observedAt      → รับ (เป็นเรื่องใหม่ที่ลูกค้าเพิ่งพูด)
    ai.observedAt <= staff.observedAt      → rejected (กำลังเถียงเรื่องที่คนตัดสินไปแล้ว)
```

เหตุผล: เจ้าหน้าที่กำลังแก้ **การตีความบทสนทนาถึงเวลานั้น** ไม่ได้ประกาศว่าลูกค้าคนนี้จะไม่มีวันเปลี่ยนใจ
บทสนทนาใหม่คือหลักฐานใหม่ ไม่ใช่การเถียงคำตัดสินเดิม

**กรณีที่ต้องล็อกจริง ๆ ใช้ `lock: "sticky"`**

```jsonc
{ "intent": { "status": "not_interested", "source": "staff", "lock": "sticky" } }
```

`sticky` = AI ทับไม่ได้ไม่ว่า `observedAt` ใหม่แค่ไหน มีแต่ staff เท่านั้นที่ปลดได้
ใช้กับเรื่องที่เป็นการตัดสินใจถาวร ไม่ใช่การตีความ เช่น

- ลูกค้าขอไม่ให้ติดต่ออีก
- ลูกค้าร้องเรียน/มีปัญหาที่ต้องให้คนดูแลเท่านั้น
- เคสที่ AI อ่านผิดซ้ำ ๆ จนต้องปิดปาก

`lock` ไม่ส่งมา = `"soft"` (ค่าเริ่มต้น) · `lock` ใช้ได้เฉพาะ `source: "staff"` ถ้า AI ส่งมาจะถูก rejected

## A9.3 การยกเลิก intent ที่ส่งผิด

AI ส่งผลที่ผิดชัด ๆ และไม่มีค่าที่ถูกจะแทน → ส่ง

```jsonc
{ "type": "intent.void", "eventId": "<ใหม่>", "voids": "<eventId ที่ผิด>" }
```

แถวนั้นจะถูกตั้ง `voidedAt` — ไม่ถูกลบ (ยังตรวจย้อนได้) แต่ไม่นับในทุกสถิติ
และระบบจะคำนวณ "ตัวปัจจุบัน" ของคีย์นั้นใหม่ให้เอง

**อย่าใช้ `revision` เพื่อทำแบบนี้** — `revision` คือ "ค่าที่ส่งมาผิดรูป ขอส่งชุดเดิมใหม่"
ห้ามเปลี่ยน `customerId` หรือ `courseCode` ผ่าน `revision` (นั่นคือคนละเรื่อง ให้ใช้ eventId ใหม่)

## A9.4 ตารางเคสขอบ — ผลลัพธ์ที่ต้องได้

| สถานการณ์ | ผลที่ถูกต้อง |
|---|---|
| AI ประเมินใหม่ ผลเหมือนเดิมทุกอย่าง | ไม่ต้องส่ง (A9 กฎ 9) ถ้าส่งมาก็เก็บเป็นประวัติ |
| staff แก้เมื่อวาน · AI ประเมินบทสนทนาวันนี้ | ✅ AI ทับได้ กลายเป็นตัวปัจจุบัน |
| staff แก้เมื่อวาน · AI ประมวลผลย้อนหลังบทสนทนาสัปดาห์ก่อน | ❌ rejected — เถียงเรื่องที่คนตัดสินแล้ว |
| staff ตั้ง `sticky` · AI มีข้อมูลใหม่แค่ไหนก็ตาม | ❌ rejected — ต้องให้ staff ปลดเอง |
| event เก่ามาถึงทีหลัง (คิวค้าง) | เก็บเป็นประวัติ ตั้ง `supersededAt` ทันที ไม่ขึ้นเป็นตัวปัจจุบัน |
| `observedAt` เท่ากันเป๊ะ 2 แถว | staff ชนะ · เท่ากันอีกเอา confidence สูงกว่า · เท่าอีกเอาตัวที่มาถึงทีหลัง |
| ยังระบุตัวลูกค้าไม่ได้ (`customerId: null`) | เก็บไว้ **แต่ห้าม supersede อะไรทั้งนั้น** และไม่นับใน "ตัวปัจจุบัน" — พอ M3 จับคู่ได้ค่อยคำนวณสายใหม่ |
| ลูกค้า 2 คนถูก merge เป็นคนเดียว | ย้าย intent ทั้งหมดไปฝั่งผู้ชนะแล้วคำนวณสายใหม่ |
| `not_interested` ที่ INNER แต่ต่อมาซื้อ INNER | ไม่ขัดกัน — intent นั้นเป็นประวัติก่อนซื้อ · รายงานห้ามเรียกคนนี้ว่า "ไม่สนใจ" |
| `status: "hesitant"` แต่ไม่ส่ง `hesitationReason` | รับ แล้วเติม `unknown` ให้ |
| `hesitationReason` มาแต่ `status != "hesitant"` | ❌ rejected — ขัดกันในตัวเอง |
| `source: "staff"` ส่ง `confidence: 0.5` มา | บังคับเป็น 1.0 · `belowThreshold: false` เสมอ (คนไม่ได้เดา) |
| `source: "ai"` ไม่ส่ง `model` | ❌ rejected |
| `source: "staff"` ส่ง `model` มา | รับ แต่ไม่เก็บ |

## A9.5 เขตเวลา

`observedAt` ต้องมี timezone เสมอ (`2026-08-28T10:15:00+07:00` หรือ `...Z`)
รายงานทั้งหมดตัดเดือน/สัปดาห์ตาม **Asia/Bangkok** — ถ้าส่งเวลาแบบไม่มี timezone มา จะถูก reject
เพราะเดือนจะเหลื่อมกัน 7 ชั่วโมงและไม่มีทางรู้ว่าผิดตอนไหน

## A10. `type: "tag"` — ยังไม่เปิดใช้ใน M3.5

ป้ายอิสระ (`type: "tag"` และฟิลด์ `tags`) **ยังไม่มีพฤติกรรมฝั่งรับที่ตกลงกัน**
ยังไม่ได้ตัดสินว่า "ติดป้ายเพิ่ม" หรือ "แทนที่ป้ายเดิมทั้งชุด" หรือ "ลบป้ายเดียว" และเก็บประวัติที่ไหน

**สิ่งที่ฝั่งรับจะทำในระหว่างนี้**: รับไว้ ไม่ทิ้ง แต่ไม่เอาไปเขียนที่ไหน
บันทึกลง `partner_events` ตามปกติ แล้วตอบ `status: "quarantined"` เหตุผล `unsupported_type:tag`

ถ้าจะเปิดใช้ ต้องตกลงเพิ่ม 3 อย่างก่อน แล้วค่อยทำเป็นงานแยก
1. เป็น **การกระทำ** (`add` / `remove`) หรือ **สถานะเต็มชุด** (ส่งรายการทั้งหมดมาแทนที่ของเดิม)
2. เก็บที่ `customers.tags` ตรง ๆ (ทับของที่พนักงานติดเอง) หรือแยก namespace `partnerTags`
3. ต้องเก็บประวัติการติด/ถอดป้ายไหม

**คำแนะนำของฝั่งเรา**: อย่าใช้ `tag` เป็นช่องเก็บความสนใจ — ใช้ `intent` ที่มี schema ชัดแทน
ป้ายอิสระควรเหลือไว้เฉพาะเรื่องที่ไม่มีโครงจริง ๆ เช่น `vip`

## A6. ❌ ห้ามส่งข้อมูลเหล่านี้

- **บทสนทนากับลูกค้า ข้อความแชท รูปภาพ ไฟล์แนบ** — เด็ดขาด (D4: ระบบนี้ไม่เก็บบทสนทนา redact ตั้งแต่ webhook)
- **ข้อความที่อ้างอิงจากแชทในทุกรูปแบบ** — ห้ามมี field `quote`, `evidence`, `snippet`, `summary` ที่มีคำพูดลูกค้า
  แม้แต่ใน `tags` ก็ห้ามใส่ข้อความอิสระที่ลอกมาจากสิ่งที่ลูกค้าพิมพ์
  อยากบอกว่าทำไม AI สรุปแบบนั้น → ส่ง `confidence` อย่างเดียวพอ
- เลขบัตรประชาชน เลขพาสปอร์ต เลขบัตรเครดิต ข้อมูลสุขภาพ
- ที่อยู่เต็ม (ถ้าจำเป็นต้องมีค่อยคุยกันเพิ่ม ตอนนี้ไม่ต้อง)
- `customerId` ของระบบ LINE CRM — เราเป็นคนกำหนดเอง ห้ามส่งมาบอกว่าเป็นใคร
- field แปลกปลอมนอก schema — เราจะไม่เก็บและอาจปฏิเสธทั้ง event

## A7. การตอบกลับและการ retry

เราตอบ **HTTP 200 พร้อมผลรายตัว** เสมอเมื่อ signature ถูกและ body อ่านได้ — event เสียบางตัวไม่ทำให้ทั้ง batch ล้ม

```jsonc
{
  "ok": true,
  "requestId": "job_01...",
  "summary": { "accepted": 8, "duplicate": 1, "quarantined": 1, "rejected": 0 },
  "results": [
    { "eventId": "tagger-…-000123", "status": "accepted" },
    { "eventId": "tagger-…-000124", "status": "duplicate" },
    { "eventId": "tagger-…-000125", "status": "quarantined", "reason": "unknown_course:Mas Com#7" },
    { "eventId": "tagger-…-000126", "status": "pending_identity", "reason": "เบอร์ตรงกับลูกค้ามากกว่า 1 คน รอเจ้าหน้าที่ตรวจ" }
  ]
}
```

| status | แปลว่า | คุณต้องทำอะไร |
|---|---|---|
| `accepted` | บันทึกแล้ว | ไม่ต้องทำอะไร |
| `duplicate` | เคยส่งมาแล้ว | ไม่ต้องทำอะไร — ถูกต้องแล้ว |
| `quarantined` | รับไว้แล้วแต่ยังใช้ไม่ได้ รอคนแก้ (รวมถึง `unsupported_type:tag` ตาม A10) | ไม่ต้อง retry · ข้อมูลไม่หาย |
| `pending_identity` | รับไว้แล้ว แต่ยังไม่รู้แน่ว่าเป็นลูกค้าคนไหน | ไม่ต้อง retry |
| `rejected` | ข้อมูลผิด schema | **แก้แล้วส่งใหม่ด้วย eventId เดิม** |

รหัส HTTP อื่น

| รหัส | ความหมาย | ทำยังไง |
|---|---|---|
| 401 | signature/timestamp ไม่ถูก | ตรวจ secret และนาฬิกาเครื่อง **อย่า retry รัว ๆ** |
| 400 | body ไม่ใช่ JSON หรือเกินขนาด | แก้แล้วค่อยส่ง |
| 429 | ส่งถี่เกิน | รอแล้วค่อยส่งใหม่ |
| 5xx / timeout | ฝั่งเรามีปัญหา | **retry ด้วย eventId เดิม** แบบ exponential backoff (1s, 2s, 4s, … สูงสุด 5 ครั้ง) |

**ต้องมีคิวของตัวเอง** — ถ้าส่งไม่สำเร็จต้องเก็บไว้ส่งใหม่ ห้ามทิ้ง ระบบเราอาจ deploy อยู่ตอนที่คุณส่งพอดี

## A8. สิ่งที่ฝั่งเรารับประกันให้

- `eventId` เดิมส่งกี่ครั้งก็ไม่เกิดข้อมูลซ้ำ
- ไม่ทิ้งข้อมูลเงียบ — แปลงไม่ได้ก็เก็บใน quarantine พร้อมเหตุผล
- ไม่เดาว่าเป็นลูกค้าคนไหนเมื่อข้อมูลกำกวม (เบอร์ตรงกับหลายคน) → ตั้งธงรอคนตรวจ
- เราไม่ส่งชื่อ/เบอร์/อีเมลของลูกค้าออกไปให้ AI ภายนอก
- ตอบภายใน 10 วินาที

---

# §B สเปกฝั่งรับ (งานของโปรเจกต์นี้)

## B1. อยู่ในสโคป

1. `POST /api/partner/intake` + ตรวจ HMAC ด้วย secret แยกต่อ partner
2. `partner_events` — เก็บ event ดิบ + กันซ้ำด้วย unique index
3. `purchases` + `purchase_items` ใน `line_crm_dev` — โครงเดียวกับ `legacy_payments` / `legacy_enrollments` เพื่อให้ analytics รวมสองแหล่งได้ด้วย query เดียว
4. `customer_intents` — ผลประเมินความสนใจแบบ append-only (A9)
5. `partner_quarantine` — event ที่แปลงไม่ได้
6. ผูกเข้ากับลูกค้า: `lineUserId` → `identities` · ไม่มีก็ใช้ phone/email แบบมีเงื่อนไข (B4)
7. **scrub เข้า `line_crm_ai` ด้วยสคริปต์แยกของตัวเอง** `npm run partner:scrub`
   ลอกโครงจาก `scripts/scrub-legacy.ts` ทั้งดุ้น (claim/ack ผ่าน `aiSync` · `--all` · `--verify` · `--prune`)
   **ห้ามแตะ WF-D** — WF-D มีหน้าที่เดียวคือ mirror `customers` และเพิ่งเคลียร์เสร็จ อย่าไปยุ่ง
   collection ปลายทาง: `purchases_scrubbed` · `purchase_items_scrubbed` · `customer_intents_scrubbed`
8. **`reconcilePartnerIdentities()`** — จับเจ้าของให้รายการที่ `customerId: null` (B4.1)
9. tests

## B2. ❌ ไม่อยู่ในสโคป
- ไม่ทำหน้าจอให้เจ้าหน้าที่จัดการ quarantine (แค่เก็บข้อมูลไว้ให้ครบ)
- ไม่ทำ analytics/insights (M4)
- ไม่แตะ LIFF form, WF-A/C/D, Google Sheets
- ไม่ import `Inner.xlsx` ของจริง

## B3. โครงข้อมูล

```ts
export interface PartnerEventDoc {
  _id: string;                 // pev_<ULID>
  partnerId: string;
  eventId: string;             // ของ partner
  revision: number;
  type: "purchase" | "purchase.void" | "intent" | "intent.void";
  occurredAt: Date;
  receivedAt: Date;
  status: "accepted" | "quarantined" | "pending_identity" | "voided";
  reason: string | null;
  customerId: string | null;
  purchaseId: string | null;
  /** payload ดิบหลัง validate — ห้ามมีข้อความสนทนา */
  raw: Record<string, unknown>;
  schemaVersion: number;
}

export interface PurchaseDoc {          // เงิน — โครงเดียวกับ LegacyPaymentDoc
  _id: string;                          // pur_<ULID>
  customerId: string | null;            // null = ยังระบุตัวไม่ได้
  partnerId: string;
  externalPaymentId: string | null;
  amount: number | null;
  currency: string;
  paidAt: Date | null;
  year: number;
  month: number | null;
  saleRep: string | null;
  attribution: { source: string | null; adOrOrganic: string | null; campaignId: string | null; contentRef: string | null } | null;
  status: "active" | "voided";
  sourceEventId: string;
  aiSync: { dirty: boolean; syncedAt: Date | null; lockedAt: Date | null; attempts: number; claimId?: string };
  createdAt: Date; updatedAt: Date; schemaVersion: number;
}

export interface CustomerIntentDoc {    // ผลประเมินความสนใจ — append-only ห้ามทับ
  _id: string;                          // int_<ULID>
  customerId: string | null;
  courseCode: string | null;            // null = สนใจแบบยังไม่เจาะจงคอร์ส
  status: "interested" | "not_interested" | "hesitant" | "unknown";
  hesitationReason: "budget" | "not_needed" | "timing_conflict" | "not_ready" | "needs_approval" | "unknown" | null;
  confidence: number;                   // 0–1
  /** ต่ำกว่าเกณฑ์ = เก็บไว้แต่ไม่นับในสถิติ */
  belowThreshold: boolean;
  source: "ai" | "staff";
  /** soft = AI ทับได้ถ้า observedAt ใหม่กว่า · sticky = มีแต่ staff ปลดได้ (A9.2) */
  lock: "soft" | "sticky";
  model: string | null;                 // null ได้เมื่อ source = staff
  /** เวลาที่ลูกค้าพูด ไม่ใช่เวลาที่ AI ประมวลผล */
  observedAt: Date;
  /** มีค่าเมื่อมี intent ที่ observedAt ใหม่กว่าของคีย์เดียวกันเข้ามา */
  supersededAt: Date | null;
  /** ยกเลิกด้วย intent.void — ไม่ลบ ยังตรวจย้อนได้ แต่ไม่นับในทุกสถิติ */
  voidedAt: Date | null;
  partnerId: string;
  sourceEventId: string;
  aiSync: { dirty: boolean; syncedAt: Date | null; lockedAt: Date | null; attempts: number; claimId?: string };
  createdAt: Date; schemaVersion: number;
}

export interface PurchaseItemDoc {      // ที่นั่ง — โครงเดียวกับ LegacyEnrollmentDoc
  _id: string;                          // pit_<ULID>
  purchaseId: string;
  customerId: string | null;
  courseCode: string;
  courseLabel: string;
  kind: EnrollmentKind;                 // ใช้ type เดิมจาก legacy/courseCell.ts
  countsAsSeat: boolean;                // คำนวณจาก kind ห้ามให้ partner ส่งมาเอง
  sessionLabel: string | null;
  sessionStart: Date | null;
  sessionYear: number | null;
  createdAt: Date; schemaVersion: number;
}
```

**index**
- `partner_events`: `ux_partnerEvent {partnerId:1, eventId:1}` **unique** ← หัวใจของการกันซ้ำ
- `purchases`: `ix_customer {customerId:1}` · `ix_paidAt {paidAt:1}` · `ix_yearMonth {year:1,month:1}` · `ix_aiSyncQueue`
- `purchase_items`: `ix_purchase {purchaseId:1}` · `ix_courseSession {courseCode:1,sessionStart:1,countsAsSeat:1}`
- `customer_intents`: `ix_current {customerId:1, courseCode:1, supersededAt:1}` · `ix_observed {observedAt:1}` · `ix_funnel {status:1, hesitationReason:1, observedAt:1}` · `ix_aiSyncQueue`

## B4. ⭐ กฎการระบุตัวลูกค้า

| กรณี | ทำอะไร |
|---|---|
| มี `lineUserId` และเจอใน `identities` | ผูกกับ `customerId` นั้นเลย |
| มี `lineUserId` แต่ไม่เจอ | สร้างลูกค้าใหม่แบบ minimal + identity `line` (ทางเดียวกับ WF-A) |
| ไม่มี `lineUserId` · phone ตรงกับลูกค้า **1 คนเดียว** | ผูกได้ แต่ตั้ง `evidence: "phone_only"` |
| ไม่มี `lineUserId` · phone ตรงกับ **หลายคน** | **ห้ามเดา** → `status: "pending_identity"` · `customerId: null` |
| ไม่ตรงกับใครเลย | บันทึกไว้โดย `customerId: null` แล้วให้ `reconcilePartnerIdentities()` จับเจ้าของทีหลัง (B4.1) — **ไม่ใช่ M3** |

**ห้าม merge ลูกค้าอัตโนมัติจากข้อมูลที่ partner ส่งมา** (D3) — purchase ที่ยังไม่มีเจ้าของยังนับยอดขายได้ปกติ แค่ตอบไม่ได้ว่าใครซื้อ

## B4.1 ⭐ Reconciliation — จับเจ้าของย้อนหลัง

**M3 (`customer_links`) ทำคนละเรื่อง** — มันจับคู่ `customers_scrubbed` กับ `legacy_persons_scrubbed`
ไม่ได้ยุ่งกับ `purchases` / `customer_intents` ที่ `customerId: null` เลย **อย่าไปหวังพึ่งมัน**

M3.5 ต้องมีตัวจับเจ้าของของตัวเอง ทำงานกับข้อมูลใน `line_crm_dev`

```ts
/** จับเจ้าของให้ purchase/intent ที่ยังไม่มี customerId — รันซ้ำได้ปลอดภัย */
export async function reconcilePartnerIdentities(db: Db, options?: { dryRun?: boolean }): Promise<{
  scanned: number; resolved: number; stillPending: number; ambiguous: number;
}>;
```

ตรรกะ (ลำดับเดียวกับ B4):
1. หา `purchases` / `customer_intents` ที่ `customerId: null`
2. ดึง `subject` เดิมจาก `partner_events.raw` ของ `sourceEventId`
3. ลอง `lineUserId` → `identities` · ไม่เจอลอง phone · แล้ว email
4. ตรงกับ **1 คนเดียว** → เติม `customerId` ให้ทั้ง purchase, purchase_items และ intent ที่มาจาก event นั้น
5. ตรงกับหลายคน → คงไว้ที่ `null` และนับเป็น `ambiguous` (D3 — ห้ามเดา)
6. **ทุกครั้งที่เติม `customerId` ให้ intent ต้องคำนวณสาย supersede ของคีย์ `(customerId, courseCode)` นั้นใหม่ทั้งคีย์**
   เพราะตอนที่ยังเป็น null มันถูกห้าม supersede ใครไว้ (A9.4)

เรียกใช้ 2 จุด: ท้ายสคริปต์ `npm run partner:reconcile` และหลัง `intake` รับ event ที่มี `lineUserId` ใหม่
(ลูกค้าที่เพิ่งแอด LINE วันนี้ อาจมี purchase ค้างไร้เจ้าของจากเมื่อวาน)

## B5. กฎการคำนวณ

- `countsAsSeat` คำนวณจาก `kind` ที่ฝั่งเรา **ห้ามเชื่อค่าที่ partner ส่งมา**
- `amount` อยู่ที่ `purchases` เท่านั้น — `purchase_items` **ห้ามมี field เงิน** (บทเรียนจาก M1)
- `purchase.void` → ตั้ง `status: "voided"` ไม่ลบ record และไม่นับในสถิติ
- `revision` น้อยกว่าหรือเท่าที่มีอยู่ → ตอบ `duplicate` ไม่เขียนทับ

### กฎเฉพาะของ intent

- **append-only** — ไม่ลบของเก่า แค่ตั้ง `supersededAt`
- **"ตัวปัจจุบัน" ตัดสินจาก `observedAt` มากที่สุดของคีย์ ไม่ใช่แถวที่มาถึงล่าสุด**
  แถวที่ `observedAt` เก่ากว่าตัวปัจจุบัน ต้องถูกตั้ง `supersededAt` ตั้งแต่ตอน insert
  ⚠️ อย่า implement เป็น "ตัวปัจจุบัน = แถวที่ supersededAt เป็น null" เพียว ๆ เพราะ event ที่มาถึงสลับลำดับจะทำให้มี null สองแถว
- `observedAt` เท่ากัน → เรียง `source: staff` ก่อน → `confidence` สูงกว่า → `createdAt` ทีหลัง
- ⭐ **staff lock เป็นแบบมีขอบเขตเวลา ไม่ใช่ตลอดกาล (A9.2)**
  - `lock: "soft"` (ค่าเริ่มต้น) → AI ทับได้ถ้า `observedAt` **ใหม่กว่า** staff เท่านั้น
  - `lock: "sticky"` → AI ทับไม่ได้ทุกกรณี มีแต่ `source: "staff"` ที่ทับได้
  - AI ที่ `observedAt` เก่ากว่าหรือเท่ากับ staff ตัวปัจจุบัน → `rejected` พร้อมเหตุผล `staff_decided`
  - `lock` ที่มากับ `source: "ai"` → `rejected`
- `confidence < 0.6` → `belowThreshold: true` เก็บไว้แต่ analytics กรองออกโดยปริยาย
  `source: "staff"` → บังคับ `confidence: 1` และ `belowThreshold: false` เสมอ
- `customerId: null` (ยังระบุตัวไม่ได้) → **ห้าม supersede อะไรทั้งสิ้น** และไม่ถือเป็นตัวปัจจุบัน
  ต้องมีฟังก์ชันคำนวณสายใหม่เมื่อ M3 จับคู่ได้ภายหลัง
- ลูกค้าถูก merge → ย้าย intent ไปฝั่งผู้ชนะแล้วคำนวณสายใหม่ทั้งคีย์
- `intent.void` → ตั้ง `voidedAt` แล้วคำนวณตัวปัจจุบันของคีย์นั้นใหม่
- **ข้อเท็จจริงจากการซื้อชนะค่าประเมินเสมอ** — ถ้ามี `purchase` ของคอร์สนั้น อย่านำ `not_interested`/`hesitant`
  ของคอร์สเดียวกันไปใช้ตอบว่า "ไม่สนใจ" ให้ถือว่า intent นั้นเป็นประวัติก่อนซื้อเท่านั้น
- `status`/`hesitationReason` ที่ไม่อยู่ในรายการปิด → **quarantine ทั้ง event** ห้ามแปลงเป็น `unknown` เงียบ ๆ
  (ถ้าแปลงเงียบ วันที่ทีม tag เพิ่มค่าใหม่แล้วลืมบอก เราจะไม่มีวันรู้)

## B6. Tests

**Unit**
- ⭐ ส่ง event เดิม 2 ครั้ง → ครั้งที่ 2 เป็น `duplicate` และไม่เกิด purchase ใหม่
- ⭐ payment 1 ก้อนมี 3 lines → เกิด 1 purchase + 3 items · ผลรวมเงินเท่ากับ amount ไม่ใช่ 3 เท่า
- `kind: relearn/free/waitlist/refund/merchandise` → `countsAsSeat: false`
- partner ส่ง `countsAsSeat: true` มาพร้อม `kind: "relearn"` → ระบบต้องไม่เชื่อ
- courseLabel ที่ไม่รู้จัก → `quarantined` ไม่ throw ไม่ทำให้ event อื่นในชุดเดียวกันล้ม
- signature ผิด/timestamp เก่าเกิน 300 วิ → 401
- body > 1MB หรือ events > 100 → 400
- `purchase.void` → purchase เดิมเป็น `voided` และไม่ถูกนับ
- `revision` ต่ำกว่าเดิม → ไม่เขียนทับ
- ⭐ intent ใหม่ของคู่เดิม → ตัวเก่าได้ `supersededAt` ไม่ถูกลบ และยัง query ประวัติได้
- ⭐ AI ที่ `observedAt` **ใหม่กว่า** staff ตัวปัจจุบัน (lock soft) → **ทับได้** กลายเป็นตัวปัจจุบัน
  (ถ้าเทสนี้ไม่ผ่าน แปลว่าสถานะลูกค้าจะค้างอยู่กับคำแก้ของ staff ตลอดกาล)
- ⭐ AI ที่ `observedAt` เก่ากว่าหรือเท่ากับ staff ตัวปัจจุบัน → `rejected` เหตุผล `staff_decided`
- ⭐ staff `lock: "sticky"` → AI ที่ใหม่กว่าแค่ไหนก็ `rejected` · staff ทับได้
- `lock` ที่มากับ `source: "ai"` → `rejected`
- ⭐ event ที่ `observedAt` เก่ากว่ามาถึงทีหลัง → ตัวปัจจุบันไม่เปลี่ยน และมีแถว `supersededAt: null` แค่แถวเดียวเสมอ
- `observedAt` เท่ากันเป๊ะ staff กับ ai → staff เป็นตัวปัจจุบัน
- `source: "staff"` ส่ง `confidence: 0.5` → เก็บเป็น 1 และ `belowThreshold: false`
- `source: "ai"` ไม่ส่ง `model` → `rejected`
- `intent.void` → แถวนั้น `voidedAt` ไม่ใช่ถูกลบ และตัวปัจจุบันย้อนกลับไปเป็นแถวก่อนหน้า
- intent ที่ `customerId: null` → ไม่ถูกนับเป็นตัวปัจจุบันของใคร และไม่ supersede ของใคร
- `observedAt` ไม่มี timezone → `rejected`
- `type: "tag"` → `quarantined` เหตุผล `unsupported_type:tag` และไม่เขียนอะไรลง `customers.tags` (A10)
- ⭐ reconcile: purchase ที่ `customerId: null` แล้วต่อมามี identity ตรง 1 คน → ถูกเติมเจ้าของ
- ⭐ reconcile: ตรงกับ 2 คน → ยังเป็น `null` และนับเป็น ambiguous ไม่เดา
- ⭐ reconcile intent แล้วสาย supersede ถูกคำนวณใหม่ — ตัวปัจจุบันของคีย์นั้นเหลือ 1 แถว
- `partner:scrub --verify` บนฐานที่ sync ครบ → exit 0 · ลบ doc ปลายทางออก 1 ตัว → exit 1
- `confidence: 0.4` → `belowThreshold: true`
- `status: "maybe"` (ค่านอกรายการ) → `quarantined` ไม่ใช่แปลงเป็น `unknown`
- event ที่มี field `quote` / `evidence` / `snippet` → `rejected` (กัน D4 หลุด)
- intent ที่มี `hesitationReason` แต่ `status != "hesitant"` → `rejected`

**Integration** (`RUN_MONGO_INTEGRATION=true`)
- ยิง 100 event พร้อมกัน 2 รอบ → purchase เท่าเดิม (unique index ทำงาน)
- phone ตรงกับลูกค้า 2 คน → `pending_identity` และ `customerId: null`
- มี `lineUserId` ที่ยังไม่มีในระบบ → สร้างลูกค้าใหม่ + identity ถูกต้อง

**สคริปต์ทดสอบ** `npm run smoke:partner` — ยิง event ปลอมที่เซ็น signature ถูก แบบเดียวกับ `smoke:line`

## B7. เกณฑ์ผ่านงาน
- [ ] `RUN_MONGO_INTEGRATION=true npm test` ผ่าน **skipped = 0**
- [ ] `npm run typecheck` ผ่านทั้ง 3 ชุด
- [ ] ยิง event เดิมซ้ำ 10 ครั้ง → purchase 1 รายการ
- [ ] ยอดรวมจาก `purchases` เท่ากับผลรวม `amount` ที่ส่งเข้ามา (ไม่เบิ้ล)
- [ ] event ที่ courseLabel ไม่รู้จัก อยู่ใน quarantine ครบ ไม่หายเงียบ
- [ ] ส่ง intent 3 รอบให้คนเดิมคอร์สเดิม → มี 3 แถว ตัวปัจจุบัน 1 แถว ประวัติครบ
- [ ] ยิง event สลับลำดับเวลา 20 ตัว → ทุกคีย์มีตัวปัจจุบันแค่ 1 แถว และเป็นแถวที่ `observedAt` ใหม่สุดจริง
- [ ] สถานการณ์จริง: staff แก้ → ลูกค้าเปลี่ยนใจเดือนถัดมา → AI ทับได้ ไม่ค้าง
- [ ] ไม่มี field ใดใน `customer_intents` ที่มีข้อความจากแชทลูกค้า
- [ ] `npm run partner:scrub -- --verify` ผ่าน และ **ไม่มีการแก้ WF-D หรือไฟล์ใน `workflows/` เลย**
- [ ] `npm run partner:reconcile` รันซ้ำ 2 ครั้งได้ผลเท่ากัน (idempotent)
- [ ] เขียน `docs/27-s11-m35-report.md` พร้อมผลรันจริงจาก terminal

## B8. กฎที่ห้ามละเมิด
1. ห้ามเชื่อ `countsAsSeat` / `courseCode` จาก partner โดยไม่ตรวจ
2. ห้าม merge ลูกค้าอัตโนมัติจากเบอร์ที่ partner ส่งมา (D3)
3. ห้ามทิ้ง event เงียบ — แปลงไม่ได้ต้องเข้า quarantine พร้อมเหตุผล
4. ห้ามเก็บเงินไว้ที่ `purchase_items`
5. ห้าม log payload ที่มี PII — `logger.ts` redact อยู่แล้ว อย่าปิด
6. ห้ามใช้ `INTERNAL_HMAC_SECRET` ตัวเดียวกับ n8n
7. **ห้ามรับ field ที่มีข้อความจากแชท** (`quote`/`evidence`/`snippet`/`summary`) — ปฏิเสธทั้ง event (D4)
8. **ห้ามทับ intent เก่า** — append-only เท่านั้น ไม่งั้นตอบคำถาม funnel ไม่ได้ตลอดกาล
8.1 **ห้าม implement staff lock เป็นแบบถาวร** — ต้องเป็นแบบมีขอบเขตเวลาตาม A9.2
    ไม่งั้นสถานะลูกค้าจะค้างอยู่กับคำแก้ของ staff เก่าตลอดไป
9. **ห้ามให้ค่าประเมินจาก AI ปนกับข้อเท็จจริงจากการซื้อโดยไม่แยกป้าย**
10. business logic อยู่ใน `packages/core`

---

## B9. สิ่งที่มีอยู่แล้ว ใช้ซ้ำได้เลย อย่าเขียนใหม่

| ของที่มี | ที่อยู่ | ใช้ทำอะไรใน M3.5 |
|---|---|---|
| `verifyInternal` / `signInternal` | `packages/core/src/events/publisher.ts` | ตรวจ HMAC — **สูตรเดียวกันเป๊ะ** แค่เปลี่ยน secret เป็นของ partner |
| `readSignedJson` | `apps/web/lib/internal.ts` | แบบอย่างการอ่าน body ดิบ + ตรวจลายเซ็น (ต้องทำตัวใหม่ที่รับ `x-partner-id`) |
| `ok` / `fail` / `newRequestId` | `apps/web/lib/http.ts` | รูปแบบ response มาตรฐานของโปรเจกต์ |
| `parseCourseCell` + `EnrollmentKind` | `packages/core/src/legacy/courseCell.ts` | ชนิดของ `kind` และการตัดสิน `countsAsSeat` — **ห้ามนิยามใหม่** |
| `courseByHeader` / `courseByCode` / `COURSES` | `packages/core/src/legacy/courses.ts` | แปลง `courseLabel` → `courseCode` · ไม่รู้จักคืน `null` ให้เข้า quarantine |
| `LegacyPaymentDoc` / `LegacyEnrollmentDoc` | `packages/core/src/legacy/models.ts` | โครงที่ `PurchaseDoc` / `PurchaseItemDoc` ต้องเลียนแบบ เพื่อให้ M4 union สองแหล่งได้ |
| `personToken` · `phoneHash` · `emailHash` · `nameKeys` · `ageBand` | `packages/core/src/ai/tokens.ts` | scrub — **ห้าม copy สูตรไปเขียนใหม่ที่อื่น** |
| `scrubLegacyPayment` / `scrubLegacyEnrollment` | `packages/core/src/ai/scrubLegacy.ts` | แบบอย่างของ `scrubPurchase` / `scrubPurchaseItem` |
| `claimLegacyAiSync` / `ackLegacyAiSync` | `packages/core/src/legacy/aiQueue.ts` | คิว `aiSync` — generic รับชื่อ collection อยู่แล้ว ใช้กับ `purchases` ได้เลย |
| `ensureLegacyIndexes` / `ensureAiIndexes` / `verifyAiIndexes` | `packages/core/src/legacy/indexes.ts` · `ai/indexes.ts` | แบบอย่างการสร้างและ**ตรวจ** index (ตรวจถึง key + unique + sparse) |
| `scripts/scrub-legacy.ts` | — | **แม่แบบของ `scripts/scrub-partner.ts`** ทั้ง arg parsing, `--all/--verify/--prune`, exit code, ไม่พิมพ์ URI |
| `scripts/smoke-line-webhook.ts` | — | แบบอย่าง `smoke:partner` — ยิง request ที่เซ็นลายเซ็นถูกต้อง |
| `normalizePhone` / `normalizeEmail` | `packages/core/src/identity/normalize.ts` | normalize `subject.phone` ก่อนหาเจ้าของ |
| `resolveLiff` / `upsertFromLine` | `packages/core/src/identity/` | แบบอย่างการหาลูกค้าจาก identity และการสร้างลูกค้าใหม่แบบ minimal (B4) |
| `env()` แบบแบ่งกลุ่ม | `packages/core/src/env.ts` | เพิ่มกลุ่ม `partner` — ทุกตัว optional ขาดแล้วต้องไม่พังทั้งระบบ |

## §C คำถามที่ยังต้องการคำตอบจากฝั่งระบบ tag

ตอบได้เมื่อไรค่อยปรับสัญญา — ระหว่างนี้ฝั่งเราสร้างตาม §B ได้เลย

1. **ระบบ tag รู้ `lineUserId` ไหม** ← สำคัญที่สุด ถ้ารู้ การจับคู่จะแม่น 100% ถ้าไม่รู้ ต้องพึ่งเบอร์ซึ่งมีเคสกำกวม
2. **รู้ยอดเงินไหม** ถ้าไม่รู้ จะตอบ "ขายได้เท่าไร" ไม่ได้ ตอบได้แค่ "กี่คน กี่ที่นั่ง"
3. tag เป็นข้อความอิสระหรือมีรายการตายตัว — ถ้าอิสระ ต้องมีตารางแปลง tag → คอร์ส
4. ใครติด tag (เซล/ระบบอัตโนมัติ) และติดตอนไหนเทียบกับเวลาจ่ายเงิน
5. แก้ย้อนหลัง/ยกเลิกได้ไหม และระบบรู้ตัวไหมว่าแก้อะไรไป
6. คาดว่าส่งกี่ event ต่อวัน (มีผลกับการตั้ง rate limit)
7. **AI ประเมิน intent ตอนไหน** — ทุกข้อความ / ทุกครั้งที่จบบทสนทนา / วันละครั้ง
   มีผลกับจำนวน event และกับการอ่านผล (ประเมินทุกข้อความจะเห็นความสนใจแกว่งไปมา)
8. **โมเดลที่ใช้ประเมิน intent เป็นตัวไหน และข้อความลูกค้าออกนอกองค์กรไหม**
   ถ้าใช้ ChatGPT ผ่าน Hermes = บทสนทนาลูกค้าออกไปที่ผู้ให้บริการภายนอก
   ฝั่งเราไม่ได้ห้าม (เป็นระบบคนละตัว) แต่ต้องรู้ไว้เพราะกระทบ PDPA และ consent ที่ลูกค้าเซ็น
9. **วัดความแม่นของ AI ยังไง** — มีชุดที่คนตรวจแล้วเทียบไหม ถ้าไม่มี ตัวเลข "คนสนใจ 50 คน" จะไม่มีใครรู้ว่าเชื่อได้แค่ไหน

---

# §D ขอบเขตของระบบ tag และเส้นทางการรวมโปรเจกต์ทีหลัง

> **อ่านหัวข้อนี้ก่อนเริ่มสร้างระบบ tag**
> §A บอกว่า "ส่งอะไรมา" · §D บอกว่า "สร้างอะไร และห้ามสร้างอะไร"
> เขียนไว้เพื่อให้วันหนึ่งถ้าจะรวมสองระบบเป็นโปรเจกต์เดียว จะรวมได้ด้วยการรื้อไม่กี่สิบบรรทัด
> ไม่ใช่ต้องยุบสองระบบที่ทับซ้อนกัน

## D1. ทำไมถึงแยกโปรเจกต์ตั้งแต่แรก

ไม่ใช่เหตุผลทางเทคนิค แต่เป็น **ขอบเขตข้อมูล**

LINE CRM มีกฎที่ประกาศไว้และพิสูจน์ได้จากโค้ด
- **D4** ไม่เก็บบทสนทนา LINE — redact ตั้งแต่ webhook ก่อน insert
- **S9** AI ไม่เห็น PII เลย — ตรวจระดับ wire แล้วว่าสิ่งที่ออกไปหา LLM มีแต่ตัวเลขกับ boolean

ระบบ tag ทำตรงข้ามโดยเนื้องาน — **มันต้องอ่านบทสนทนา** และส่งให้โมเดลภาษา
ถ้าอยู่ repo/deployment เดียวกัน คำรับประกันสองข้อข้างบนจะพิสูจน์ยากขึ้นมาก
และคนที่มาตรวจ PDPA จะแยกไม่ออกว่าส่วนไหนแตะแชท ส่วนไหนไม่แตะ

**การแยกจึงไม่ใช่ความไม่สะดวก แต่เป็นตัวขอบเขตเอง**

## D2. ใครรับผิดชอบอะไร

| เรื่อง | ระบบ tag | LINE CRM |
|---|---|---|
| อ่านบทสนทนา / เรียกโมเดลวิเคราะห์ | ✅ เจ้าของ | ❌ ไม่แตะเลย |
| ตัดสินว่าลูกค้าสนใจ/ลังเล/ไม่สนใจ | ✅ เจ้าของ | ❌ รับผลมาเก็บอย่างเดียว |
| รู้ว่าใครซื้ออะไร จ่ายเท่าไร ใครขาย | ✅ เจ้าของ | ❌ รับมาบันทึก |
| คิว/retry ของตัวเองตอนส่งไม่สำเร็จ | ✅ เจ้าของ | — |
| **ระบุตัวลูกค้า / dedupe / merge** | ❌ **ห้ามทำ** | ✅ เจ้าของ |
| **ตัดสินว่าลูกค้าเก่าหรือใหม่** | ❌ **ห้ามทำ** | ✅ เจ้าของ |
| **สถิติ ยอดขาย รายงาน** | ❌ **ห้ามทำ** | ✅ เจ้าของ |
| **พจนานุกรมคอร์ส** | ❌ อ้างอิงของ CRM | ✅ เจ้าของ (`courses.ts`) |
| PDPA consent ของลูกค้า | ร่วมรับผิดชอบ (ดู D5) | ✅ เก็บหลักฐาน |

## D3. ❌ สิ่งที่ห้ามสร้าง (สำคัญที่สุดในหัวข้อนี้)

ถ้าสร้างสิ่งเหล่านี้ วันรวมโปรเจกต์จะกลายเป็นการยุบสองระบบที่ทับซ้อนกัน ซึ่งแพงกว่าการเขียนใหม่

**1. ตารางลูกค้าของตัวเอง / ระบบ dedupe / merge**
ระบบ tag ไม่ต้องรู้ว่า "สมชายในแชทนี้" กับ "สมชายที่ซื้อเมื่อเดือนก่อน" เป็นคนเดียวกันไหม
ส่ง `lineUserId` (หรือเบอร์/อีเมล) มาให้ CRM จับเอง (§B4) — CRM มี `customer_links`, `pendingMerge`,
กติกา D3 เรื่องห้าม auto-merge ด้วยเบอร์ และ M3 match engine ที่ทดสอบแล้วอยู่

> เก็บ `lineUserId` ↔ ข้อมูลภายในของตัวเองได้ (ต้องมีอยู่แล้วเพื่อทำงาน)
> แต่**อย่าสร้าง "customer profile" ที่พยายามเป็นแหล่งความจริงคู่ขนาน**

**2. สถิติ/รายงาน/dashboard ของตัวเอง**
CRM มี M4 ที่คิดเลขให้แล้ว พร้อมกฎที่พลาดง่ายซึ่งแก้ไปแล้ว (เงินอยู่ที่ payment ไม่ใช่คอร์ส ·
ที่นั่งนับเฉพาะที่ขายได้จริง · ตัดเดือนตาม Asia/Bangkok)
ถ้าทำเองจะได้ตัวเลขคนละชุดกับ CRM แล้วไม่มีใครรู้ว่าอันไหนถูก

**3. พจนานุกรมคอร์สของตัวเอง**
ใช้รหัสใน §A5 ตรง ๆ · ถ้าเจอคอร์สใหม่ให้ส่ง `courseLabel` มาแล้วแจ้งให้ CRM เติมพจนานุกรม
**อย่าเดารหัสเอง** ระบบจะ quarantine ให้และรายงานกลับ ข้อมูลไม่หาย

**4. เขียนอะไรลง MongoDB ของ CRM โดยตรง**
ไม่ว่าจะได้ URI มาด้วยเหตุผลใด — ทุกอย่างผ่าน `/api/partner/intake` เท่านั้น
เหตุผล: CRM มี invariant ที่บังคับในโค้ด (idempotency, countsAsSeat คำนวณเอง, supersede chain ของ intent)
เขียนตรงเข้า DB = ข้ามกฎพวกนี้ทั้งหมดโดยไม่มีอะไรเตือน

**5. ส่งบทสนทนา ข้อความ หรือคำพูดของลูกค้าเข้ามา**
ห้ามทุกรูปแบบ รวมถึง field ชื่อ `quote` / `evidence` / `snippet` / `summary` (ดู A6)

## D4. โครงภายในที่แนะนำสำหรับระบบ tag

ออกแบบให้ event ที่ส่งออกเป็น **interface ภายในของตัวเองด้วย** ไม่ใช่แปลงตอนจะส่ง
แบบนี้วันรวมโปรเจกต์แค่เปลี่ยน transport จาก HTTP เป็นเรียกฟังก์ชัน

```
[ LINE OA / แหล่งแชท ]
          │
          ▼
┌──────────────────────┐   โมดูลนี้คือส่วนเดียวที่แตะบทสนทนา
│  chat-ingest         │   ต้องแยกออกมาให้ชัด ห้ามปนกับส่วนอื่น
└──────────┬───────────┘
           ▼
┌──────────────────────┐   เรียกโมเดล · แปลงผลเป็น status/reason/confidence
│  intent-analyzer     │   ผลลัพธ์ต้องไม่มีข้อความจากแชทติดออกมา
└──────────┬───────────┘
           ▼
┌──────────────────────┐   ⭐ ขอบเขตสำคัญ: จากจุดนี้เป็นต้นไปห้ามมีข้อความลูกค้าอีก
│  event-builder       │   สร้าง event ตามรูปแบบ §A2
└──────────┬───────────┘
           ▼
┌──────────────────────┐   คิว + retry + จำ eventId ที่ส่งไปแล้ว
│  outbox              │   ส่งไม่สำเร็จต้องเก็บไว้ส่งใหม่ ห้ามทิ้ง
└──────────┬───────────┘
           ▼
   POST /api/partner/intake
```

**สิ่งที่ระบบ tag ต้องมีเองแน่ ๆ**

| ส่วน | ทำไมต้องมี |
|---|---|
| **outbox + retry** | CRM อาจ deploy อยู่ตอนคุณส่งพอดี · 5xx/timeout ต้องส่งใหม่ด้วย `eventId` เดิม (A7) |
| **ตารางจำ `eventId` ที่ส่งแล้ว** | `eventId` ต้องคงที่เมื่อ retry ถ้าสร้างใหม่ทุกครั้ง **ยอดขายจะนับซ้ำ** (A3) |
| **กันส่งซ้ำเมื่อผลไม่เปลี่ยน** | จำผล intent ล่าสุดที่ส่งไป ส่งเฉพาะตอนเปลี่ยน (A9 กฎ 9) |
| **บันทึกว่า CRM ตอบอะไรกลับ** | `quarantined` / `pending_identity` ต้องมีคนมาดูและแก้ ไม่ใช่ปล่อยเงียบ |

## D5. PDPA — เรื่องที่ต้องตัดสินก่อนเก็บแชท

ข้อความ consent ที่ลูกค้าเซ็นในฟอร์ม LIFF ปัจจุบันเขียนว่า
*"ยินยอมให้เก็บและใช้ข้อมูลส่วนบุคคลเพื่อการให้บริการ"*

การเอาบทสนทนาไปวิเคราะห์พฤติกรรมด้วย AI อาจเกินขอบเขตของข้อความนี้ โดยเฉพาะเมื่อ
**โมเดลที่ใช้อยู่นอกองค์กร** (Hermes ที่ใช้ ChatGPT เบื้องหลัง = ข้อความออกไปที่ผู้ให้บริการภายนอก)

ต้องมีคนตัดสิน 4 ข้อ **ก่อน** ระบบขึ้นใช้จริง — ไม่ใช่หลังจากเก็บข้อมูลไปแล้ว

1. เก็บบทสนทนาไว้นานแค่ไหน และลบเมื่อไร
2. ข้อความออกนอกองค์กรได้ไหม ถ้าไม่ได้ต้องใช้โมเดลที่รันในองค์กร
3. ข้อความ consent ต้องแก้ให้ครอบคลุมการวิเคราะห์ด้วยไหม
4. ลูกค้าขอให้ลบข้อมูล ระบบ tag ลบได้จริงไหม (รวมถึงที่ส่งเข้า CRM แล้ว)

**ฝั่ง CRM ไม่ได้ห้ามเรื่องนี้** เพราะเป็นระบบคนละตัว แต่ต้องรู้ไว้ว่านี่คือต้นทุนที่ต้องจ่าย
และ **จ่ายเท่าเดิมไม่ว่าจะรวมโปรเจกต์หรือไม่** แค่เลื่อนเวลาจ่าย

## D6. ทดสอบโดยไม่ต้องรอ CRM

พัฒนาคู่ขนานได้เต็มที่ ไม่ต้องรอ endpoint จริง

**1. ตั้ง mock endpoint ของตัวเอง** ที่ตรวจลายเซ็นด้วยสูตรเดียวกัน (A1) แล้วตอบตามรูปแบบ A7
ทดสอบให้ครบทั้ง `accepted` / `duplicate` / `quarantined` / `pending_identity` / `rejected` / 401 / 429 / 5xx

**2. contract test ที่ต้องผ่านก่อนบอกว่าเสร็จ**
- ส่ง `eventId` เดิม 10 ครั้ง → ปลายทางต้องได้ `duplicate` 9 ครั้ง และ**ฝั่งคุณต้องไม่สร้าง eventId ใหม่**
- ยิงตอน mock ตอบ 500 → outbox ต้องเก็บไว้แล้วส่งใหม่ด้วย `eventId` เดิม
- payload ที่สร้างต้อง**ไม่มี**อักษรที่มาจากข้อความลูกค้า — assert ด้วย regex บน `JSON.stringify(event)`
- การชำระ 1 ก้อนที่มี 2 คอร์ส → ต้องเป็น **1 event ที่มี 2 lines** ไม่ใช่ 2 event (A4)
- `intent` ที่ผลไม่เปลี่ยนจากครั้งก่อน → ต้องไม่ส่ง
- นาฬิกาเครื่องเพี้ยนเกิน 300 วิ → ต้องจับได้เองก่อนส่ง ไม่ใช่รอ 401

**3. ขอ staging จาก CRM เมื่อพร้อม** — ต้องการ `partnerId` + secret (ยังไม่ได้ออกให้)

## D7. เส้นทางการรวมโปรเจกต์ทีหลัง

ถ้าวันหนึ่งตัดสินใจรวม **ฝั่ง CRM รื้อแค่นี้**

| ของที่ทิ้ง | บรรทัด |
|---|---|
| `apps/web/app/api/partner/intake/route.ts` | 35 |
| `apps/web/lib/partner.ts` (verify HMAC) | 37 |
| **รวม** | **72 บรรทัด** |

`packages/core/src/partner/` (1,024 บรรทัด) **ไม่ต้องแตะเลย** เพราะ
`intakePartnerEvents(partnerId, events)` เป็นฟังก์ชันธรรมดาที่ไม่รู้ว่าข้อมูลมาจาก HTTP หรือไม่
ระบบ tag ที่รวมเข้ามาก็เรียกฟังก์ชันนี้ตรง ๆ แทนการยิง HTTP

**ฝั่งระบบ tag รื้อแค่ชั้น outbox/transport** ถ้าทำตาม D4 (ใช้ event เป็น interface ภายใน)

**สิ่งที่ต้องทำเพิ่มตอนรวม และไม่เกี่ยวกับโค้ด**
- แก้หน้านโยบายความเป็นส่วนตัว — ประโยค "ไม่เก็บบทสนทนา" จะใช้ไม่ได้อีกต่อไป
- แก้ข้อความ consent ในฟอร์ม LIFF
- ทบทวน D4 และ S9 ในเอกสารทั้งชุด
- ทบทวนสิทธิ์ Mongo user — ตอนนี้แยก 3 ตัวตามหน้าที่ การรวมทำให้ขอบเขตกว้างขึ้น

## D8. Checklist

**ก่อนเริ่มเขียนโค้ด**
- [ ] อ่าน §A ทั้งหมด โดยเฉพาะ A3 (idempotency) · A4 (เงิน 1 ก้อน) · A9.1–A9.4 (supersede + staff lock)
- [ ] อ่าน §D3 รายการห้ามสร้าง
- [ ] ตอบคำถามใน §C ข้อ 1 และ 2 ให้ได้ก่อน (รู้ `lineUserId` ไหม · รู้ยอดเงินไหม) — สองข้อนี้กำหนดว่าระบบจะมีประโยชน์แค่ไหน
- [ ] ตัดสิน 4 ข้อใน §D5 หรืออย่างน้อยรู้ว่าใครเป็นคนตัดสิน

**ก่อนบอกว่าเสร็จ**
- [ ] contract test ใน §D6 ผ่านครบ
- [ ] ไม่มีโค้ดส่วนไหนสร้างตารางลูกค้า/สถิติ/พจนานุกรมคอร์สของตัวเอง
- [ ] โมดูลที่แตะบทสนทนาแยกออกมาชัดเจน และไม่มีข้อความลูกค้าไหลออกจากโมดูลนั้น
- [ ] outbox ทดสอบแล้วว่าส่งซ้ำด้วย `eventId` เดิมจริง
- [ ] มีที่ให้คนดู event ที่ถูก `quarantined` / `pending_identity`

## D9. ถ้าเจอว่าสัญญาไม่ครอบคลุม

**หยุดถามก่อน อย่าเดา** — รอบที่แล้วผู้ทำหยุดถาม 6 ข้อก่อนเขียนโค้ด ทั้ง 6 เป็นช่องโหว่จริงในสัญญา
ถ้าเดาไปเองแล้วเขียนโค้ดทับ จะเสียเวลามากกว่าเดิม

สิ่งที่ต้องแจ้งกลับมาแน่ ๆ
- คอร์สใหม่ที่ยังไม่มีในพจนานุกรม (§A5)
- ค่า `status` / `hesitationReason` ที่อยากเพิ่มนอกรายการปิด (§A9) — **อย่าส่งค่าใหม่มาเงียบ ๆ ระบบจะ quarantine ทั้ง event**
- ฟิลด์ที่อยากส่งเพิ่มแต่ไม่มีในสัญญา
