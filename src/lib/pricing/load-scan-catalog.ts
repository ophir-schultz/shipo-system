import { supabaseAdmin } from '@/lib/supabase'
import { getItems } from '@/lib/api/zenventory'
import {
  readZenventoryClientCredentials,
  type StoredClientZenventory,
} from '@/lib/zenventory/client-env'
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

async function storedPair(clientId: string): Promise<StoredClientZenventory | null> {
  const row = await supabaseAdmin
    .from('clients')
    .select('zenventory_api_key, zenventory_api_secret')
    .eq('id', clientId)
    .maybeSingle()
  if (row.error || !row.data) return null
  return {
    apiKey: row.data.zenventory_api_key,
    apiSecret: row.data.zenventory_api_secret,
  }
}

/**
 * Read-only GET /items. The env pair wins. The stored client pair is the
 * fallback the scheduled sync already uses, so a preview without the env
 * pair can still read. No legacy call: that list does not page. No write.
 * A failed or incomplete read returns no flags.
 */
export async function loadScanCatalog(
  clientName: string,
  options: {
    env?: Record<string, string | undefined>
    stored?: StoredClientZenventory | null
    clientId?: string
    readPage?: typeof getItems
  } = {},
): Promise<LoadedScanCatalog> {
  const env = options.env ?? process.env
  const stored = options.stored !== undefined
    ? options.stored
    : options.clientId
      ? await storedPair(options.clientId)
      : null
  const creds = readZenventoryClientCredentials(clientName, env, { stored })
  if (!creds.ok || !creds.credentials.apiKey || !creds.credentials.apiSecret) {
    const notice = creds.ok
      ? `${clientName} has no API 2.0 item-list pair.`
      : creds.notice
    return closed(`Scan requirement was not read. ${notice} The item list was not requested.`)
  }
  const readPage = options.readPage ?? getItems
  const pages: CatalogPage[] = []
  let total = 1
  for (let page = 1; page <= total; page++) {
    if (page > SCAN_CATALOG_MAX_PAGES) {
      return closed(`Scan requirement was not read. The item list is above the ${SCAN_CATALOG_MAX_PAGES}-page bound.`)
    }
    let body: unknown
    try {
      body = await readPage(creds.credentials.apiKey, creds.credentials.apiSecret, {
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
    note: `Scan requirement came from the current Zenventory item list at the time of this preview (${bySku.size} SKUs, ${pages.length} page${pages.length === 1 ? '' : 's'}, credential ${creds.credentials.keySource}). `
      + `It is not the flag on the ship day. ${conflicts} SKUs conflicted or had no boolean and stayed unknown. ${missingFlag} rows had no boolean. `
      + `A SKU that was not in this active list stays unknown. Inactive items are not in this read.${CLOSED} Agreement with a prefix is not historical proof.`,
  }
}
