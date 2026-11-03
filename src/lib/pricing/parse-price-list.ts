// Turns an uploaded JSON document into a price list, or says what is wrong
// with it. Nothing here supplies a rate the file left out.

import type {
  BoxRate,
  OrderPickRate,
  PalletBuildRate,
  PeakBasis,
  PriceListAmbiguity,
  PriceListDocument,
  PriceListService,
  ReturnRate,
  ShippingCell,
  ShippingSchedule,
} from './types'

const PEAK_BASIS: PeakBasis[] = [
  'device_pick',
  'accessory_pick',
  'box',
  'receiving',
  'storage',
  'labour',
  'materials',
]

export type ParsedPriceList =
  | { ok: true; list: PriceListDocument }
  | { ok: false; error: string }

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

function dateOrNull(v: unknown, label: string): { value: string | null; error: string | null } {
  if (v === null || v === undefined || v === '') return { value: null, error: null }
  const s = str(v)
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { value: null, error: `${label} must be YYYY-MM-DD or empty` }
  }
  return { value: s, error: null }
}

export function parsePriceList(input: unknown): ParsedPriceList {
  if (!isObject(input)) return { ok: false, error: 'price list must be a JSON object' }
  const name = str(input.name)
  const clientName = str(input.clientName)
  if (!name) return { ok: false, error: 'price list needs a name' }
  if (!clientName) return { ok: false, error: 'price list needs a clientName' }

  let devicePick: PriceListDocument['devicePick'] = null
  if (input.devicePick != null) {
    if (!isObject(input.devicePick)) return { ok: false, error: 'devicePick must be an object' }
    const cartonSize = num(input.devicePick.cartonSize)
    const cartonRate = num(input.devicePick.cartonRate)
    const remainderRate = num(input.devicePick.remainderRate)
    const prefixes = input.devicePick.skuPrefixes
    if (cartonSize === null || !Number.isInteger(cartonSize) || cartonSize <= 0) {
      return { ok: false, error: 'devicePick.cartonSize must be a positive whole number' }
    }
    if (cartonRate === null || cartonRate < 0) return { ok: false, error: 'devicePick.cartonRate is missing' }
    if (remainderRate === null || remainderRate < 0) {
      return { ok: false, error: 'devicePick.remainderRate is missing' }
    }
    if (!Array.isArray(prefixes) || prefixes.length === 0 || prefixes.some((p) => typeof p !== 'string' || !p.trim())) {
      return { ok: false, error: 'devicePick.skuPrefixes must be a non-empty list of strings' }
    }
    devicePick = {
      cartonSize,
      cartonRate,
      remainderRate,
      skuPrefixes: prefixes.map((p) => String(p).trim().toUpperCase()),
    }
  }

  let accessoryPick: PriceListDocument['accessoryPick'] = null
  if (input.accessoryPick != null) {
    if (!isObject(input.accessoryPick)) return { ok: false, error: 'accessoryPick must be an object' }
    const unitRate = num(input.accessoryPick.unitRate)
    if (unitRate === null || unitRate < 0) return { ok: false, error: 'accessoryPick.unitRate is missing' }
    accessoryPick = { unitRate }
  }

  let orderPick: OrderPickRate | null = null
  if (input.orderPick != null) {
    if (!isObject(input.orderPick)) return { ok: false, error: 'orderPick must be an object' }
    const includedItems = num(input.orderPick.includedItems)
    const orderRate = num(input.orderPick.orderRate)
    const additionalRate = num(input.orderPick.additionalRate)
    if (includedItems === null || !Number.isInteger(includedItems) || includedItems <= 0) {
      return { ok: false, error: 'orderPick.includedItems must be a positive whole number' }
    }
    if (orderRate === null || orderRate < 0) return { ok: false, error: 'orderPick.orderRate is missing' }
    if (additionalRate === null || additionalRate < 0) return { ok: false, error: 'orderPick.additionalRate is missing' }
    orderPick = { includedItems, orderRate, additionalRate }
  }
  if (orderPick && (devicePick || accessoryPick)) {
    return { ok: false, error: 'orderPick cannot be combined with devicePick or accessoryPick' }
  }

  const boxes: BoxRate[] = []
  if (input.boxes != null) {
    if (!Array.isArray(input.boxes)) return { ok: false, error: 'boxes must be a list' }
    for (const row of input.boxes) {
      if (!isObject(row)) return { ok: false, error: 'each box needs a code and a rate' }
      const code = str(row.code)
      const rate = num(row.rate)
      if (!code || rate === null || rate < 0) return { ok: false, error: 'each box needs a code and a rate' }
      boxes.push({ code, rate })
    }
  }

  let noBoxListed: PriceListDocument['noBoxListed'] = null
  if (input.noBoxListed != null) {
    if (!isObject(input.noBoxListed)) return { ok: false, error: 'noBoxListed must be an object' }
    const weightLabel = str(input.noBoxListed.weightLabel)
    const rate = num(input.noBoxListed.rate)
    if (!weightLabel || rate === null || rate < 0) {
      return { ok: false, error: 'noBoxListed needs a weightLabel and a rate' }
    }
    noBoxListed = { weightLabel, rate }
  }

  let receiving: PriceListDocument['receiving'] = null
  if (input.receiving != null) {
    if (!isObject(input.receiving)) return { ok: false, error: 'receiving must be an object' }
    const perCarton = num(input.receiving.perCarton)
    if (perCarton === null || perCarton < 0) return { ok: false, error: 'receiving.perCarton is missing' }
    receiving = { perCarton }
  }

  let storage: PriceListDocument['storage'] = null
  if (input.storage != null) {
    if (!isObject(input.storage)) return { ok: false, error: 'storage must be an object' }
    const perPallet = num(input.storage.perPallet)
    const perShelf = num(input.storage.perShelf)
    if (perPallet === null || perPallet < 0 || perShelf === null || perShelf < 0) {
      return { ok: false, error: 'storage needs perPallet and perShelf' }
    }
    storage = { perPallet, perShelf }
  }

  let labour: PriceListDocument['labour'] = null
  if (input.labour != null) {
    if (!isObject(input.labour)) return { ok: false, error: 'labour must be an object' }
    const perHour = num(input.labour.perHour)
    if (perHour === null || perHour < 0) return { ok: false, error: 'labour.perHour is missing' }
    labour = { perHour }
  }

  let returns: ReturnRate | null = null
  if (input.returns != null) {
    if (!isObject(input.returns)) return { ok: false, error: 'returns must be an object' }
    const perReturn = num(input.returns.perReturn)
    const additionalItemRate = num(input.returns.additionalItemRate)
    if (perReturn === null || perReturn < 0) return { ok: false, error: 'returns.perReturn is missing' }
    if (additionalItemRate === null || additionalItemRate < 0) {
      return { ok: false, error: 'returns.additionalItemRate is missing' }
    }
    returns = { perReturn, additionalItemRate }
  }

  let palletBuild: PalletBuildRate | null = null
  if (input.palletBuild != null) {
    if (!isObject(input.palletBuild)) return { ok: false, error: 'palletBuild must be an object' }
    const perPallet = num(input.palletBuild.perPallet)
    if (perPallet === null || perPallet < 0) return { ok: false, error: 'palletBuild.perPallet is missing' }
    palletBuild = { perPallet }
  }

  let materials: PriceListDocument['materials'] = null
  if (input.materials != null) {
    if (!isObject(input.materials)) return { ok: false, error: 'materials must be an object' }
    const markupPct = num(input.materials.markupPct)
    if (markupPct === null) return { ok: false, error: 'materials.markupPct is missing' }
    materials = { markupPct }
  }

  let peak: PriceListDocument['peak'] = null
  if (input.peak != null) {
    if (!isObject(input.peak)) return { ok: false, error: 'peak must be an object' }
    const pct = num(input.peak.pct)
    const fromMonthDay = str(input.peak.fromMonthDay)
    const toMonthDay = str(input.peak.toMonthDay)
    if (pct === null || pct < 0) return { ok: false, error: 'peak.pct is missing' }
    if (!fromMonthDay || !/^\d{2}-\d{2}$/.test(fromMonthDay)) {
      return { ok: false, error: 'peak.fromMonthDay must be MM-DD' }
    }
    if (!toMonthDay || !/^\d{2}-\d{2}$/.test(toMonthDay)) {
      return { ok: false, error: 'peak.toMonthDay must be MM-DD' }
    }
    if (!Array.isArray(input.peak.appliesTo) || input.peak.appliesTo.length === 0) {
      return { ok: false, error: 'peak.appliesTo must name the fees it covers' }
    }
    const appliesTo: PeakBasis[] = []
    for (const item of input.peak.appliesTo) {
      if (typeof item !== 'string' || !PEAK_BASIS.includes(item as PeakBasis)) {
        return { ok: false, error: `peak.appliesTo has an unknown fee "${String(item)}"` }
      }
      appliesTo.push(item as PeakBasis)
    }
    peak = { pct, fromMonthDay, toMonthDay, appliesTo }
  }

  const shippingSameAs = input.shippingSameAs == null || input.shippingSameAs === ''
    ? null
    : str(input.shippingSameAs)
  if (input.shippingSameAs != null && input.shippingSameAs !== '' && !shippingSameAs) {
    return { ok: false, error: 'shippingSameAs must name a client' }
  }

  let shipping: PriceListDocument['shipping'] = null
  if (shippingSameAs && input.shipping != null) {
    return { ok: false, error: 'shipping references another card, so it cannot also embed cells' }
  }
  if (input.shipping != null) {
    if (!isObject(input.shipping)) return { ok: false, error: 'shipping must be an object' }
    if (!Array.isArray(input.shipping.schedules) || input.shipping.schedules.length === 0) {
      return { ok: false, error: 'shipping.schedules is missing' }
    }
    if (!Array.isArray(input.shipping.cells)) return { ok: false, error: 'shipping.cells must be a list' }
    const schedules: ShippingSchedule[] = []
    for (const row of input.shipping.schedules) {
      if (!isObject(row)) return { ok: false, error: 'each shipping schedule must be an object' }
      const from = dateOrNull(row.effectiveFrom, 'shipping.effectiveFrom')
      const to = dateOrNull(row.effectiveTo, 'shipping.effectiveTo')
      if (from.error) return { ok: false, error: from.error }
      if (to.error) return { ok: false, error: to.error }
      const divideBy = num(row.divideBy)
      if (divideBy === null || divideBy === 0) return { ok: false, error: 'shipping.divideBy is missing' }
      schedules.push({ effectiveFrom: from.value, effectiveTo: to.value, divideBy })
    }
    const cells: ShippingCell[] = []
    for (const row of input.shipping.cells) {
      if (!isObject(row)) return { ok: false, error: 'each shipping cell needs weightLb, zone and rate' }
      const weightLb = num(row.weightLb)
      const zone = num(row.zone)
      const rate = num(row.rate)
      if (weightLb === null || !Number.isInteger(weightLb) || weightLb <= 0) {
        return { ok: false, error: 'shipping weightLb must be a positive whole number' }
      }
      if (zone === null || !Number.isInteger(zone) || zone <= 0) {
        return { ok: false, error: 'shipping zone must be a positive whole number' }
      }
      if (rate === null || rate < 0) return { ok: false, error: 'shipping rate is missing' }
      cells.push({ weightLb, zone, rate })
    }
    shipping = { schedules, cells }
  }

  const services: PriceListService[] = []
  if (input.services != null) {
    if (!Array.isArray(input.services)) return { ok: false, error: 'services must be a list' }
    for (const row of input.services) {
      if (!isObject(row)) return { ok: false, error: 'each service needs a name and a basis' }
      const serviceName = str(row.name)
      const basis = str(row.basis)
      if (!serviceName || !basis) return { ok: false, error: 'each service needs a name and a basis' }
      let amount: number | null = null
      if (row.amount != null) {
        amount = num(row.amount)
        if (amount === null || amount < 0) return { ok: false, error: `service ${serviceName} has no amount` }
      }
      services.push({ name: serviceName, basis, amount })
    }
  }

  const ambiguous: PriceListAmbiguity[] = []
  if (input.ambiguous != null) {
    if (!Array.isArray(input.ambiguous)) return { ok: false, error: 'ambiguous must be a list' }
    for (const row of input.ambiguous) {
      if (!isObject(row)) return { ok: false, error: 'each ambiguous line needs a source and a reason' }
      const source = str(row.source)
      const reason = str(row.reason)
      if (!source || !reason) return { ok: false, error: 'each ambiguous line needs a source and a reason' }
      ambiguous.push({ source, reason })
    }
  }

  return {
    ok: true,
    list: {
      name,
      clientName,
      devicePick,
      accessoryPick,
      orderPick,
      boxes,
      noBoxListed,
      receiving,
      storage,
      labour,
      returns,
      palletBuild,
      materials,
      peak,
      shippingSameAs,
      shipping,
      services,
      ambiguous,
    },
  }
}

/**
 * Point `list.shipping` at another list's card.
 *
 * The assignment is the same object, so a later edit of the source card
 * is the edit Orcam prices from. Nothing here copies a rate into a new cell.
 */
export function withShippingReference(
  list: PriceListDocument,
  catalogs: Record<string, PriceListDocument>,
): ParsedPriceList {
  if (!list.shippingSameAs) return { ok: true, list }
  const source = catalogs[list.shippingSameAs]
  if (!source) return { ok: false, error: `no price list named ${list.shippingSameAs}` }
  if (!source.shipping || source.shipping.cells.length === 0) {
    return { ok: false, error: `${list.shippingSameAs} has no shipping card to reference` }
  }
  return { ok: true, list: { ...list, shipping: source.shipping } }
}

/** One-line description of a list, for the client page. Rates come from the document. */
export function summarizePriceList(list: PriceListDocument): string[] {
  const lines: string[] = []
  if (list.devicePick) {
    const d = list.devicePick
    lines.push(
      `Devices: floor(units/${d.cartonSize}) × $${d.cartonRate.toFixed(2)}`
      + ` + remainder × $${d.remainderRate.toFixed(2)}`
      + ` (SKU prefixes ${d.skuPrefixes.join(', ')})`,
    )
  }
  if (list.accessoryPick) lines.push(`Accessories: $${list.accessoryPick.unitRate.toFixed(2)} each`)
  if (list.orderPick) {
    const p = list.orderPick
    lines.push(
      `Pick and pack: $${p.orderRate.toFixed(2)} per order up to ${p.includedItems} items`
      + ` + $${p.additionalRate.toFixed(2)} each additional item`,
    )
  }
  if (list.boxes.length) lines.push(`Box material: ${list.boxes.length} sizes`)
  if (list.noBoxListed) {
    lines.push(`No box listed (${list.noBoxListed.weightLabel}): $${list.noBoxListed.rate.toFixed(2)}`)
  }
  if (list.receiving) lines.push(`Receiving: $${list.receiving.perCarton.toFixed(2)} per carton`)
  if (list.storage) {
    lines.push(
      `Storage: $${list.storage.perPallet.toFixed(2)} per pallet or $${list.storage.perShelf.toFixed(2)} per shelf`,
    )
  }
  if (list.labour) lines.push(`Labour: $${list.labour.perHour.toFixed(2)} per hour`)
  if (list.returns) {
    lines.push(
      `Returns: $${list.returns.perReturn.toFixed(2)} per return`
      + ` + $${list.returns.additionalItemRate.toFixed(2)} per additional returned item`,
    )
  }
  if (list.palletBuild) {
    lines.push(`Pallet build: $${list.palletBuild.perPallet.toFixed(2)} per pallet built (shrink wrap included)`)
  }
  if (list.materials) lines.push(`Materials: cost + ${list.materials.markupPct}%`)
  if (list.peak) {
    lines.push(
      `Peak: ${list.peak.pct}% from ${list.peak.fromMonthDay} to ${list.peak.toMonthDay}`
      + ` on ${list.peak.appliesTo.join(', ')}`,
    )
  }
  if (list.shippingSameAs && list.shipping) {
    lines.push(
      `Shipping: ${list.shippingSameAs}'s card, ${list.shipping.cells.length} zone cells, referenced`,
    )
  } else if (list.shippingSameAs) {
    lines.push(`Shipping: same card as ${list.shippingSameAs}`)
  } else if (list.shipping) {
    lines.push(
      `Shipping: ${list.shipping.cells.length} zone cells, ${list.shipping.schedules.length} schedule(s)`,
    )
  }
  for (const service of list.services) {
    const amount = service.amount === null ? 'no dollar amount' : `$${service.amount.toFixed(2)}`
    lines.push(`Service: ${service.name} — ${amount} ${service.basis}`)
  }
  for (const row of list.ambiguous) {
    lines.push(`Not applied: ${row.source}`)
  }
  return lines
}
