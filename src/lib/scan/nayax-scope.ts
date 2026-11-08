// Serialization scan and pick are Nayax only. Import and the other
// clients are not this gate. A name that is not exactly Nayax fails closed.

export const NAYAX_SCAN_ONLY =
  'Serialization scan and pick are Nayax only. Nothing was read, recorded, queued, or sent.'

export function serializationClientAllowed(name: string | null | undefined): boolean {
  return (name ?? '').trim().toLowerCase() === 'nayax'
}

export function queuedOutsideNayax(
  jobs: readonly { id: string; clientId: string; status: string }[],
  names: ReadonlyMap<string, string | null>,
): string[] {
  return jobs
    .filter((job) => job.status !== 'done' && !serializationClientAllowed(names.get(job.clientId) ?? null))
    .map((job) => job.id)
}
