// A voided label was bought and then cancelled. It is not revenue and it is
// not a cost. ShipStation leaves that on the payload, and there is no column
// for it, so the ledger reads the same three fields (load-charge-inputs.ts).

export function isVoidedShipment(raw: unknown): boolean {
  if (raw == null || typeof raw !== 'object') return false
  const data = raw as Record<string, unknown>
  return data.voided === true || data.voidDate != null || data.voideDate != null
}

export function withoutVoided<T>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).filter((row) => !isVoidedShipment((row as { raw_data?: unknown }).raw_data))
}
