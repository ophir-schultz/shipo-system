import { shipDateWithStored } from '@/lib/billing/ship-day-label'

export function ShipDay({
  stored,
  raw,
}: {
  stored: string | null | undefined
  raw?: unknown
}) {
  const text = shipDateWithStored(stored, raw)
  return <span>{text || '—'}</span>
}
