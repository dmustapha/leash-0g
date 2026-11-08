// File: web/components/ui/AmountField.tsx
// A token-amount input that speaks the owner's language. When the token's decimals are known the owner
// types "5" (or "0.5") in the token's own unit and the parent receives exact base units; when they are
// NOT known it falls back to a base-units input that says so plainly (never a guessed scale).
'use client';

import { useEffect, useRef, useState } from 'react';
import { parseAssetAmount, type AssetUnit } from '@/lib/asset';

export function AmountField({
  id,
  testId,
  label,
  unit,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id: string;
  testId: string;
  label: string;
  /** decimals + symbol of the token this amount is in, or null/undefined when unknown. */
  unit?: AssetUnit | null | undefined;
  /** the amount in BASE UNITS ('' when empty/invalid). */
  value: string;
  onChange: (baseUnits: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  // What WE last told the parent. A value that differs from it was changed from outside (e.g. cleared
  // after a successful submit) and must clear what the owner sees; our own emissions must not
  // (typing "0." is momentarily unparseable and emits '' without wanting the text wiped).
  const emitted = useRef('');
  const emit = (v: string) => {
    emitted.current = v;
    onChange(v);
  };
  useEffect(() => {
    if (value !== emitted.current && value === '') setText('');
    emitted.current = value;
  }, [value]);
  const decimals = unit?.decimals ?? null;
  // The owner changed WHICH token this amount is in: re-read what they typed in the new unit, so the
  // parent never keeps base units computed for the previous token's decimals.
  useEffect(() => {
    if (decimals === null || text.trim() === '') return;
    const parsed = parseAssetAmount(text, decimals);
    emit(parsed === null ? '' : parsed.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a unit change re-reads the text
  }, [decimals]);
  const invalid = decimals !== null && text.trim() !== '' && parseAssetAmount(text, decimals) === null;

  if (decimals === null) {
    return (
      <>
        <label className="label" htmlFor={id}>{label} (smallest unit of the token)</label>
        <input
          id={id}
          className="field"
          data-testid={testId}
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? 'e.g. 1000000'}
          disabled={disabled}
        />
        <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--ink-dim)' }}>
          We could not read this token&apos;s decimals, so type the whole smallest-unit number (for a 6-decimal token, 1000000 = 1 token).
        </p>
      </>
    );
  }
  return (
    <>
      <label className="label" htmlFor={id}>{label} ({unit?.symbol ?? 'token'})</label>
      <input
        id={id}
        className="field"
        data-testid={testId}
        inputMode="decimal"
        value={text}
        aria-invalid={invalid ? true : undefined}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseAssetAmount(e.target.value, decimals);
          emit(parsed === null ? '' : parsed.toString());
        }}
        placeholder={placeholder ?? 'e.g. 5'}
        disabled={disabled}
      />
      {invalid ? (
        <p role="alert" style={{ margin: 0, fontSize: '0.78rem', color: 'var(--deny)' }}>
          Use a plain number{decimals > 0 ? ` with at most ${decimals} decimals` : ' with no decimals'}.
        </p>
      ) : null}
    </>
  );
}
