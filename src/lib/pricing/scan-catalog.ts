// Scan requirement for the current-derived Nayax preview.
//
// Stored orders and order lines have no raw payload and no scan column.
// A customer-order line does not carry serialized. The item list does:
// GET /items returns Item.serialized, "tracked by serial numbers".
// That boolean is the only flag applied here.
//
// A SKU prefix, a kit flag, and a count of scanned serials are not this flag.
// An incomplete page set is not applied at all.

export const SCAN_CATALOG_MAX_PAGES = 6
export const SCAN_CATALOG_PER_PAGE = 100

export interface CatalogPage {
  page: number
  totalPages: number
  count: number
  items: { sku: string; serialized: boolean | null }[]
}

export interface ScanCatalog {
  bySku: Map<string, boolean>
  conflicts: number
  missingFlag: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function whole(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value
}

/** One page of GET /items. A missing meta count or totalPages is incomplete. */
export function readCatalogPage(body: unknown): { ok: true; page: CatalogPage } | { ok: false; reason: string } {
  const record = asRecord(body)
  if (!record || !Array.isArray(record.items)) {
    return { ok: false, reason: 'The item list did not return an items array.' }
  }
  const meta = asRecord(record.meta)
  if (!meta) return { ok: false, reason: 'The item list did not return page metadata.' }
  const page = whole(meta.page)
  const totalPages = whole(meta.totalPages)
  const count = whole(meta.count)
  if (page == null || page < 1 || totalPages == null || totalPages < 1 || count == null || count < 0) {
    return { ok: false, reason: 'The item list page metadata is not a complete count.' }
  }
  const items: CatalogPage['items'] = []
  for (const row of record.items) {
    const item = asRecord(row)
    if (!item) return { ok: false, reason: 'An item list row is not an object.' }
    const sku = typeof item.sku === 'string' ? item.sku.trim() : ''
    if (!sku) return { ok: false, reason: 'An item list row has no SKU.' }
    const serialized = typeof item.serialized === 'boolean' ? item.serialized : null
    items.push({ sku, serialized })
  }
  return { ok: true, page: { page, totalPages, count, items } }
}

/**
 * Every page of one list, or nothing.
 * Pages must be 1..totalPages with one shared count. A gap, a repeat,
 * or a count that does not match the rows is refused.
 */
export function catalogFromPages(pages: readonly CatalogPage[]): { ok: true; catalog: ScanCatalog } | { ok: false; reason: string } {
  if (pages.length === 0) return { ok: false, reason: 'The item list returned no pages.' }
  const totalPages = pages[0].totalPages
  const count = pages[0].count
  if (totalPages > SCAN_CATALOG_MAX_PAGES) {
    return {
      ok: false,
      reason: `The item list has ${totalPages} pages, above the ${SCAN_CATALOG_MAX_PAGES}-page bound.`,
    }
  }
  if (pages.length !== totalPages) {
    return { ok: false, reason: `The item list needs ${totalPages} pages and ${pages.length} were read.` }
  }
  const seen = new Set<number>()
  let rows = 0
  for (const page of pages) {
    if (page.totalPages !== totalPages || page.count !== count) {
      return { ok: false, reason: 'The item list pages disagree about the total.' }
    }
    if (seen.has(page.page)) return { ok: false, reason: 'The item list repeated a page.' }
    seen.add(page.page)
    rows += page.items.length
  }
  for (let n = 1; n <= totalPages; n++) {
    if (!seen.has(n)) return { ok: false, reason: `The item list is missing page ${n}.` }
  }
  if (rows !== count) {
    return { ok: false, reason: `The item list count is ${count} and the pages contain ${rows} rows.` }
  }
  const bySku = new Map<string, boolean>()
  const conflicted = new Set<string>()
  let missingFlag = 0
  for (const page of pages) {
    for (const item of page.items) {
      if (item.serialized == null) {
        missingFlag += 1
        conflicted.add(item.sku)
        bySku.delete(item.sku)
        continue
      }
      if (conflicted.has(item.sku)) continue
      const previous = bySku.get(item.sku)
      if (previous === undefined) bySku.set(item.sku, item.serialized)
      else if (previous !== item.serialized) {
        conflicted.add(item.sku)
        bySku.delete(item.sku)
      }
    }
  }
  return { ok: true, catalog: { bySku, conflicts: conflicted.size, missingFlag } }
}

export function assignScanFlags<T extends { sku: string; scannable?: boolean | null }>(
  lines: T[],
  bySku: ReadonlyMap<string, boolean>,
): void {
  for (const line of lines) {
    const flag = bySku.get(line.sku.trim())
    line.scannable = flag === undefined ? null : flag
  }
}
