# S5 — LIFF Auth + Form Schema

## 16.1 สิ่งที่สร้าง

| ไฟล์ | หน้าที่ |
|---|---|
| `security/lineIdToken.ts` | verify LINE ID Token กับ LINE API + ตรวจ `iss`/`aud`/`exp` ซ้ำฝั่งเรา |
| `security/session.ts` | JWT HS256 → session cookie (HttpOnly, SameSite=Lax, 30 นาที) |
| `identity/resolveLiff.ts` | หาลูกค้าจาก LIFF โดยไม่สร้างซ้ำกับคนที่แอดเพื่อนมาแล้ว |
| `forms/types.ts` | โครง `form_schemas` |
| `forms/buildZod.ts` | สร้าง zod validation จาก schema ใน DB |
| `forms/schemaStore.ts` | อ่าน/เขียน schema |
| `api/liff/session` | รับ id_token → ออก session |
| `api/liff/bootstrap` | profile + prefill + form schema ใน request เดียว |
| `scripts/seed-form-schema.ts` | ใส่ฟอร์มตัวแรก (`npm run seed:form`) |

---

## 16.2 สามเรื่องที่ตัดสินใจระหว่างทาง

### ก. ตัวตนมาจาก `sub` ของ id_token เท่านั้น

`liff.getProfile().userId` อยู่ฝั่ง browser — ใครเปิด DevTools ก็ส่ง userId ของคนอื่นมาได้
route จึง **ไม่อ่าน `userId` หรือ `customerId` จาก body เลย** และมี test คุมไว้ว่าส่งมาก็ไม่มีผล

ตรวจซ้ำฝั่งเราเองด้วย ไม่พึ่ง LINE อย่างเดียว: `iss === https://access.line.me`, `aud === LINE_LOGIN_CHANNEL_ID`, `exp > now`

### ข. ⭐ กันลูกค้าซ้ำระหว่าง webhook กับ LIFF

คนคนเดียวเข้ามาได้สองทาง:
```
แอดเพื่อน → webhook → identity { provider:"line",       channelId: <destination> }
เปิด LIFF  → id_token → sub
```
LINE ใช้ user id เดียวกันทุก channel ที่อยู่ใต้ provider เดียวกัน → `sub` คือ `source.userId` ตัวเดิม

ถ้า resolve ด้วย `(provider:"line_login", channelId:<login channel>)` ตรง ๆ จะ **ไม่เจอ identity เดิม แล้วสร้างลูกค้าใหม่ซ้ำกับคนที่เพิ่งแอดเพื่อนมา**

`resolveLiffCustomer()` จึงค้นจาก `externalId` ก่อนโดยไม่สนใจ `channelId` แล้วค่อย fallback ไปสร้างใหม่ (กรณีเปิด LIFF ก่อนแอดเพื่อน ซึ่งเกิดได้ถ้าได้ลิงก์มาจากที่อื่น)

มี test คุม: follow ก่อน → เปิด LIFF → `customers` ไม่เพิ่ม, `identities` ยังมีเส้นเดียว

### ค. validation สร้างจาก schema ใน DB ไม่ hardcode

ถ้า validation ฝั่ง server เป็น hardcode แล้วคำถามใน DB เปลี่ยน จะเกิดช่องว่างทันที — field ใหม่ผ่านเข้ามาโดยไม่ถูกตรวจ หรือ field ที่ลบไปแล้วยังบังคับกรอกอยู่

`buildZodFromSchema()` ใช้ **`.strict()` เสมอ** → field ที่ไม่อยู่ใน schema ทำให้ parse ล้มเหลว ไม่ใช่ถูกเมินเงียบ ๆ
กัน mass assignment: ยิง `customerStatus:"vip"` หรือ `isAdmin:true` แนบมากับฟอร์ม = ถูกปฏิเสธทั้งก้อน

---

## 16.3 ฟอร์มที่ seed ไว้

`customer_onboarding@v1` — 4 section 12 field ตาม [docs/08 §8.2](08-liff-fields-and-sheets.md)

```
[line]     pictureUrl (image) · lineDisplayName (readonly)
[identity] fullNameTh* 🔒 · nickname · fullNameEn 🔒 · birthYear (86 ตัวเลือก) · phone* 🔒 · email 🔒
[social]   facebook · instagram
[consent]  consentDataProcessing* · consentMarketing
```

`birthYear` เก็บเป็น `select` ธรรมดาพร้อมตัวเลือก 86 ปี โดยตั้งใจ — ไม่ทำ field type พิเศษ
จะได้เปลี่ยนช่วงปีได้โดยแก้แค่ seed ไม่ต้องแก้โค้ดทั้ง client และ server

---

## 16.4 ผลทดสอบ

**145 tests ผ่าน** (core 115 + web 30) — เพิ่มจาก S4 มา 44 เคส

เคสสำคัญที่ครอบไว้:
```
✅ id_token ของ channel อื่น → 401 WRONG_AUDIENCE
✅ id_token หมดอายุ → 401 EXPIRED (frontend เอาไปสั่ง liff.login() ใหม่ได้)
✅ ส่ง userId/customerId ปลอมมากับ body → ไม่มีผล ใช้ sub จาก token
✅ payload ใน session cookie ถูกแก้ → BAD_SIGNATURE
✅ คนที่แอดเพื่อนมาก่อนแล้วเปิด LIFF → ไม่เกิดลูกค้าซ้ำ
✅ ชื่อจริงที่ลูกค้ากรอกไม่ถูกทับด้วยชื่อ LINE (regression จาก docs/12)
✅ bootstrap ไม่คืน phoneEnc / phoneHash / lineUserId ออกไป
✅ field แปลกปลอมในฟอร์มถูกปฏิเสธ (mass assignment)
✅ consent ที่ required ต้องเป็น true เท่านั้น
```

**ยิงจริงผ่าน HTTP กับ Atlas**
```
bootstrap ไม่มี cookie   → 401
session ไม่ส่ง idToken   → 400
session idToken ปลอม     → 401 INVALID   ← ยิงไปถึง LINE จริงและถูกปฏิเสธ
bootstrap cookie ปลอม    → 401
form schema บน Atlas     → customer_onboarding@v1 published, 4 section 12 field
```

---

## 16.5 ที่ยังทดสอบไม่ได้

**verify id_token ของจริง** — ต้องมี LIFF app และ LINE Login Channel ID ตัวจริงก่อน
ใน test ใช้ mock ของ LINE verify API ส่วนการยิงจริงพิสูจน์ได้แค่ว่า token ปลอมถูกปฏิเสธ

⚠️ ตอนนี้ `LINE_CHANNEL_ID` กับ `LINE_LOGIN_CHANNEL_ID` ใน `.env.local` เป็นค่าเดียวกัน (`2011262829`)
ซึ่งคือ Messaging API channel ทั้งคู่ — **ถ้า `aud` ไม่ตรงกับ channel ที่ LIFF app สังกัดจริง ทุก request จาก LIFF จะโดน 401**

---

## 16.6 S6 ต่อไป

หน้า LIFF จริง (React) ที่ `app/liff/page.tsx` — อ่าน `formSchema` จาก bootstrap แล้ว render ฟอร์มตาม schema
ต้องมี `NEXT_PUBLIC_LIFF_ID` และ deploy ขึ้น Vercel ก่อนถึงจะทดสอบใน LINE app ได้จริง
