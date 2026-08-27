"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Field from "./Field";
import type { Bootstrap, FormField, LiffSdk } from "./types";

const SDK_URL = "https://static.line-scdn.net/liff/edge/2/sdk.js";

type Phase =
  | { s: "loading"; text: string }
  | { s: "outside" }
  | { s: "error"; text: string; retry?: boolean }
  | { s: "form" }
  | { s: "done"; merged: boolean };

declare global {
  interface Window { liff?: LiffSdk }
}

function loadSdk(): Promise<LiffSdk> {
  return new Promise((resolve, reject) => {
    if (window.liff) return resolve(window.liff);
    const el = document.createElement("script");
    el.src = SDK_URL;
    el.onload = () => (window.liff ? resolve(window.liff) : reject(new Error("โหลด LIFF SDK ไม่สำเร็จ")));
    el.onerror = () => reject(new Error("โหลด LIFF SDK ไม่สำเร็จ"));
    document.head.appendChild(el);
  });
}

function visible(f: FormField, values: Record<string, unknown>): boolean {
  const c = f.visibleIf;
  if (!c) return true;
  const v = values[c.field];
  if (c.op === "eq") return v === c.value;
  if (c.op === "ne") return v !== c.value;
  if (c.op === "in") return Array.isArray(c.value) && (c.value as unknown[]).includes(v);
  if (c.op === "truthy") return Boolean(v);
  return true;
}

export default function LiffApp({ liffId, allowPreview = false }: { liffId: string; allowPreview?: boolean }) {
  const [phase, setPhase] = useState<Phase>({ s: "loading", text: "กำลังเตรียมข้อมูล…" });
  const [data, setData] = useState<Bootstrap | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const liffRef = useRef<LiffSdk | null>(null);
  // key เดิมตลอดรอบการกรอก → กดส่งซ้ำหรือเน็ตหลุดแล้วกดใหม่ จะไม่เกิด revision ซ้ำ
  const idemKey = useRef<string>(`liff-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  const start = useCallback(async () => {
    setPhase({ s: "loading", text: "กำลังเตรียมข้อมูล…" });
    try {
      // โหมดดูหน้าตาระหว่างพัฒนา: ข้าม LIFF SDK แล้วใช้ session cookie ที่มีอยู่แล้ว
      // ปลอดภัยเพราะ API ยังตรวจ session เหมือนเดิมทุกจุด และเปิดได้เฉพาะตอนไม่ใช่ production
      if (allowPreview && new URLSearchParams(window.location.search).get("preview") === "1") {
        const bres = await fetch("/api/liff/bootstrap");
        if (!bres.ok) {
          setPhase({ s: "error", text: "preview: ไม่มี session — ตั้ง cookie liff_sess ก่อน", retry: true });
          return;
        }
        const boot = (await bres.json()) as Bootstrap;
        setData(boot);
        setValues({ ...boot.prefill });
        setPhase({ s: "form" });
        return;
      }

      if (!liffId) {
        setPhase({ s: "error", text: "ระบบยังไม่ได้ตั้งค่า LIFF ID" });
        return;
      }
      const liff = await loadSdk();
      liffRef.current = liff;
      await liff.init({ liffId });

      if (!liff.isLoggedIn()) {
        // นอกแอป LINE ให้บอกผู้ใช้แทนที่จะเด้งไป login เงียบ ๆ
        if (!liff.isInClient()) return setPhase({ s: "outside" });
        liff.login({ redirectUri: window.location.href });
        return;
      }

      const idToken = liff.getIDToken();
      if (!idToken) {
        setPhase({ s: "error", text: "ไม่ได้รับสิทธิ์จาก LINE กรุณาเปิดใหม่อีกครั้ง" });
        return;
      }

      setPhase({ s: "loading", text: "กำลังเข้าสู่ระบบ…" });
      const sres = await fetch("/api/liff/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      if (!sres.ok) {
        const j = await sres.json().catch(() => ({}));
        const reason = j?.error?.details?.reason;
        if (reason === "EXPIRED" && liff.isInClient()) {
          liff.login({ redirectUri: window.location.href });
          return;
        }
        const cause = j?.error?.details?.cause;
        setPhase({ s: "error", text: (j?.error?.message ?? "เข้าสู่ระบบไม่สำเร็จ") + (cause ? `\n(${cause})` : ""), retry: true });
        return;
      }
      const sjson = await sres.json();

      const bres = await fetch("/api/liff/bootstrap");
      if (!bres.ok) {
        setPhase({ s: "error", text: "โหลดแบบฟอร์มไม่สำเร็จ", retry: true });
        return;
      }
      const boot = (await bres.json()) as Bootstrap & { ok: boolean };
      setData(boot);
      setValues({ ...boot.prefill, ...(sjson.lineEmail && !boot.prefill.email ? { email: sjson.lineEmail } : {}) });
      setPhase({ s: "form" });
    } catch (e) {
      setPhase({ s: "error", text: (e as Error).message || "เกิดข้อผิดพลาด", retry: true });
    }
  }, [liffId, allowPreview]);

  useEffect(() => { void start(); }, [start]);

  const onChange = useCallback((id: string, v: unknown) => {
    setValues((prev) => ({ ...prev, [id]: v }));
    setErrors((prev) => (prev[id] ? { ...prev, [id]: "" } : prev));
  }, []);

  const submit = useCallback(async () => {
    if (!data || saving) return;
    setSaving(true);
    setFormError(null);
    setErrors({});
    try {
      const res = await fetch("/api/liff/customer/profile", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idemKey.current },
        body: JSON.stringify({
          formId: data.formSchema.formId,
          formVersion: data.formSchema.version,
          idempotencyKey: idemKey.current,
          answers: values,
          clientMeta: { ua: navigator.userAgent.slice(0, 120) },
        }),
      });
      const j = await res.json().catch(() => ({}));

      if (res.ok) return setPhase({ s: "done", merged: Boolean(j.merged) });

      if (res.status === 400 && Array.isArray(j?.error?.details)) {
        const map: Record<string, string> = {};
        for (const d of j.error.details as Array<{ field: string; message: string }>) if (d.field) map[d.field] = d.message;
        setErrors(map);
        setFormError("กรุณาตรวจสอบข้อมูลที่ทำเครื่องหมายไว้");
        const first = document.querySelector<HTMLElement>('[aria-invalid="true"]');
        first?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (res.status === 409) {
        setFormError("แบบฟอร์มมีเวอร์ชันใหม่แล้ว กำลังโหลดใหม่…");
        setTimeout(() => void start(), 1200);
        return;
      }
      if (res.status === 401) {
        setFormError("เซสชันหมดอายุ กำลังเข้าสู่ระบบใหม่…");
        setTimeout(() => void start(), 1200);
        return;
      }
      setFormError(j?.error?.message ?? "บันทึกไม่สำเร็จ กรุณาลองใหม่");
    } catch {
      setFormError("เชื่อมต่อไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
    } finally {
      setSaving(false);
    }
  }, [data, values, saving, start]);

  const close = useCallback(() => {
    if (liffRef.current?.isInClient()) liffRef.current.closeWindow();
  }, []);

  const greeting = useMemo(() => {
    if (!data) return "";
    return data.profile.hasSubmittedBefore ? "อัปเดตข้อมูลของคุณได้ที่นี่" : "กรอกข้อมูลเพื่อให้เราดูแลคุณได้ดียิ่งขึ้น";
  }, [data]);

  if (phase.s === "loading") {
    return (
      <div className="state">
        <div className="spinner" />
        <div className="state-text">{phase.text}</div>
      </div>
    );
  }

  if (phase.s === "outside") {
    return (
      <div className="state">
        <div className="state-icon">💬</div>
        <div className="state-title">กรุณาเปิดผ่านแอป LINE</div>
        <div className="state-text">หน้านี้ต้องเปิดจากแชทของเราในแอป LINE เพื่อยืนยันตัวตนของคุณ</div>
      </div>
    );
  }

  if (phase.s === "error") {
    return (
      <div className="state">
        <div className="state-icon">⚠️</div>
        <div className="state-title">เปิดหน้านี้ไม่สำเร็จ</div>
        <div className="state-text">{phase.text}</div>
        {phase.retry && <button className="submit" onClick={() => void start()}>ลองใหม่อีกครั้ง</button>}
      </div>
    );
  }

  if (phase.s === "done") {
    return (
      <div className="state">
        <div className="state-icon">✅</div>
        <div className="state-title">บันทึกข้อมูลเรียบร้อยแล้ว</div>
        <div className="state-text">
          ขอบคุณที่กรอกข้อมูลครับ ทีมงานจะติดต่อกลับผ่าน LINE นี้
          {phase.merged && <><br />เราได้รวมข้อมูลกับบัญชีเดิมของคุณให้แล้ว</>}
        </div>
        {liffRef.current?.isInClient() && <button className="submit" onClick={close}>ปิดหน้านี้</button>}
      </div>
    );
  }

  if (!data) return null;
  const { profile, formSchema } = data;

  return (
    <div className="wrap">
      <div className="head">
        {profile.pictureUrl && /* eslint-disable-next-line @next/next/no-img-element */ (
          <img className="avatar" src={profile.pictureUrl} alt="" />
        )}
        <div>
          <div className="head-name">{profile.displayName || profile.lineDisplayName || "ยินดีต้อนรับ"}</div>
          <div className="head-sub">{greeting}</div>
        </div>
      </div>

      <h1 className="title">{formSchema.title.th}</h1>
      <p className="subtitle">ช่องที่มี <span className="req">*</span> จำเป็นต้องกรอก</p>

      {formSchema.sections.map((sec) => {
        const fields = sec.fields.filter((f) => visible(f, values));
        if (fields.length === 0) return null;
        // header ด้านบนแสดงรูปกับชื่อ LINE อยู่แล้ว — section ที่มีแต่ field อ่านอย่างเดียวจึงซ้ำซ้อน
        if (fields.every((f) => f.type === "image" || f.type === "readonly")) return null;
        return (
          <div className="section" key={sec.id}>
            <h2 className="section-title">{sec.title.th}</h2>
            {sec.description && <div className="section-desc">{sec.description.th}</div>}
            <div className="card">
              {fields.map((f) => (
                <Field
                  key={f.id}
                  field={f}
                  value={values[f.id]}
                  error={errors[f.id]}
                  profileImage={profile.pictureUrl}
                  readonlyText={f.id === "lineDisplayName" ? profile.lineDisplayName : null}
                  onChange={onChange}
                />
              ))}
            </div>
          </div>
        );
      })}

      {formError && <div className="form-error">{formError}</div>}
      <button className="submit" onClick={() => void submit()} disabled={saving}>
        {saving ? "กำลังบันทึก…" : (formSchema.submitLabel?.th ?? "บันทึกข้อมูล")}
      </button>
    </div>
  );
}
