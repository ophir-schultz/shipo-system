// The zone-matrix weight rule, for the read-only diagnostic scripts.
//
// AUTHORITY: `weightToLb` in src/lib/billing/zones.ts, as changed by commit
// 8ed5bf6 ("Stop an unweighed shipment being billed the cheapest row on the
// card"). If that function and this file ever disagree, that one is right and
// this one is a bug.
//
// WHY THIS FILE EXISTS AT ALL, rather than the scripts importing zones.ts.
//
// Node strips TypeScript natively here (see scripts/test-scan-parse.mjs, which
// imports src/lib/scan/parse.ts directly), so importing a .ts module from a
// .mjs script is normally the right answer and was tried first. It does not
// work for zones.ts, for a reason that is about resolution and not about types:
// zones.ts imports `@/lib/supabase`, `@/lib/billing/unpriced` and
// `@/lib/billing/shipment-rate`, and `@/*` is a tsconfig `paths` alias. Node's
// type stripping does not read tsconfig.json, so the import fails outright with
//
//   ERR_MODULE_NOT_FOUND: Cannot find package '@/lib' imported from
//   src/lib/billing/zones.ts
//
// Only the bundler (next) and the test runner (vitest, via vite-tsconfig-paths)
// resolve that alias. Teaching Node to resolve it would mean a custom loader,
// and would also pull `supabaseAdmin` into scripts that build their own client
// from the service-role key -- a module-load side effect no read-only
// diagnostic wants.
//
// SO WHAT IS AND IS NOT A COPY HERE.
//
// The part of the rule that commit 8ed5bf6 actually changed -- which weights
// may be priced from at all -- is IMPORTED, not restated. `billedWeightOf`
// lives in src/lib/billing/shipment-rate.ts, which is pure and imports nothing,
// so Node loads it with no alias to resolve. It is the same function zones.ts
// calls and the same one matchLegacyRate calls, which is the point: it is the
// shared authority for both rate cards a shipment can be priced off.
//
// What remains restated below is the arithmetic either side of it: `ceil(oz/16)`
// and the 20 LB cap. That is the drift risk in this file, and it is pinned by
// src/lib/billing/zone-weight-parity.test.ts, which imports the real
// `weightToLb` and this function and asserts they agree -- vitest can resolve
// the alias even though Node cannot.
import { billedWeightOf } from '../src/lib/billing/shipment-rate.ts'

/** The matrix tops out at 20 LB, as `MAX_WEIGHT_LB` in zones.ts does. */
export const MAX_WEIGHT_LB = 20

/**
 * The matrix row (whole pounds, rounded UP) a shipment may be billed from, or
 * null when no row can be named for its weight.
 *
 * null -- NOT row 1 -- for an absent, zero, negative, NaN or Infinite weight.
 * This used to be `Math.ceil((oz || 0) / 16)` with a floor of 1, which sent an
 * unweighed shipment to the CHEAPEST cell on the card: a real price, correct
 * for a real parcel, and impossible to tell from one afterwards. A diagnostic
 * that reports "1 LB, zone N, rate X" for a shipment the live biller refuses to
 * price is wrong about exactly the shipments it gets run to investigate.
 *
 * Callers must test `=== null` and branch, not pass the result into a
 * `weight_lb` equality filter.
 */
export function weightToLb(weightOz) {
  const oz = billedWeightOf(weightOz)
  if (oz === null) return null
  const lb = Math.ceil(oz / 16)
  return lb > MAX_WEIGHT_LB ? MAX_WEIGHT_LB : lb
}
