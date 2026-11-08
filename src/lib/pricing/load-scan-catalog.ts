import { getItems } from '@/lib/api/zenventory'
import { readOrderReadCredentials } from '@/lib/zenventory/client-env'
import {
  SCAN_CATALOG_MAX_PAGES,
  SCAN_CATALOG_PER_PAGE,
  catalogFromPages,
  readCatalogPage,
  type CatalogPage,
} from '@/lib/pricing/scan-catalog'

export interface LoadedScanCatalog {
  ok: boolean
  bySku: Map<string, boolean>
  note: string
}

const CLOSED = ' The R/D prefix was not used and serial counts were not used.'

function closed(note: string): LoadedScanCatalog {
  return { ok: false, bySku: new Map(), note: `${note}${CLOSED}` }
}

/**
 * Read-only GET /items for one client, using the same env pair as the
 * order read. No legacy call: that list does not page. No write.
 * A failed or incomplete read returns no flags.
 */
export async function loadScanCatalog(
  clientName: string,
  env: Record<string, string | undefined> = process.env,
): Promise<LoadedScanCatalog> {
  const creds = readOrderReadCredentials(clientName, env)
  if (!creds.ok || !creds.credentials.apiKey || !creds.credentials.apiSecret) {
    const notice = creds.ok
      ? `${clientName} has no API 2.0 item-list pair.`
      : creds.notice
    return closed(`Scan requirement was not read. ${notice} The item list was not requested.`)
  }
  const pages: CatalogPage[] = []
  let total = 1
  for (let page = 1; page <= total; page++) {
    if (page > SCAN_CATALOG_MAX_PAGES) {
      return closed(`Scan requirement was not read. The item list is above the ${SCAN_CATALOG_MAX_PAGES}-page bound.`)
    }
    let body: unknown
    try {
      body = await getItems(creds.credentials.apiKey, creds.credentials.apiSecret, {
        page,
        perPage: SCAN_CATALOG_PER_PAGE,
        active: true,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status = /HTTP (\d+)/.exec(message)?.[1]
      return closed(`Scan requirement was not read. The item list failed${status ? ` (HTTP ${status})` : ''}.`)
    }
    const read = readCatalogPage(body)
    if (!read.ok) return closed(`Scan requirement was not read. ${read.reason}`)
    if (read.page.page !== page) return closed('Scan requirement was not read. A page came back out of order.')
    total = read.page.totalPages
    pages.push(read.page)
  }
  const catalog = catalogFromPages(pages)
  if (!catalog.ok) return closed(`Scan requirement was not read. ${catalog.reason}`)
  const { bySku, conflicts, missingFlag } = catalog.catalog
  return {
    ok: true,
    bySku,
    note: `Scan requirement came from the Zenventory item list (${bySku.size} SKUs, ${pages.length} page${pages.length === 1 ? '' : 's'}). `
      + `${conflicts} SKUs conflicted or had no boolean and stayed unknown. ${missingFlag} rows had no boolean. `
      + `A SKU that was not in this active list stays unknown.${CLOSED}`,
  }
}
