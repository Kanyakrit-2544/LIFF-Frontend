# S11-M5 — สเปกงาน: แสดงประวัติซื้อรายบุคคลในหน้า admin

> สเปกสำหรับ Codex · อ่านให้จบก่อนเขียนโค้ด
> อ้างอิง: [docs/24](24-s11-m3-spec.md) §2 (D23) · [docs/21](21-legacy-mock-and-ai-matching.md) · โครงหน้า admin ที่มีอยู่

---

## 1. เป้าหมาย

หน้า `/admin/review` มีแล้ว 3 แท็บ (ลูกค้าซ้ำ / ประวัติเก่า / partner) — พนักงานยืนยัน `customer_links` ได้แล้ว
M5 เพิ่ม **หน้าโปรไฟล์ลูกค้า 1 คน** ที่รวมประวัติซื้อทั้งหมดจากทุกแหล่งไว้ที่เดียว

ตอบคำถามหน้างาน: "ลูกค้าคนนี้เคยซื้ออะไรบ้าง จ่ายรวมเท่าไร ครั้งล่าสุดเมื่อไร"

### อยู่ในสโคป
1. `packages/core/src/review/customerProfile.ts` — รวมประวัติซื้อของลูกค้า 1 คน
2. หน้า `/admin/customer/[id]` — แสดงโปรไฟล์ + ประวัติ + timeline
3. ลิงก์จากแท็บ review ไปหน้าโปรไฟล์
4. tests

### ❌ ไม่อยู่ในสโคป
- ไม่ทำหน้าแก้ไขข้อมูลลูกค้า (อ่านอย่างเดียว)
- ไม่ทำ export / พิมพ์
- ไม่แตะ intake, tagger, LLM
- ไม่เพิ่ม analytics (นั่น M4)

---

## 2. Design Decision — กฎเหล็กของ M5

| # | ประเด็น | ตัดสิน |
|---|---|---|
| **D23** | โชว์ประวัติซื้อรายบุคคล | **เฉพาะ link ที่ `status: "confirmed"` เท่านั้น** · `auto` และ `needs_review` **ห้ามใช้ดึงประวัติ legacy มาโชว์** |
| **D43** | ทำไม auto ก็ไม่พอ | `auto` มาจาก hash เบอร์ที่ผู้ใช้พิมพ์เอง — ครอบครัวใช้เบอร์เดียวกันได้ · โชว์ประวัติผิดคน = ยึดข้อมูล · ต้องให้คนยืนยันก่อนเท่านั้น |
| **D44** | ยอดรวม | คิดจาก **payment เท่านั้น** (legacy_payments + purchases) ห้ามบวกจาก items/enrollments — เบิ้ล |

### ⭐ D23 คือหัวใจ — ถ้าพลาดข้อนี้คือช่องโหว่ยึดข้อมูล

หน้านี้เอาประวัติซื้อของ "legacy person" มาโชว์ใต้ชื่อลูกค้า LINE
ความเชื่อมโยงนั้นมาจาก `customer_links` **ถ้าใช้ link ที่ยังไม่ยืนยัน (auto/needs_review) จะโชว์ประวัติของคนอื่นที่บังเอิญเบอร์ตรงกัน**

กฎ: ประวัติจากฝั่ง legacy แสดงได้ก็ต่อเมื่อมี `customer_links` ที่ `status: "confirmed"` เชื่อมอยู่
ส่วนการซื้อจาก partner (`purchases` ที่มี `customerId` ตรงตัว) ไม่ต้องผ่าน link — เป็นของลูกค้าคนนั้นโดยตรงอยู่แล้ว

---

## 3. `getCustomerProfile()` — `packages/core/src/review/customerProfile.ts`

```ts
export interface CustomerPurchaseRow {
  source: "partner" | "legacy";
  /** legacy ต้องมาจาก confirmed link เท่านั้น */
  paidAt: string | null;
  amount: number | null;
  saleRep: string | null;
  courses: { courseCode: string; courseNameTh: string; kind: string; countsAsSeat: boolean; sessionLabel: string | null }[];
}

export interface CustomerProfile {
  customerId: string;
  displayName: string | null;
  phone: string | null;          // plaintext จาก line_crm_dev
  email: string | null;
  heardFrom: string | null;
  customerStatus: string;
  status: string;                // active / erased / ...
  /** สรุป */
  totalPaid: number;             // จาก payment ทั้งสองแหล่ง (D44)
  paymentCount: number;
  seatCount: number;             // นับเฉพาะ countsAsSeat
  firstPaidAt: string | null;
  lastPaidAt: string | null;
  courseCodes: string[];
  purchases: CustomerPurchaseRow[]; // เรียงใหม่→เก่า
  /** ความเชื่อมโยงกับ legacy */
  linkedLegacyPersonIds: string[];       // เฉพาะ confirmed
  hasUnconfirmedLinks: boolean;          // มี auto/needs_review ค้าง → ขึ้นป้ายเตือน
  /** true = ประวัติ legacy อาจไม่ครบเพราะยังไม่ยืนยัน link */
  legacyHidden: boolean;
}

export async function getCustomerProfile(
  mainDb: Db, aiDb: Db, legacyDb: Db, customerId: string
): Promise<CustomerProfile | null>;
```

**ตรรกะ**
1. อ่านลูกค้าจาก `line_crm_dev.customers` (plaintext — หน้า admin เห็นเต็มได้) · ไม่เจอ = null
2. **partner purchases**: `purchases` ที่ `customerId` ตรง (จาก `line_crm_dev` — ยังไม่ scrub) + `purchase_items` ผูก
3. **legacy purchases**: หา `customer_links` ที่ `customerId` ตรง **และ `status: "confirmed"`** → ได้ `legacyPersonId` → ดึง `legacy_payments` + `legacy_enrollments` ของคนนั้นจาก `line_crm_legacy`
   - ถ้ามี link ที่ `auto`/`needs_review` ค้าง → `hasUnconfirmedLinks: true` (ให้ UI เตือนว่า "มีประวัติที่รอยืนยัน")
4. รวมยอด: `totalPaid` = Σ amount ของ payment ทั้งสองแหล่ง · `seatCount` = Σ item/enrollment ที่ `countsAsSeat`
5. เรียง `purchases` ตาม `paidAt` ใหม่→เก่า

⚠️ อ่าน `line_crm_legacy` ต้องผ่าน `review_user` (สิทธิ์ read เฉพาะ legacy มีแล้ว) — ใช้ `getAdminReviewDbs()` / `getAdminAiDb()` ที่มีอยู่

---

## 4. หน้า `/admin/customer/[id]/page.tsx`

- ตรวจ auth เหมือนหน้า review (session + `isAllowedStaffEmail` + redirect) — **ทุกหน้า admin ตรวจเอง ไม่พึ่ง middleware**
- ส่วนหัว: ชื่อ · เบอร์ · อีเมล · สถานะ · เห็นเราจากช่องทางไหน
- การ์ดสรุป: ยอดรวม · จำนวนครั้ง · ที่นั่ง · ครั้งแรก/ล่าสุด · คอร์สที่เคยเรียน
- ตารางประวัติ: วันที่ · แหล่ง (partner/legacy) · คอร์ส · ยอด · เซล
- ถ้า `hasUnconfirmedLinks` → แถบเตือน "มีประวัติที่ระบบเดาว่าอาจเป็นคนนี้แต่ยังไม่ยืนยัน — ไปยืนยันที่แท็บประวัติเก่า"
- ถ้า `status === "erased"` → แสดงว่าลูกค้าขอลบข้อมูลแล้ว ไม่โชว์ PII

---

## 5. เชื่อมจากหน้า review

ในแท็บ review แต่ละรายการที่มี `customerId` → เพิ่มลิงก์ไป `/admin/customer/<id>`
(ให้พนักงานดูโปรไฟล์เต็มก่อนตัดสิน)

---

## 6. Tests

**Unit/Integration (`RUN_MONGO_INTEGRATION=true`)**
- ⭐ ลูกค้าที่มี **confirmed link** → เห็นประวัติ legacy
- ⭐ ลูกค้าที่มีแต่ **auto/needs_review link** → **ไม่เห็นประวัติ legacy** และ `hasUnconfirmedLinks: true` (D23 — ห้ามหลุด)
- ⭐ ยอดรวมจาก payment ไม่เบิ้ลเมื่อ 1 payment มีหลายคอร์ส (D44)
- partner purchases ที่ `customerId` ตรง → เห็นโดยไม่ต้องมี link
- `seatCount` ไม่นับ relearn/free/refund
- ลูกค้าไม่มีตัวตน → คืน null
- ลูกค้า `erased` → ไม่มี PII ในผล
- ลูกค้าที่ confirmed link ชี้ legacy person 2 คน (เคยกรอกหลายเบอร์) → รวมประวัติทั้งสอง

**หน้า (web integration)**
- ไม่ล็อกอิน → redirect `/admin/login`
- อีเมลนอก allowlist → เข้าไม่ได้

---

## 7. เกณฑ์ผ่านงาน
- [ ] `RUN_MONGO_INTEGRATION=true npm test` ผ่าน skipped 0 (ฐาน core 310 · web 74)
- [ ] `npm run typecheck` ผ่าน 3 ชุด
- [ ] มีเทสพิสูจน์ว่า link ที่ยังไม่ confirmed **ไม่ทำให้ประวัติ legacy โผล่**
- [ ] ยอดรวมไม่เบิ้ล
- [ ] เขียน `docs/33-s11-m5-report.md` พร้อมผลรันจริง

## 8. กฎห้ามละเมิด
1. **ประวัติ legacy โชว์ได้เฉพาะผ่าน confirmed link** (D23) — ข้อนี้พลาดคือช่องโหว่
2. ยอดเงินจาก payment เท่านั้น (D44)
3. หน้า admin ทุกหน้าตรวจ auth เอง
4. อ่านอย่างเดียว ห้ามเขียนอะไรลงฐานจากหน้านี้
5. ห้าม log PII · ห้ามลด/ปิด test เดิม

## 9. ใช้ซ้ำได้เลย
| ของ | ที่อยู่ |
|---|---|
| auth guard | `apps/web/lib/adminAuth.ts` · แบบใน `app/admin/review/page.tsx` |
| ต่อ 3 ฐานด้วย review_user | `apps/web/lib/adminDb.ts` (`getAdminReviewDbs`, `getAdminAiDb`) |
| ชื่อคอร์ส | `courseByCode` ใน `packages/core/src/legacy/courses.ts` |
| โครง link | `CustomerLinkDoc` · `AI_COLLECTIONS` |
| แบบ list review | `packages/core/src/review/service.ts` |
