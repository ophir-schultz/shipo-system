// Strip taxpayer identification numbers out of a DocuSign Connect
// payload before we store it.
//
// The partner's W-9 rides in the same envelope as the agreement, which
// means the completed envelope contains their SSN or EIN. The webhook
// writes the whole payload into partner_agreement_events.payload for
// replay, and that is a table in our database, backed up with
// everything else and readable by anyone with the service role key.
//
// The reason this is a code problem and not a configuration note:
// WHAT Connect sends is chosen by checkboxes in DocuSign's admin UI,
// not by us. "Include Documents" attaches the signed PDF as base64 —
// the W-9 image, TIN and all. "Include Document Fields" attaches the
// typed field values. Either one, ticked once by anyone with DocuSign
// admin, silently turns our event log into a store of social security
// numbers, and nothing would look wrong. So the refusal lives here, at
// the write, where no checkbox can reach it.
//
// This is a redactor, not a validator: it assumes the payload is
// hostile-by-accident and keeps only what it recognises as safe to
// keep. Over-redacting costs us detail in a replay log. Under-
// redacting costs a partner their SSN.

/** Replacement for a value that matched a TIN shape. */
const REDACTED = '[redacted]'

/**
 * Keys whose values are dropped wholesale.
 *
 * `documents` / `documentBase64` / `pdfBytes` are the signed PDF
 * itself. `tabs` / `formData` / `documentFields` are the typed field
 * values — on a W-9 that is the name, the address and the TIN. None of
 * them is read by anything in this system; the webhook routes on
 * `event` and resolves the partner from `customFields`, the envelope id
 * and the signer email.
 */
const DROP_KEYS =
  /^(documents?|documentbase64|pdfbytes|documentfields|formdata|tabs|tabdata|signatureimage|initialsimage|attachments?)$/i

/**
 * TIN shapes, as they appear on a W-9: an SSN (123-45-6789), an EIN
 * (12-3456789), and a bare nine-digit run, which is how both arrive
 * when the signer types them without separators.
 *
 * Only the match is replaced, not the whole string, so a sentence that
 * happens to contain a number survives as a sentence. A declined
 * reason is the field that makes this matter — it is free text written
 * by the partner, and the one place in the payload where human
 * explanation and a stray number can share a string.
 */
const TIN_PATTERNS: RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\b\d{2}-\d{7}\b/g, // EIN
  /\b\d{9}\b/g, // either, typed without separators
]

/**
 * Length past which a string is assumed to be an encoded document
 * rather than a field.
 *
 * This is the catch-all, and it is the part that protects us from a
 * payload shape we have not seen: a base64 PDF under a key DROP_KEYS
 * does not name still gets thrown away on size alone. No legitimate
 * field in a Connect payload is anywhere near this long — the longest
 * are envelope ids and ISO timestamps.
 */
const MAX_STRING = 1024

/** Depth past which we stop descending and drop the subtree. */
const MAX_DEPTH = 16

function redactString(value: string): string {
  if (value.length > MAX_STRING) {
    // The length is kept because it is the only thing that makes the
    // omission visible in a replay. A silently absent field reads as
    // "DocuSign did not send it", which is a different fact.
    return `[omitted: ${value.length} chars]`
  }
  let out = value
  for (const pattern of TIN_PATTERNS) out = out.replace(pattern, REDACTED)
  return out
}

/**
 * A copy of `payload` safe to persist. Never mutates its argument —
 * the caller still needs the original to resolve the partner and to
 * verify the HMAC it already verified.
 */
export function redactForStorage(payload: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[omitted: too deeply nested]'
  if (typeof payload === 'string') return redactString(payload)
  if (payload === null || typeof payload !== 'object') return payload
  if (Array.isArray(payload)) return payload.map((item) => redactForStorage(item, depth + 1))

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (DROP_KEYS.test(key)) {
      // Named, not omitted. "Connect sent documents and we refused
      // them" and "Connect sent no documents" are different facts, and
      // only the first one means someone ticked a box they should not
      // have.
      out[key] = '[dropped: may contain tax identifiers]'
      continue
    }
    out[key] = redactForStorage(value, depth + 1)
  }
  return out
}
