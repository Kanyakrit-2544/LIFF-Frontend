# S13 — หน้า Analytics UI · ผลการทำงานจริง

วันที่: 2026-09-01

## สิ่งที่ทำ

| ส่วน | ไฟล์ |
|---|---|
| Endpoint พร้อม auth, query mode, question mode และ insight audit | `apps/web/app/api/admin/analytics/route.ts` |
| หน้า `/admin/analytics` และค่าเริ่มต้นเดือนปัจจุบันตามเวลาไทย | `apps/web/app/admin/analytics/page.tsx` |
| ตัวกรอง, Hermes question, ผลสรุป, SVG bar chart และตาราง | `apps/web/app/admin/analytics/AnalyticsDashboard.tsx` |
| เมนูร่วมของหน้า admin | `apps/web/app/admin/AdminNav.tsx` |
| เชื่อมเมนูจากหน้าเดิม | `apps/web/app/admin/review/page.tsx` · `apps/web/app/admin/customer/[id]/page.tsx` |
| รูปแบบ desktop/mobile | `apps/web/app/admin/admin.css` |
| Endpoint tests | `apps/web/tests/adminAnalyticsRoute.test.ts` |
| Page/HTML tests | `apps/web/tests/adminAnalyticsPage.test.ts` |

## ยืนยัน D45 — UI ไม่คำนวณตัวเลขธุรกิจเอง

- หน้าและ endpoint เรียก `runAnalytics` ที่มีอยู่แล้ว โดยไม่ได้แก้ไฟล์ใดใน `packages/core/src/analytics/`
- ผลรวมแสดงจาก `result.total` ตรง ๆ
- ค่าแต่ละแถวแสดงจาก `row.value` ตรง ๆ
- สัดส่วนใช้ `Intl.NumberFormat` แสดง `row.share` เป็นรูปแบบเปอร์เซ็นต์ โดยไม่มีการหารหรือคูณใน UI
- กราฟ SVG ใช้ `result.total` เป็น `viewBox` และ `row.value` เป็นความกว้างของแท่งตรง ๆ ไม่มีการหา max หรือคำนวณสัดส่วนซ้ำ
- เทสตั้งใจ mock ค่า `total = 999`, `row.value = 7`, `row.share = 0.375` ซึ่งไม่สัมพันธ์กัน แล้วพิสูจน์ว่า HTML แสดงค่าทั้งสามจาก core ตามเดิม
- ไม่มี chart library หรือ dependency ใหม่

## Auth, synthetic และ Hermes

- หน้า server component ตรวจ session + staff allowlist เองก่อนต่อฐาน และ redirect `/admin/login` เมื่อไม่ผ่าน
- endpoint ตรวจแบบเดียวกันและคืน 401 เมื่อไม่ผ่าน
- `meta.containsSynthetic` แสดงแถบแดงข้อความ "ตัวเลขนี้มีข้อมูลจำลอง ห้ามใช้ตัดสินใจ"
- `meta.isEstimate` แสดงป้ายเหลืองและ warnings จาก core
- ถ้าไม่มี Hermes ช่องถามถูก disable แต่ dropdown ใช้งานได้ตามปกติ
- คำตอบ Hermes แสดงเฉพาะเมื่อ `renderAnswer` ผ่านตัวกันโกหก หากพบเลขแต่ง endpoint คืน `answer: null` และหน้าแสดงตารางแทน

## การบันทึก insights

เลือกใช้ทางเลือกในสเปกดังนี้:

- อ่าน analytics ผ่าน `getAdminAiDb()` ด้วย `review_user`
- ถ้ามี `MONGODB_MIRROR_URI` ให้เขียน `insights` ผ่าน `getMirrorAiDb()` ด้วย `mirror_user`
- ถ้ายังไม่ตั้ง mirror writer หรือเขียนไม่ได้ ให้คืนผล analytics ตามปกติ ไม่ทำให้หน้าล่ม

เหตุผล: `review_user` มีสิทธิ์อ่านและห้ามยกระดับสิทธิ์เพื่อเขียน `insights`

## ผลรันจริง

```text
npm run db:test:up && RUN_MONGO_INTEGRATION=true npm test

@line-crm/core
Test Files  37 passed (37)
Tests       318 passed (318)

@line-crm/web
Test Files  13 passed (13)
Tests       96 passed (96)

รวม 414 tests passed · skipped 0
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
/admin/analytics      Dynamic server-rendered route · 4.6 kB
/api/admin/analytics  Dynamic server-rendered route
exit code 0
```

## การตรวจหน้าจอและข้อจำกัด

- เปิด local server แล้วเรียก `/admin/analytics` จริง ได้ 307 ไป `/admin/login` ก่อน และหน้า login ตอบ 200 ตรงตาม auth guard
- ไม่ข้าม Google login เพื่อถ่าย screenshot จึงไม่มี screenshot ในรายงานรอบนี้
- ยังไม่ได้ทดสอบถาม Hermes ตัวจริง เพราะ local env ยังไม่มี provider ที่พร้อมตอบ; ครอบคลุมด้วย mock ทั้งกรณีไม่มี Hermes, ถามกลับ และแต่งตัวเลข
- ไม่ได้แก้ analytics core, intake, tagger หรือ workflow และไม่มี design deviation อื่นจาก `docs/34-s13-analytics-ui-spec.md`
