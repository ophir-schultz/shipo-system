// Which client does a ShipStation label belong to?
//
// WHY THIS EXISTS. syncShipments has never answered that question. Its
// `shipmentData` object carries no client_id key at all -- the comment in the
// sync said "for now match by order source" and nothing ever replaced it -- so
// every shipment it writes lands with client_id null and stays there unless
// zenventory.ts happens to match it by order_number. Measured 2026-10-05: 599
// of 890 shipments are unattributed, carrying $8,980.99 of carrier cost that
// was never billed to anyone, 94% of everything unbilled. The gap is not
// historical; it grows three times a day, because the sync that writes the cost
// still cannot name the payer.
//
// ShipStation does know. Every label carries advancedOptions.storeId, and
// client_store_ids (supabase/ledger_01_orders.sql:10) is the table that maps a
// store to a client -- unique on store_id ALONE, because "a store cannot map
// two ways" is the invariant the whole mapping rests on.
//
// WHY A SEPARATE MODULE rather than a dozen lines inside the sync loop. Two
// callers need the same rule: the live sync, and the backfill that has to
// attribute the 599 rows already in the table. A rule implemented twice is a
// rule that will disagree with itself, and the disagreement would be over which
// client gets invoiced. The decision is also the part worth testing in
// isolation -- it has a case that must never fire, and a pure function is the
// only shape where "never" can be asserted directly.

import { supabaseAdmin } from '@/lib/supabase'

/**
 * The store key on a ShipStation payload, or null if it has none.
 *
 * Both shapes are read because both appear in raw_data in this database: the
 * API nests it under advancedOptions, and some older rows carry it at the top
 * level. supabase/store_mapping_worklist_2026_10.sql coalesces the same two.
 *
 * Numbers are stringified because client_store_ids.store_id is `text`. A
 * numeric 12345 and the string '12345' are the same store, and matching them by
 * `===` would silently find nothing -- the failure would present as "no store
 * is mapped" rather than as a type mismatch, which is the kind of wrong answer
 * that gets believed.
 *
 * An empty or whitespace-only value returns null rather than ''. '' is a
 * perfectly valid Map key, so letting it through would collect every
 * store-less label under one key and, if anyone ever inserted a
 * client_store_ids row with a blank store_id, attribute all of them to that
 * client at once.
 */
export function storeIdOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const advanced = p.advancedOptions
  const nested = advanced !== null && typeof advanced === 'object'
    ? (advanced as Record<string, unknown>).storeId
    : undefined
  const raw = nested ?? p.storeId
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  if (typeof raw === 'number' && !Number.isFinite(raw)) return null
  const asText = String(raw).trim()
  return asText === '' ? null : asText
}

/**
 * store_id -> client_id, or an error.
 *
 * `map` is null when the read failed, and that is the whole point of the return
 * shape. An empty Map is a legitimate state -- nobody has mapped a store yet --
 * and a failed select is not, but the two are indistinguishable once the error
 * is dropped. A caller handed an empty map on failure would report every single
 * store as unmapped and ask a person to go and map stores that are already
 * mapped, while the real fault was one bad query. Same reason
 * billing/zones.ts:183 refuses to let one null mean both "no cell" and "the
 * read failed".
 */
export async function loadStoreMap(): Promise<
  { map: Map<string, string>; error: null } | { map: null; error: unknown }
> {
  const { data, error } = await supabaseAdmin
    .from('client_store_ids')
    .select('store_id, client_id')

  if (error) return { map: null, error }

  const map = new Map<string, string>()
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const storeId = row.store_id === null || row.store_id === undefined
      ? null
      : String(row.store_id).trim()
    const clientId = row.client_id === null || row.client_id === undefined
      ? null
      : String(row.client_id).trim()
    // A row with either half missing is not a mapping. It cannot be inserted
    // through the schema (both columns are NOT NULL) but the map is also built
    // from backfill output and hand edits, and a half-row here would attribute
    // a shipment to the client_id `null` -- which PostgREST would send as a
    // literal and the foreign key would reject, failing the whole shipment
    // update over a bad lookup row.
    if (storeId && clientId) map.set(storeId, clientId)
  }
  return { map, error: null }
}

/**
 * What to do about one shipment's attribution.
 *
 * `attribute` is the only action that writes. Every other action exists so the
 * caller can COUNT the case and say something about it, which is the difference
 * between a gap that gets closed and a gap nobody knows the size of.
 */
export type AttributionDecision =
  /** Write this client_id. The row had none, and the store map names one. */
  | { action: 'attribute'; clientId: string }
  /** The row is already attributed and the map agrees. Nothing to write. */
  | { action: 'keep' }
  /**
   * The row is already attributed and the map names a DIFFERENT client. Nothing
   * is written and the caller must announce it.
   */
  | { action: 'conflict'; existingClientId: string; mappedClientId: string }
  /** The payload carries no store key. No SQL can attribute this one. */
  | { action: 'no-store-id' }
  /** The store is real and nobody has mapped it. One row in client_store_ids fixes every shipment from it. */
  | { action: 'unmapped-store'; storeId: string }
  /** The store map could not be read, so attribution did not run at all. */
  | { action: 'map-unavailable' }

/**
 * Pure. Takes the store map (or null if it failed to load), the payload, and
 * whatever client_id the existing row already holds.
 *
 * THE CASE THAT MUST NEVER FIRE: this never returns an action that writes a
 * null, a blank, or a different client over a client_id that is already there.
 * 291 of the 890 shipments in this database were attributed by hand, and a sync
 * running three times a day that "corrected" them to null would erase that work
 * silently and un-bill the only shipments anyone can currently invoice. Hence
 * `keep` and `conflict` rather than an overwrite: where the map disagrees with
 * a stored attribution, the stored one stands and a person is told.
 *
 * It also means the live sync is safe to point at the table before the backfill
 * runs, and safe to leave pointed at it afterwards.
 */
export function decideAttribution(input: {
  storeMap: Map<string, string> | null
  payload: unknown
  existingClientId: string | null | undefined
}): AttributionDecision {
  const { storeMap, payload, existingClientId } = input

  if (storeMap === null) return { action: 'map-unavailable' }

  const storeId = storeIdOf(payload)
  if (storeId === null) return { action: 'no-store-id' }

  const mappedClientId = storeMap.get(storeId)
  if (mappedClientId === undefined) return { action: 'unmapped-store', storeId }

  // Trimmed and stringified on both sides before comparing. existingClientId
  // arrives from a uuid column via PostgREST, the map side from the same, and a
  // mismatch in representation would read as a conflict -- which would print an
  // alert about two clients that are in fact one.
  const existing = existingClientId === null || existingClientId === undefined
    ? ''
    : String(existingClientId).trim()

  if (existing === '') return { action: 'attribute', clientId: mappedClientId }
  if (existing === mappedClientId) return { action: 'keep' }
  return { action: 'conflict', existingClientId: existing, mappedClientId }
}
