import { auth, signIn } from "@/auth";
import { isAllowedStaffEmail } from "@/lib/adminAuth";
import { LogIn, ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";

export default async function AdminLoginPage() {
  const session = await auth();
  if (isAllowedStaffEmail(session?.user?.email)) redirect("/admin/review");

  return (
    <main className="login-shell">
      <section className="login-panel">
        <ShieldCheck size={34} aria-hidden="true" />
        <h1>พื้นที่สำหรับพนักงาน</h1>
        <p>เข้าสู่ระบบด้วยบัญชี Google ที่ได้รับอนุญาต</p>
        <form action={async () => {
          "use server";
          await signIn("google", { redirectTo: "/admin/review" });
        }}>
          <button className="primary-button" type="submit"><LogIn size={18} /> เข้าสู่ระบบด้วย Google</button>
        </form>
      </section>
    </main>
  );
}
