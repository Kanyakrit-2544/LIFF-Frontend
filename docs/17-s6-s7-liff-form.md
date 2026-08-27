# S6 + S7 — หน้า LIFF + รับข้อมูลเข้าระบบ

รวมสองขั้นเข้าด้วยกัน เพราะฟอร์มที่กด Submit ไม่ได้ ทดสอบใน LINE จริงไม่ได้

## 17.1 สิ่งที่สร้าง

| ไฟล์ | หน้าที่ |
|---|---|
| `app/liff/page.tsx` · `LiffApp.tsx` · `Field.tsx` · `liff.css` | หน้า LIFF — โหลด SDK, login, render ฟอร์มจาก schema, submit |
| `app/api/liff/customer/profile/route.ts` | รับข้อมูล — validate ตาม schema, merge, เขียน DB |
| `customers/applyFormSubmission.ts` | business logic ของการรับฟอร์ม |
| `identity/merge.ts` | รวมลูกค้าสองคนแบบมี audit และย้อนกลับได้ |
| `lib/afterSafe.ts` | เรียกงานเบื้องหลังโดยไม่ให้ล้มทั้ง request |

**LIFF SDK โหลดจาก CDN** (`static.line-scdn.net/liff/edge/2/sdk.js`) ไม่ใช่ npm — เพราะ npm cache บนเครื่องมีปัญหาสิทธิ์ และ CDN เป็นวิธีที่ LINE แนะนำอยู่แล้ว

---

## 17.2 การออกแบบหน้าจอ

**สะอาด เรียบง่าย เน้นใช้งาน** ตามที่เลือกไว้ — หน้านี้เปิดในแอป LINE บนมือถือเป็นหลัก

| การตัดสินใจ | เหตุผล |
|---|---|
| `font-size: 16px` ในทุก input | ต่ำกว่านี้ iOS จะซูมหน้าเองตอนโฟกัส ทำให้เลย์เอาต์เพี้ยน |
| สีเน้น `#06c755` (เขียว LINE) | กลมกลืนกับแอปที่ผู้ใช้กำลังใช้อยู่ ไม่รู้สึกว่าหลุดออกไปเว็บอื่น |
| รองรับ dark mode | LINE มีโหมดมืด ถ้าไม่ทำหน้าจะขาวจ้าตัดกับแอป |
| `inputMode` + `autoComplete` ตามชนิด field | แป้นพิมพ์มือถือขึ้นตรงชนิด ลดการพิมพ์ผิดเบอร์ |
| ตัด section ที่มีแต่ field อ่านอย่างเดียว | header แสดงรูปกับชื่อ LINE อยู่แล้ว — เดิมโชว์ซ้ำสองรอบ |
| error แสดงใต้ช่องที่ผิด + เลื่อนหน้าไปหา | บนมือถือถ้าไม่เลื่อนให้ ผู้ใช้จะไม่เห็นว่าผิดตรงไหน |

**สถานะครบทุกทาง:** loading · เปิดนอกแอป LINE · error พร้อมปุ่มลองใหม่ · ฟอร์ม · สำเร็จพร้อมปุ่มปิดหน้า

---

## 17.3 กลไกที่กันปัญหาไว้

### idempotency key ผูกกับรอบการกรอก ไม่ใช่ต่อการกด
`idemKey` สร้างครั้งเดียวตอนเปิดหน้าและใช้ตลอด → กดส่งรัว ๆ หรือเน็ตหลุดแล้วกดใหม่ **ไม่เกิด revision ซ้ำ**
มี test ยิงพร้อมกัน 3 request ด้วย key เดียว → `customer_profiles` มี 1 record

### customerId มาจาก session เท่านั้น
route ไม่อ่าน `customerId` จาก body — มี test ส่ง `customerId` ของคนอื่นเข้าไป แล้วยืนยันว่าข้อมูลคนนั้นไม่ถูกแตะ

### auto-merge เมื่อเบอร์ตรง (D3)
กรอกเบอร์ที่ตรงกับลูกค้าที่มีอยู่ → `mergeCustomers()` ย้าย identity/profile/interaction ไปหา winner
loser เป็น tombstone (`status:"merged"`) **ไม่ลบทิ้ง** เพราะระบบอื่นอาจยังถือ id เก่า และต้องย้อนกลับได้
ทุกครั้งเขียน `audit_logs` ไว้

winner เลือกจาก: identity ที่ verified มากกว่า → createdAt เก่ากว่า → ข้อมูลครบกว่า
field ที่ winner ว่างจะเติมจาก loser (fill-forward) **ไม่ทับของที่มีอยู่**

### `formVersion` ที่ไม่ published แล้ว → 409
ฟอร์มที่เปิดค้างไว้ข้ามวันจะไม่บันทึกตาม schema เก่าที่เลิกใช้แล้ว — client รับ 409 แล้วโหลดใหม่อัตโนมัติ

---

## 17.4 บั๊กที่เจอระหว่างทาง

### 🔴 `after()` ทำให้ request 500 ทั้งที่บันทึกสำเร็จแล้ว

`after()` ของ Next โยน error เมื่อถูกเรียกนอก request scope ถ้าปล่อยหลุดจะกลายเป็น 500
**ทั้งที่ข้อมูลเข้า MongoDB เรียบร้อยไปแล้ว** → ผู้ใช้เห็น error แล้วกดส่งใหม่ ทั้งที่ของเข้าระบบไปแล้ว

แก้ด้วย `safeAfter()` ที่หุ้ม try/catch สองชั้น — งานเบื้องหลังเป็น best-effort เสมอ
(n8n มี pull mode คอยเก็บตกอยู่แล้ว) ใช้กับ `/api/webhook/line` ด้วยเพราะเสี่ยงแบบเดียวกัน

### 🟠 Historical pre-S9: `PII_KEY` ใน `.env.local` decode ได้ 29 ไบต์ ไม่ใช่ 32

ค่าที่ผมใส่ไว้ตั้งแต่ S1 ผิด — env validation จับได้ถูกต้อง แต่แปลว่า **เส้นทางเข้ารหัส PII ไม่เคยถูกใช้จริงเลย**
จนกระทั่งฟอร์มตัวแรกถูกส่ง (S1–S5 ไม่มีการเขียนเบอร์/อีเมล) สร้างใหม่แล้ว

> S9 ถอด `PII_KEY`/field encryption ออกจาก DB หลักแล้ว ข้อมูลส่วนนี้เป็นบันทึกเหตุการณ์เก่า ไม่ใช่ design ปัจจุบัน

### 🟡 test ของผมเองเปราะ
เทส "ไม่เกิดลูกค้าซ้ำ" นับ `customers` ทั้ง collection ซึ่งชนกับ test file อื่นที่ vitest รันขนาน — แก้ให้นับเฉพาะของตัวเอง

---

## 17.5 ผลทดสอบ

**159 tests ผ่าน** (core 115 + web 44) · typecheck 0 error · build ผ่าน

ยิงจริงผ่านเบราว์เซอร์ (mobile viewport) ต่อ Atlas:
```
1. เปิด /liff → ฟอร์มขึ้นครบ 3 section
2. กรอกเบอร์ผิด "123" แล้วกดส่ง
   → "เบอร์โทรศัพท์: เบอร์โทรไม่ถูกต้อง" ใต้ช่องเบอร์ + aria-invalid ถูกตั้ง
3. แก้เป็น "081-234-5678" แล้วส่ง → หน้าสำเร็จ
```

ข้อมูลที่เข้า Atlas จริง:
```json
{ "displayName": "สมชาย ใจดี", "nickname": "ชาย", "birthYear": 2535,
  "phone": "+66812345678", "email": "somchai@gmail.com",
  "consent": { "dataProcessing": true, "marketing": true, "version": "v1",
               "grantedAt": "...", "ip": "...", "userAgent": "..." },
  "tags": ["form-completed"], "counters": { "formSubmits": 1 },
  "sheetSyncDirty": true }

customer_profiles revision 1 — เบอร์ normalize เป็น E.164, อีเมลเป็นตัวพิมพ์เล็ก
interactions: ["form_submit"]
```
✅ ตรวจ dark mode แล้วเช่นกัน

---

## 17.6 โหมด preview สำหรับพัฒนา

`/liff?preview=1` ข้าม LIFF SDK แล้วใช้ session cookie ที่มีอยู่ — ไว้ดูหน้าตาระหว่างแก้ UI โดยไม่ต้องเปิดผ่าน LINE ทุกครั้ง

เปิดได้เฉพาะ `NODE_ENV !== "production"` และ **API ยังตรวจ session เหมือนเดิมทุกจุด** — ไม่ใช่ทางลัดข้ามการยืนยันตัวตน

---

## 17.7 ยังทดสอบไม่ได้ จนกว่าจะ deploy

เส้นทาง LIFF จริง (`liff.init` → `login` → `getIDToken` → verify กับ LINE) ต้องเปิดจากแอป LINE
โหมด preview ข้ามส่วนนี้ไป ส่วน test ใช้ mock ของ LINE verify API

**สิ่งที่ยังพิสูจน์ไม่ได้จนกว่าจะเปิดใน LINE จริง:** `aud` ของ id_token ตรงกับ `LINE_LOGIN_CHANNEL_ID` หรือไม่
