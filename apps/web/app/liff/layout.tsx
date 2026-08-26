import "./liff.css";

export const metadata = {
  title: "ข้อมูลลูกค้า",
  other: { viewport: "width=device-width, initial-scale=1, viewport-fit=cover" },
};

export default function LiffLayout({ children }: { children: React.ReactNode }) {
  return <div className="liff">{children}</div>;
}
