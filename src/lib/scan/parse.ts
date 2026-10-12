// ============================================================
// BOX LABEL -> SERIAL LIST
//
// One scan of a carton label produces one long string that holds
// every device serial inside the box. The encoding is the vendor's
// choice, not ours, so this tries the plausible formats in order
// and reports WHICH one matched.
//
// The method label is not decoration. A label that produced one
// value because it genuinely holds one serial, and a label that
// produced one value because its separator is not handled here,
// look identical on screen and need completely different fixes.
// Returning `method` is what tells them apart.
//
// `guess: true` means no separator was found at all and the string
// was cut into equal pieces on the strength of the expected count.
// That can produce plausible-looking nonsense, so a caller must
// treat a guess as unconfirmed and make a human look.
//
// This module is imported by the browser page. It must stay pure:
// no DOM, no network, no Node APIs.
// ============================================================

export type ParseResult = {
  serials: string[]
  /** Which rule matched: 'json', 'newline', 'group-separator', 'fixed-width(N)', 'single', 'empty'. */
  method: string
  /** Set only when the split was inferred from the expected count rather than a separator. */
  guess?: boolean
}

/** Candidate separators, most trustworthy first. */
const CANDIDATES: [string, RegExp][] = [
  // The three that are invisible in a text field. GS is what most
  // GS1-compliant scanners actually emit.
  ['group-separator', /\x1d/],
  ['newline', /\n/],
  ['record-separator', /\x1e/],
  ['tab', /\t/],
  ['pipe', /\|/],
  ['semicolon', /;/],
  ['comma', /,/],
  // Last, because a single space inside a serial is common and would
  // shred it; two or more is a deliberate gap.
  ['spaces', /\s\s+/],
]

export function parseScan(raw: unknown, perBox?: number | string): ParseResult {
  const text = String(raw).replace(/\r\n/g, '\n').trim()
  if (!text) return { serials: [], method: 'empty' }

  // Some vendors encode JSON straight into the barcode.
  if (text[0] === '[' || text[0] === '{') {
    try {
      const parsed = JSON.parse(text)
      const list = Array.isArray(parsed)
        ? parsed
        : (parsed.serials || parsed.devices || parsed.items || null)
      if (Array.isArray(list)) {
        const serials = list
          .map((v) => (typeof v === 'string' ? v : v && (v.serial || v.sn || v.id)))
          .filter(Boolean)
          .map((s) => String(s).trim())
          .filter(Boolean)
        if (serials.length) return { serials, method: 'json' }
      }
    } catch {
      // Not JSON after all — fall through to the separator rules.
    }
  }

  for (const [method, pattern] of CANDIDATES) {
    if (pattern.test(text)) {
      const parts = text.split(pattern).map((s) => s.trim()).filter(Boolean)
      // A separator that yields one part did not really separate anything.
      if (parts.length > 1) return { serials: parts, method }
    }
  }

  // No separator anywhere. If the caller told us how many serials to
  // expect and the string divides evenly into pieces long enough to be
  // serials, cut it — but flag it, because this is inference.
  const n = Number(perBox)
  if (n > 1 && text.length % n === 0 && text.length / n >= 3) {
    const width = text.length / n
    const serials: string[] = []
    for (let i = 0; i < text.length; i += width) serials.push(text.slice(i, i + width))
    return { serials, method: `fixed-width(${width})`, guess: true }
  }

  return { serials: [text], method: 'single' }
}

/**
 * Serials that appear more than once in a single scan. Always an error:
 * either the scanner double-read, or the delimiter split badly. Returned
 * rather than thrown so the caller can show the operator which ones.
 */
export function duplicatesWithin(serials: string[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const s of serials) {
    if (seen.has(s)) dupes.add(s)
    seen.add(s)
  }
  return [...dupes]
}
