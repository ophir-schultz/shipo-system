// What a ShipStation label still tells you when its order number is blank.
//
// WHY THIS EXISTS. syncShipments counts labels that arrive with no orderNumber
// (shipstation.ts:341) and the monitor turns that count into an alert. The alert
// said the shipments "can never be assigned a client or billed -- this is
// unrecoverable revenue until someone identifies them by hand in ShipStation".
//
// Measured 2026-10-13, every blank-order-number row in the table -- 9 of them,
// all at store 202015, $117.27 of carrier cost -- carried a ShipStation orderId
// AND a shipTo.name, and seven of those names read "SHIPO LLC - SITNSTAND
// (RET-2026-118)" or "SHIPO LLC - SUTEKA (#S7143)". They were inbound return
// labels to Shipo's own warehouse with the client's name written on them. So
// both halves of the alert were wrong: the client was identifiable from the row,
// and the money was a return cost rather than uninvoiced outbound revenue.
//
// The count was never the problem. "2 shipments arrived with no order number"
// is unactionable in the same way "attribution problems: 47" was unactionable
// (shipstation.ts:66) -- it names a quantity of work rather than the work. This
// module exists so the alert can carry the two handles that survive a blank
// order number, which is the difference between an email that sends someone
// looking and an email they can act on.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not conclude anything about WHO the
// client is. The 2026-10-13 rows happened to name a client in shipTo.name; that
// is a fact about nine labels at one store, not a rule, and a function that
// parsed a client out of a recipient name would be inventing an attribution
// rule from a sample of nine. It reports what the field says and stops.

/**
 * A one-line account of a label that has no order number, for an operator.
 *
 * Always returns a non-empty string. `shipmentId` comes from a caller that has
 * already guarded it as a positive integer (shipstation.ts:320), so there is
 * always something addressable to name even when the payload is empty or
 * malformed.
 *
 * That totality is the point and not an accident: the caller collects these into
 * an array that sits next to a count in the same alert. A function that could
 * return null would let the array run shorter than the count beside it, and two
 * numbers disagreeing inside one alert get read as a bug in the alert -- which
 * costs exactly the attention the alert exists to buy.
 */
export function describeBlankLabel(payload: unknown, shipmentId: number): string {
  const p = payload !== null && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : {}

  const orderId = scalarText(p.orderId)

  // Name first, company second. On the measured rows `company` was 'SHIPO LLC'
  // on every single one -- the warehouse, which identifies nobody -- while the
  // client sat in `name`. Preferring company would have collapsed nine
  // distinguishable labels into nine identical lines.
  const shipTo = p.shipTo !== null && typeof p.shipTo === 'object'
    ? p.shipTo as Record<string, unknown>
    : {}
  const recipient = stringText(shipTo.name) ?? stringText(shipTo.company)

  // Both absences are STATED rather than left out. A line that simply omitted
  // the orderId would be indistinguishable from one that had it, and the
  // difference is whether the label can be looked up in ShipStation at all.
  return `shipment ${shipmentId} · `
    + (orderId ? `order ${orderId}` : 'no ShipStation orderId')
    + ' · '
    + (recipient ? `to "${recipient}"` : 'no recipient name')
}

/**
 * An identifier that is safe to print as one, or null.
 *
 * Numbers are admitted because ShipStation sends orderId as a JSON number
 * (measured: 561423093). A string-only guard would have reported "no orderId"
 * on every real row, and that failure would have looked like ShipStation
 * omitting the field rather than like this function refusing it.
 *
 * NaN and the infinities are refused for the reason the whole module exists:
 * `String(NaN)` is 'NaN', which reads as an identifier in an email, finds
 * nothing when pasted into ShipStation, and gets blamed on ShipStation.
 * Booleans, objects and arrays are refused on the same ground -- 'true' and
 * '[object Object]' are not obviously wrong, which is what makes them worse
 * than an honest "no orderId".
 */
function scalarText(raw: unknown): string | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null
  return stringText(raw)
}

/** A non-blank string, trimmed, or null. Whitespace is not a value. */
function stringText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  return text === '' ? null : text
}
