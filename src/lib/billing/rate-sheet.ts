import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { calcDimWeightOz } from '@/lib/billing/dim-weight'

// Ophir's 2026-11 shipping rate sheet. Every number is stored as he sent it.
// The file is a price list: client tabs and the three ICL tabs are all prices
// a client is charged. Nothing in here is Shipo's cost.
//
// ICL (regular, 2nd day, next day) is its own price list. It is not linked to
// a dashboard client yet.

export interface RateBand {
  sourceTab: string
  client: string
  service: string
  unit: 'oz' | 'lb'
  weightMax: number
  /** Set for Suteka, whose bands have a start weight. Null means "up to weightMax". */
  weightMin: number | null
  zone: string
  price: number
}

export interface RateSheet {
  bands: RateBand[]
  /** Dashboard client name (lower-case) to the sheet tab. ICL is not in here. */
  clientTabs: Record<string, string>
}

const SHEET_PATH = join(process.cwd(), 'data/rates/2026-11-sheet.csv')
const SUTEKA_PATH = join(process.cwd(), 'data/rates/2026-11-suteka.csv')

const CLIENT_TABS: Record<string, string> = {
  sitnstand: 'SitnStand',
  suteka: 'Suteka',
  kivema: 'Kivema',
  timesystem: 'Timesystem',
  'time systems': 'Timesystem',
  'time systems (uk) ltd': 'Timesystem',
  creativepea: 'CreativePea',
  'creative pea': 'CreativePea',
}

let cached: RateSheet | null = null

export function sheetClientKey(name: string): string | null {
  const key = name.trim().toLowerCase()
  return CLIENT_TABS[key] ?? null
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else quoted = false
      } else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (c !== '\r') cell += c
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** Suteka start weight by end weight, from the raw band file. Prices stay in the sheet. */
export function sutekaStarts(text: string): Map<number, number> {
  const starts = new Map<number, number>()
  for (const row of parseCsv(text)) {
    const start = Number(row[0])
    const end = Number(row[1])
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    starts.set(end, start)
  }
  return starts
}

export function parseRateSheet(sheetText: string, sutekaText: string): RateSheet {
  const starts = sutekaStarts(sutekaText)
  const table = parseCsv(sheetText)
  const header = table[0]?.map((c) => c.trim()) ?? []
  const col = (name: string) => header.indexOf(name)
  const bands: RateBand[] = []
  for (const row of table.slice(1)) {
    const sourceTab = row[col('source_tab')]?.trim() ?? ''
    const service = row[col('service')]?.trim() ?? ''
    const unitRaw = row[col('weight_unit')]?.trim().toLowerCase()
    const weightMax = Number(row[col('weight_max')])
    const zone = row[col('zone')]?.trim() ?? ''
    const price = Number(row[col('price')])
    if (!sourceTab || (unitRaw !== 'oz' && unitRaw !== 'lb')) continue
    if (!Number.isFinite(weightMax) || !Number.isFinite(price) || !zone) continue
    const icl = sourceTab.startsWith('ICL')
    const client = icl ? 'ICL' : (row[col('client')]?.trim() || sourceTab)
    const weightMin = client === 'Suteka' ? starts.get(weightMax) ?? null : null
    bands.push({
      sourceTab,
      client,
      service: icl ? service : (service || 'unspecified'),
      unit: unitRaw,
      weightMax,
      weightMin,
      zone,
      price,
    })
  }
  return { bands, clientTabs: CLIENT_TABS }
}

export function loadRateSheet(): RateSheet {
  if (cached) return cached
  cached = parseRateSheet(readFileSync(SHEET_PATH, 'utf8'), readFileSync(SUTEKA_PATH, 'utf8'))
  return cached
}

export interface RateCheckFlags {
  /**
   * Round up: next whole ounce in an ounce section, next whole pound in a
   * pound section. Suteka keeps its own band edges and is not rounded.
   * Default on.
   */
  roundWeight: boolean
  /** When dimensions exist and DIM weight is higher, price on that. Default on. */
  useDimensionalWeight: boolean
}

export const DEFAULT_RATE_CHECK_FLAGS: RateCheckFlags = {
  roundWeight: true,
  useDimensionalWeight: true,
}

export type RateMatchKind = 'matched' | 'unmatched' | 'no_sheet' | 'manual'

const NO_SHEET = 'no sheet rates'
const MANUAL = 'Needs manual price (client approval)'
export const NO_DIMENSIONS = 'No dimensions on the shipment; priced on actual weight.'

/** Client tabs are the regular five-day ground price. */
export function isRegularGround(service: string | null | undefined): boolean {
  const name = (service ?? '').trim().toLowerCase()
  if (!name) return false
  if (/international|next[\s_-]*day|overnight|express|2nd|second[\s_-]*day|2[\s_-]*day|priority/.test(name)) {
    return false
  }
  return /ground|advantage|parcel|first[\s_-]*class|surepost/.test(name)
}

export interface RateMatch {
  price: number | null
  unit: 'oz' | 'lb' | null
  bandWeight: number | null
  zone: string | null
  reason: string | null
  kind: RateMatchKind
}

function zoneLabel(zone: number, bands: readonly RateBand[]): string | null {
  if ((zone === 1 || zone === 2) && bands.some((b) => b.zone === '1&2')) return '1&2'
  const specific = String(zone)
  return bands.some((b) => b.zone === specific) ? specific : null
}

function covering(
  bands: readonly RateBand[],
  unit: 'oz' | 'lb',
  weight: number,
  zone: string,
): RateBand | 'over' | 'gap' {
  const list = bands
    .filter((b) => b.unit === unit && b.zone === zone)
    .sort((a, b) => a.weightMax - b.weightMax)
  let sawCeiling = false
  for (const band of list) {
    if (band.weightMax + 1e-9 < weight) continue
    sawCeiling = true
    if (band.weightMin != null && weight + 1e-9 < band.weightMin) return 'gap'
    return band
  }
  return sawCeiling ? 'gap' : 'over'
}

function blankMatch(kind: RateMatchKind, reason: string): RateMatch {
  return { price: null, unit: null, bandWeight: null, zone: null, reason, kind }
}

function roundUp(value: number): number {
  return Math.ceil(value - 1e-9)
}

/**
 * Smallest band whose weight_max is at least the shipment weight.
 *
 * The sheet has no start or end date, so nothing here filters on ship date.
 * Ounce sections round up to the next ounce and pound sections to the next
 * whole pound, except Suteka, whose bands keep the edges in the raw file.
 * Above 6 lb, Suteka has no automatic price.
 */
export function matchClientPrice(
  sheet: RateSheet,
  input: {
    clientName: string
    weightOz: number
    zone: number
    service?: string | null
    roundWeight?: boolean
  },
): RateMatch {
  const roundWeight = input.roundWeight !== false
  const tab = sheetClientKey(input.clientName)
  if (!tab) return blankMatch('no_sheet', NO_SHEET)
  if (!Number.isFinite(input.weightOz) || input.weightOz <= 0) {
    return blankMatch('unmatched', 'No weight on the shipment.')
  }
  if (tab === 'Suteka' && input.weightOz / 16 > 6 + 1e-9) {
    return blankMatch('manual', MANUAL)
  }
  if (!Number.isInteger(input.zone) || input.zone < 1 || input.zone > 8) {
    return blankMatch('unmatched', 'No zone on the shipment.')
  }
  if (tab !== 'ICL' && !isRegularGround(input.service)) {
    const service = input.service?.trim()
    return blankMatch('unmatched', service
      ? `Sheet rates are for regular five-day ground. This shipment is ${service}.`
      : 'No service on the shipment.')
  }
  const bands = sheet.bands.filter((b) => b.client === tab && (tab === 'ICL' ? b.service === (input.service ?? '') : true))
  if (bands.length === 0) return blankMatch('no_sheet', NO_SHEET)
  const label = zoneLabel(input.zone, bands)
  if (!label) return blankMatch('unmatched', `Zone ${input.zone} is not on this client's sheet.`)

  const ozBands = bands.filter((b) => b.unit === 'oz' && b.zone === label)
  const suteka = tab === 'Suteka'
  let unit: 'oz' | 'lb' = 'lb'
  let weight = input.weightOz / 16
  if (ozBands.length > 0) {
    const maxOz = Math.max(...ozBands.map((b) => b.weightMax))
    if (input.weightOz <= maxOz + 1e-9) {
      const roundedOz = !suteka && roundWeight ? roundUp(input.weightOz) : input.weightOz
      if (roundedOz <= maxOz + 1e-9) {
        unit = 'oz'
        weight = roundedOz
      } else {
        weight = !suteka && roundWeight ? roundUp(input.weightOz / 16) : input.weightOz / 16
      }
    } else if (!suteka && roundWeight) {
      weight = roundUp(input.weightOz / 16)
    }
  } else if (!suteka && roundWeight) {
    weight = roundUp(weight)
  }
  const band = covering(bands, unit, weight, label)
  if (band === 'over') {
    return { ...blankMatch('unmatched', `Weight is above the heaviest ${unit} band on the sheet.`), unit, zone: label }
  }
  if (band === 'gap') {
    return { ...blankMatch('unmatched', 'Weight falls outside the bands on the sheet.'), unit, zone: label }
  }
  return { price: band.price, unit, bandWeight: band.weightMax, zone: label, reason: null, kind: 'matched' }
}

export function toOunces(value: number | null, unit: string | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null
  return (unit ?? 'ounces').toLowerCase().startsWith('pound') ? value * 16 : value
}

/**
 * Actual weight, or dimensional weight when the shipment has dims and that
 * weight is higher. Missing dimensions are reported; they do not invent a price.
 */
export function chargeableOunces(
  input: {
    weight: number | null
    weightUnit: string | null
    length: number | null
    width: number | null
    height: number | null
    dimWeight: number | null
    carrier: string | null
    service: string | null
  },
  flags: RateCheckFlags = DEFAULT_RATE_CHECK_FLAGS,
): { ounces: number | null; note: string | null } {
  const actual = toOunces(input.weight, input.weightUnit)
  const hasBox = (input.length ?? 0) > 0 && (input.width ?? 0) > 0 && (input.height ?? 0) > 0
  const storedDim = toOunces(input.dimWeight, 'ounces')
  if (!flags.useDimensionalWeight) return { ounces: actual, note: null }
  if (!hasBox && storedDim == null) {
    return { ounces: actual, note: actual == null ? null : NO_DIMENSIONS }
  }
  const dim = hasBox
    ? calcDimWeightOz(input.length ?? 0, input.width ?? 0, input.height ?? 0, input.carrier, input.service) ?? storedDim
    : storedDim
  if (actual == null) return { ounces: dim, note: null }
  if (dim != null && dim > actual) return { ounces: dim, note: null }
  return { ounces: actual, note: null }
}
