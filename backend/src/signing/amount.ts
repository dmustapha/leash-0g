/**
 * Shared base-units amount parse for the signing engine — the SINGLE source of the
 * amount grammar read by both `intent-classify` (cap check) and `intent-builder`
 * (the chargeable word). Keeping one definition means the classifier and the builder
 * can never drift on what counts as a valid amount (they MUST agree — classify gates
 * exactly the value the builder will encode).
 *
 * Valid = a 1–40 digit non-negative base-units decimal string (no sign, no decimal
 * point, no `0x`). Returns the bigint, or null (fail-closed) for anything else.
 */
export function parseSigningAmount(s: string): bigint | null {
  if (typeof s !== 'string' || !/^\d{1,40}$/.test(s)) return null;
  try {
    const v = BigInt(s);
    return v >= 0n ? v : null;
  } catch {
    return null;
  }
}
