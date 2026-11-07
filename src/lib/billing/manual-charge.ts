// A manual charge the staff form is allowed to store.
//
// The table is manual_charges (schema.sql). amount and description and
// charge_date are required. approved is left unset so the database default
// stays false: weekly bills only sum rows with approved = true.
//
// Nothing here writes. The route verifies the client again before insert.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const MONEY = /^\d+(\.\d{1,2})?$/
const MAX_CENTS = 9999999999

export interface ManualChargeInput {
  clientId: string
  chargeDate: string
  description: string
  amount: number
}

export function calendarDay(value: string): boolean {
  const match = DAY.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

export function moneyAmount(value: unknown): number | null {
  const text = typeof value === 'number'
    ? (Number.isFinite(value) ? String(value) : '')
    : typeof value === 'string' ? value.trim() : ''
  if (!MONEY.test(text)) return null
  const amount = Number(text)
  if (!Number.isFinite(amount) || amount < 0) return null
  const cents = Math.round(amount * 100)
  if (Math.abs(amount * 100 - cents) > 1e-6) return null
  if (cents > MAX_CENTS) return null
  return cents / 100
}

export function parseManualCharge(body: unknown): { ok: true; value: ManualChargeInput } | { ok: false; error: string } {
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: 'Body must be an object.' }
  }
  const raw = body as Record<string, unknown>
  const clientId = typeof raw.clientId === 'string' ? raw.clientId.trim() : ''
  if (!UUID.test(clientId)) {
    return { ok: false, error: 'clientId must be a client id.' }
  }
  const chargeDate = typeof raw.chargeDate === 'string' ? raw.chargeDate.trim() : ''
  if (!calendarDay(chargeDate)) {
    return { ok: false, error: 'chargeDate must be a real YYYY-MM-DD day. It is stored as that day, with no timezone shift.' }
  }
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  if (description.length === 0) {
    return { ok: false, error: 'description is required.' }
  }
  if (description.length > 240) {
    return { ok: false, error: 'description is longer than 240 characters.' }
  }
  if (raw.amount === undefined || raw.amount === null || raw.amount === '') {
    return { ok: false, error: 'amount is required.' }
  }
  const amount = moneyAmount(raw.amount)
  if (amount === null) {
    return { ok: false, error: 'amount must be a nonnegative number with at most two decimal places, up to 99999999.99.' }
  }
  return { ok: true, value: { clientId, chargeDate, description, amount } }
}

export const RECENT_MANUAL_CHARGES = 30

export function manualChargeRow(input: ManualChargeInput, addedBy: string, clientId: string) {
  return {
    client_id: clientId,
    charge_date: input.chargeDate,
    description: input.description,
    amount: input.amount,
    added_by: addedBy,
  }
}
