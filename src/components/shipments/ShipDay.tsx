import { presentShipDay } from '@/lib/billing/ship-day-label'

export function ShipDay({
  stored,
  raw,
}: {
  stored: string | null | undefined
  raw?: unknown
}) {
  const day = presentShipDay(stored, raw)
  return (
    <>
      <span>{day.shipDate || '—'}</span>
      {day.differs ? (
        <span className="block text-[10px] text-amber-700">Stored ship day {day.storedShipDay}</span>
      ) : null}
    </>
  )
}
