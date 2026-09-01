# S11-M5 — หน้าแสดงประวัติซื้อรายบุคคล · ผลการทำงานจริง

วันที่: 2026-09-01

## สิ่งที่ทำ

| ส่วน | ไฟล์ |
|---|---|
| รวมโปรไฟล์และประวัติซื้อจาก partner/legacy | `packages/core/src/review/customerProfile.ts` |
| export API ของ core | `packages/core/src/index.ts` |
| integration tests สำหรับ D23/D44 และกรณีสำคัญ | `packages/core/tests/customerProfile.integration.test.ts` |
| หน้า admin แบบอ่านอย่างเดียว | `apps/web/app/admin/customer/[id]/page.tsx` |
| ลิงก์จากรายการ review ไปหน้าโปรไฟล์ | `apps/web/app/admin/review/page.tsx` |
| รูปแบบหน้าโปรไฟล์และ responsive layout | `apps/web/app/admin/admin.css` |
| tests สำหรับ auth guard ของหน้าใหม่ | `apps/web/tests/adminCustomerPage.test.ts` |

## กฎสำคัญที่ยืนยันแล้ว

### D23 — ไม่แสดงประวัติ legacy จนกว่าคนจะยืนยัน

- query ที่ใช้ดึง `legacyPersonId` รับเฉพาะ `customer_links.status: "confirmed"`
- link แบบ `auto` และ `needs_review` ใช้เพียงตั้ง `hasUnconfirmedLinks: true`
- หน้า admin แสดงคำเตือนและลิงก์กลับไปแท็บประวัติเก่า แต่ไม่แสดงประวัติที่ยังไม่ยืนยัน
- integration test ปลูกทั้ง link แบบ `auto` และ `needs_review` พร้อม payment จริง แล้วตรวจว่าประวัติ legacy และยอดเงินยังเป็นศูนย์

### D44 — ยอดชำระไม่เบิ้ลตามจำนวนคอร์ส

- `totalPaid` บวกจาก `purchases` และ `legacy_payments` ครั้งเดียวต่อ payment
- items/enrollments ใช้แสดงคอร์สและนับ `seatCount` เท่านั้น
- integration test ใช้ 1 partner payment ที่มี 3 คอร์ส และ 1 legacy payment ที่มี 2 คอร์ส ผลรวมถูกต้องที่ `53,900` บาท

## ผลรันจริง

```text
npm run db:test:up && RUN_MONGO_INTEGRATION=true npm test

@line-crm/core
Test Files  37 passed (37)
Tests       318 passed (318)

@line-crm/web
Test Files  10 passed (10)
Tests       77 passed (77)

รวม 395 tests passed · skipped 0
```

```text
npm run typecheck

@line-crm/core  tsc --noEmit      ผ่าน
@line-crm/web   tsc --noEmit      ผ่าน
scripts         tsconfig.scripts  ผ่าน
```

```text
npm run build --workspace @line-crm/web

Compiled successfully
Route /admin/customer/[id] ถูกสร้างเป็น Dynamic server-rendered route
exit code 0
```

## ขอบเขตและความเสี่ยง

- หน้าใหม่ไม่มีฟอร์มหรือคำสั่งเขียนข้อมูลลูกค้า เป็นหน้าอ่านอย่างเดียวตามสเปก
- ลูกค้าที่มีสถานะ `erased` จะไม่คืนหรือแสดงชื่อ เบอร์ อีเมล และช่องทางที่มา
- ไม่ได้แก้ intake, analytics, tagger, LLM หรือ workflow
- ไม่มี design deviation จาก `docs/32-s11-m5-spec.md`
