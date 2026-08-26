import LiffApp from "./LiffApp";

export const dynamic = "force-dynamic";

export default function LiffPage() {
  // LIFF ID ต้องอยู่ฝั่ง client — เป็นค่าสาธารณะ ไม่ใช่ความลับ
  return <LiffApp liffId={process.env.NEXT_PUBLIC_LIFF_ID ?? ""} allowPreview={process.env.NODE_ENV !== "production"} />;
}
