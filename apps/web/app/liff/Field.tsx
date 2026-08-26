"use client";

import type { FormField } from "./types";

interface Props {
  field: FormField;
  value: unknown;
  error?: string;
  profileImage?: string | null;
  readonlyText?: string | null;
  onChange: (id: string, value: unknown) => void;
}

export default function Field({ field: f, value, error, profileImage, readonlyText, onChange }: Props) {
  const id = `f-${f.id}`;
  const invalid = Boolean(error);

  if (f.type === "image") {
    if (!profileImage) return null;
    return (
      <div className="field">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="avatar" src={profileImage} alt={f.label.th} />
      </div>
    );
  }

  if (f.type === "readonly") {
    return (
      <div className="field">
        <span className="label">{f.label.th}</span>
        <div className="readonly">{readonlyText || "—"}</div>
      </div>
    );
  }

  if (f.type === "consent") {
    return (
      <div className="field">
        <label className="check" htmlFor={id}>
          <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(f.id, e.target.checked)} />
          <span>
            {f.label.th}
            {f.validate?.required && <span className="req">*</span>}
          </span>
        </label>
        {error && <div className="err">{error}</div>}
      </div>
    );
  }

  const label = (
    <label className="label" htmlFor={id}>
      {f.label.th}
      {f.validate?.required && <span className="req">*</span>}
    </label>
  );

  if (f.type === "select") {
    return (
      <div className="field">
        {label}
        <select
          id={id}
          className="select"
          aria-invalid={invalid}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(f.id, e.target.value)}
        >
          <option value="">— เลือก —</option>
          {(f.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label.th}
            </option>
          ))}
        </select>
        {f.help && <div className="help">{f.help.th}</div>}
        {error && <div className="err">{error}</div>}
      </div>
    );
  }

  const inputType = f.type === "tel" ? "tel" : f.type === "email" ? "email" : "text";
  return (
    <div className="field">
      {label}
      <input
        id={id}
        className="input"
        type={inputType}
        // ให้แป้นพิมพ์บนมือถือขึ้นตรงชนิดข้อมูล ลดการพิมพ์ผิด
        inputMode={f.type === "tel" ? "tel" : f.type === "email" ? "email" : undefined}
        autoComplete={f.id === "phone" ? "tel" : f.id === "email" ? "email" : f.id === "fullNameTh" ? "name" : "off"}
        aria-invalid={invalid}
        maxLength={f.validate?.maxLength}
        placeholder={f.placeholder?.th ?? ""}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(f.id, e.target.value)}
      />
      {f.help && <div className="help">{f.help.th}</div>}
      {error && <div className="err">{error}</div>}
    </div>
  );
}
