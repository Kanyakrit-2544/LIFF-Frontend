export const metadata = {
  title: "นโยบายความเป็นส่วนตัว",
  description: "นโยบายการเก็บและใช้ข้อมูลส่วนบุคคล",
};

// placeholder ชั่วคราว (ไม่พังหน้า) — แทนที่ด้วยชื่อธุรกิจ + อีเมลจริงก่อน go-live (ดู docs/31)
const BUSINESS = "Inner Power";
const CONTACT_EMAIL = "privacy@example.com";
const CONTACT_LINE = "@543zipsl";
const RETENTION = "2 ปี นับจากการติดต่อครั้งล่าสุด";
const UPDATED = "27 สิงหาคม 2569";

export default function PrivacyPage() {
  return (
    <main className="pp">
      <style>{`
        .pp{--bg:#fff;--tx:#111827;--mut:#6b7280;--bd:#e5e7eb;--ac:#06c755;
          max-width:720px;margin:0 auto;padding:32px 20px 64px;background:var(--bg);color:var(--tx);
          font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai","Sarabun",sans-serif;
          line-height:1.75;-webkit-font-smoothing:antialiased}
        @media(prefers-color-scheme:dark){.pp{--bg:#111214;--tx:#f3f4f6;--mut:#9ca3af;--bd:#2f3236}}
        .pp h1{font-size:26px;font-weight:700;margin:0 0 6px;letter-spacing:-.01em}
        .pp .upd{color:var(--mut);font-size:13px;margin:0 0 28px}
        .pp h2{font-size:17px;font-weight:600;margin:32px 0 10px;padding-top:20px;border-top:1px solid var(--bd)}
        .pp h2:first-of-type{border-top:0;padding-top:0}
        .pp p,.pp li{font-size:15px}
        .pp ul{padding-left:20px;margin:8px 0}
        .pp li{margin:5px 0}
        .pp .note{background:rgba(6,199,85,.08);border-left:3px solid var(--ac);
          padding:12px 14px;border-radius:0 8px 8px 0;font-size:14.5px;margin:14px 0}
        .pp a{color:var(--ac)}
        .pp footer{margin-top:40px;padding-top:20px;border-top:1px solid var(--bd);color:var(--mut);font-size:13.5px}
      `}</style>

      <h1>นโยบายความเป็นส่วนตัว</h1>
      <p className="upd">ปรับปรุงล่าสุด {UPDATED}</p>

      <h2>1. ผู้เก็บข้อมูล</h2>
      <p>
        {BUSINESS} เป็นผู้ควบคุมข้อมูลส่วนบุคคลที่เก็บผ่าน LINE Official Account และแบบฟอร์มใน LINE (LIFF)
        ติดต่อเรื่องข้อมูลส่วนบุคคลได้ที่ {CONTACT_EMAIL} หรือทาง LINE {CONTACT_LINE}
      </p>

      <h2>2. ข้อมูลที่เก็บ</h2>
      <p><strong>ข้อมูลที่คุณกรอกเอง</strong></p>
      <ul>
        <li>ชื่อ-นามสกุล · ชื่อเล่น · ชื่อภาษาอังกฤษ</li>
        <li>ปีเกิด</li>
        <li>เบอร์โทรศัพท์ · อีเมล</li>
        <li>บัญชี Facebook · Instagram (ไม่บังคับ)</li>
      </ul>
      <p><strong>ข้อมูลจาก LINE</strong> — เมื่อคุณเปิดแบบฟอร์มและกดยินยอม</p>
      <ul>
        <li>รหัสผู้ใช้ LINE · ชื่อที่แสดงใน LINE · รูปโปรไฟล์</li>
        <li>อีเมลที่ผูกกับ LINE (เฉพาะเมื่อคุณอนุญาต)</li>
      </ul>
      <p><strong>ข้อมูลการใช้งาน</strong></p>
      <ul>
        <li>วันเวลาที่เพิ่มเราเป็นเพื่อน · ทักครั้งแรก · ส่งแบบฟอร์ม</li>
        <li>หลักฐานการให้ความยินยอม (วันเวลา หมายเลข IP อุปกรณ์ที่ใช้)</li>
      </ul>

      <div className="note">
        <strong>เราไม่เก็บข้อความที่คุณสนทนากับเรา</strong> ระบบบันทึกเพียงว่า “มีการทักครั้งแรกเมื่อใด”
        ส่วนเนื้อหาข้อความ รูป สติกเกอร์ และไฟล์ ถูกตัดทิ้งตั้งแต่ก่อนบันทึกลงฐานข้อมูล
      </div>

      <h2>3. ใช้ข้อมูลทำอะไร</h2>
      <ul>
        <li>ติดต่อกลับและให้บริการตามที่คุณสอบถาม</li>
        <li>ยืนยันตัวตนและป้องกันข้อมูลซ้ำซ้อน</li>
        <li>ออกเอกสารที่เกี่ยวข้อง เช่น ใบเสร็จ</li>
        <li>ส่งข่าวสารและโปรโมชัน — <strong>เฉพาะเมื่อคุณติ๊กยินยอมไว้</strong> ถอนได้ทุกเมื่อ</li>
      </ul>

      <h2>4. ใครเข้าถึงข้อมูลได้</h2>
      <ul>
        <li>พนักงานของเราที่ต้องใช้ข้อมูลในการดูแลคุณ</li>
        <li>ผู้ให้บริการระบบที่เราใช้: MongoDB Atlas (ฐานข้อมูล) · Vercel (เว็บ) · Google (ตารางข้อมูล) · LINE</li>
      </ul>
      <p>เราไม่ขายและไม่แลกเปลี่ยนข้อมูลของคุณกับบุคคลภายนอกเพื่อการตลาด</p>

      <h2>5. การวิเคราะห์ข้อมูล</h2>
      <p>
        เราจัดทำสำเนาข้อมูลสำหรับวิเคราะห์ภาพรวม โดย<strong>ปิดบังชื่อ เบอร์โทร และอีเมลก่อนเสมอ</strong>
        สำเนาชุดนี้เก็บแยกฐานข้อมูลและจำกัดสิทธิ์การเข้าถึงคนละชุดกับข้อมูลจริง
        ผู้ที่ใช้ข้อมูลชุดวิเคราะห์จะไม่สามารถระบุตัวคุณได้
      </p>

      <h2>6. เก็บไว้นานแค่ไหน</h2>
      <p>เก็บไว้ {RETENTION} หรือจนกว่าคุณจะขอให้ลบ เว้นแต่มีกฎหมายกำหนดให้เก็บนานกว่านั้น</p>

      <h2>7. สิทธิของคุณ</h2>
      <ul>
        <li>ขอดูข้อมูลที่เรามีเกี่ยวกับคุณ</li>
        <li>ขอแก้ไขให้ถูกต้อง</li>
        <li>ขอให้ลบหรือระงับการใช้</li>
        <li>ถอนความยินยอมรับข่าวสาร</li>
        <li>ขอให้ส่งข้อมูลของคุณในรูปแบบที่อ่านได้</li>
        <li>ร้องเรียนต่อสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคล</li>
      </ul>
      <p>ใช้สิทธิได้โดยติดต่อ {CONTACT_EMAIL} หรือทักมาทาง LINE {CONTACT_LINE} เราจะดำเนินการภายใน 30 วัน</p>

      <h2>8. ความปลอดภัย</h2>
      <p>
        ข้อมูลถูกส่งผ่านการเชื่อมต่อที่เข้ารหัส (HTTPS/TLS) จำกัดสิทธิ์การเข้าถึงตามหน้าที่
        และระบบบันทึกการทำงานไม่เก็บเบอร์โทรหรืออีเมลของคุณไว้
      </p>

      <h2>9. การเปลี่ยนแปลงนโยบาย</h2>
      <p>หากมีการแก้ไข เราจะปรับวันที่ด้านบนและแจ้งผ่าน LINE Official Account หากเป็นการเปลี่ยนแปลงสำคัญ</p>

      <footer>{BUSINESS} · ปรับปรุง {UPDATED}</footer>
    </main>
  );
}
