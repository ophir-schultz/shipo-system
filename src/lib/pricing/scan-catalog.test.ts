import { describe, expect, it } from 'vitest'
import { loadScanCatalog } from './load-scan-catalog'
import { priceClassifiedPick } from './engine'
import { loadRepoPriceList } from './repo-price-lists'
import { assignScanFlags, catalogFromPages, readCatalogPage, type CatalogPage } from './scan-catalog'

function page(n: number, total: number, count: number, items: CatalogPage['items']): CatalogPage {
  return { page: n, totalPages: total, count, items }
}

describe('item list scan flags', () => {
  it('does not request the item list when no API pair is configured', async () => {
    let called = 0
    const loaded = await loadScanCatalog('Nayax', {
      env: {},
      stored: null,
      readPage: async () => {
        called += 1
        return {}
      },
    })
    expect(called).toBe(0)
    expect(loaded.ok).toBe(false)
    expect(loaded.bySku.size).toBe(0)
    expect(loaded.note).toContain('ZEN_NAYAX_KEY')
    expect(loaded.note).toContain('prefix was not used')
  })

  it('uses the stored client pair when the env pair is absent and does not print it', async () => {
    let called = 0
    const loaded = await loadScanCatalog('Nayax', {
      env: {},
      stored: { apiKey: 'stored-key', apiSecret: 'stored-secret' },
      readPage: async () => {
        called += 1
        return {
          items: [{ sku: 'C-9', serialized: true }],
          meta: { page: 1, totalPages: 1, count: 1 },
        }
      },
    })
    expect(called).toBe(1)
    expect(loaded.ok).toBe(true)
    expect(loaded.bySku.get('C-9')).toBe(true)
    expect(loaded.note).toContain('clients.zenventory_api_key')
    expect(loaded.note).toContain('not the flag on the ship day')
    expect(loaded.note).not.toContain('stored-secret')
    expect(loaded.note).not.toContain('stored-key')
  })

  it('reads a boolean serialized flag and refuses a page without a count', () => {
    const ok = readCatalogPage({
      items: [
        { sku: 'C-9', serialized: true },
        { sku: 'R-9', serialized: false },
        { sku: 'PLAIN' },
      ],
      meta: { page: 1, totalPages: 1, count: 3 },
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.page.items.map((item) => item.serialized)).toEqual([true, false, null])
    expect(readCatalogPage({ items: [], meta: { page: 1, totalPages: 1 } }).ok).toBe(false)
  })

  it('refuses a partial page set and a count that does not match', () => {
    const only = catalogFromPages([page(1, 2, 2, [{ sku: 'A', serialized: true }])])
    expect(only.ok).toBe(false)
    const mismatch = catalogFromPages([page(1, 1, 2, [{ sku: 'A', serialized: true }])])
    expect(mismatch.ok).toBe(false)
    const huge = catalogFromPages([page(1, 7, 1, [{ sku: 'A', serialized: true }])])
    expect(huge.ok).toBe(false)
  })

  it('drops a conflicting SKU and does not infer a prefix', () => {
    const merged = catalogFromPages([
      page(1, 2, 4, [
        { sku: 'R-9', serialized: false },
        { sku: 'C-9', serialized: true },
      ]),
      page(2, 2, 4, [
        { sku: 'R-9', serialized: true },
        { sku: 'OTHER', serialized: null },
      ]),
    ])
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(merged.catalog.bySku.has('R-9')).toBe(false)
    expect(merged.catalog.bySku.get('C-9')).toBe(true)
    expect(merged.catalog.conflicts).toBe(2)

    const list = loadRepoPriceList('Nayax').list!
    const lines = [
      { sku: 'C-9', qty: 105, scannable: null as boolean | null },
      { sku: 'R-9', qty: 105, scannable: null as boolean | null },
      { sku: 'ABSENT', qty: 20, scannable: null as boolean | null },
    ]
    assignScanFlags(lines, merged.catalog.bySku)
    expect(lines.map((line) => line.scannable)).toEqual([true, null, null])
    expect(priceClassifiedPick(list, [lines[0]]).amount).toBe(9.1)
    expect(priceClassifiedPick(list, [{ sku: 'R-9', qty: 105, scannable: false }]).amount).toBe(21)
    expect(priceClassifiedPick(list, lines).amount).toBeNull()
  })
})
