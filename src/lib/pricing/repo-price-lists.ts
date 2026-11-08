import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePriceList, withShippingReference } from './parse-price-list'
import type { PriceListDocument } from './types'

// Price lists that live in the repo. An upload on the client page is a
// separate document. Orcam's shipping card is Nayax's object, not a copy
// of Nayax's cells.

const ROOT = join(process.cwd(), 'price-lists')

const FILES: Record<string, string> = {
  Nayax: 'nayax.json',
  Orcam: 'orcam.json',
}

function readDocument(file: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, file), 'utf8'))
}

function namesMatch(clientName: string, listClient: string): boolean {
  const client = clientName.trim().toLowerCase()
  const list = listClient.trim().toLowerCase()
  if (!client || !list) return false
  return client === list || client.startsWith(`${list} `) || client.startsWith(`${list}-`)
}

export function loadRepoPriceList(clientName: string): {
  list: PriceListDocument | null
  error: string | null
} {
  let nayax: PriceListDocument
  try {
    const parsed = parsePriceList(readDocument(FILES.Nayax))
    if (!parsed.ok) return { list: null, error: parsed.error }
    nayax = parsed.list
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { list: null, error: message }
  }

  const catalogs: Record<string, PriceListDocument> = { Nayax: nayax }
  const wanted = clientName.trim().toLowerCase()
  if (namesMatch(wanted, nayax.clientName)) return { list: nayax, error: null }

  try {
    const parsed = parsePriceList(readDocument(FILES.Orcam))
    if (!parsed.ok) return { list: null, error: parsed.error }
    if (!namesMatch(wanted, parsed.list.clientName)) return { list: null, error: null }
    const resolved = withShippingReference(parsed.list, catalogs)
    if (!resolved.ok) return { list: null, error: resolved.error }
    return { list: resolved.list, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { list: null, error: message }
  }
}
