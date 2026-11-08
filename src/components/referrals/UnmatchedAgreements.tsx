export interface UnmatchedAgreementEvent {
  envelope_id: string
  event: string
  processed_at: string | null
}

/**
 * DocuSign events that did not attach to a partner.
 *
 * Envelope id, event name, and time only. The stored payload is not a
 * prop and must not be passed in: it can carry custom fields from the
 * envelope, and this list is a staff screen.
 */
export default function UnmatchedAgreements({
  events,
  readFailed,
}: {
  events: UnmatchedAgreementEvent[]
  readFailed: boolean
}) {
  if (readFailed) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">Unmatched DocuSign events could not be read</p>
        <p className="mt-1 text-xs">
          This does not change anyone&apos;s agreement status. The payout figures below are a separate read.
        </p>
      </div>
    )
  }

  if (events.length === 0) return null

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-semibold">DocuSign events that matched no partner</p>
      <p className="mt-1 text-xs">
        These were recorded and did not grant portal access. A voided event is not a signature.
        A completed event stays unmatched until a person names the partner. This screen does not
        write that match, and it does not mark an agreement signed or a W-9 received.
      </p>
      <ul className="mt-2 space-y-1 font-mono text-xs">
        {events.map((event) => (
          <li key={`${event.envelope_id}:${event.event}:${event.processed_at ?? ''}`}>
            {event.processed_at?.slice(0, 10) ?? 'undated'} · DocuSign {event.event} · match pending · not a W-9 · {event.envelope_id}
          </li>
        ))}
      </ul>
    </div>
  )
}
