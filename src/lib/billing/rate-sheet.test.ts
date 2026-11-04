import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chargeableOunces, loadRateSheet, matchClientPrice, NO_DIMENSIONS, parseRateSheet } from './rate-sheet'

const sheet = () => loadRateSheet()

describe('2026-11 rate sheet', () => {
  it('keeps every row from the file', () => {
    const text = readFileSync(join(process.cwd(), 'data/rates/2026-11-sheet.csv'), 'utf8')
    const parsed = parseRateSheet(text, readFileSync(join(process.cwd(), 'data/rates/2026-11-suteka.csv'), 'utf8'))
    expect(parsed.bands).toHaveLength(3298)
    const sitn = parsed.bands.find((b) => b.client === 'SitnStand' && b.unit === 'lb' && b.weightMax === 1 && b.zone === '1&2')
    expect(sitn?.price).toBe(23.68)
  })

  it('prices SitnStand zone 1 from the combined 1&2 cell', () => {
    const match = matchClientPrice(sheet(), { clientName: 'SitnStand', weightOz: 16, zone: 1, service: 'usps_ground_advantage' })
    expect(match.price).toBe(23.68)
    expect(match.zone).toBe('1&2')
    expect(match.reason).toBeNull()
  })

  it('uses the ounce band up to the sheet boundary, then pounds', () => {
    const atCap = matchClientPrice(sheet(), { clientName: 'Creative Pea', weightOz: 16, zone: 1, service: 'ground' })
    const over = matchClientPrice(sheet(), { clientName: 'Creative Pea', weightOz: 16.1, zone: 1, service: 'ground' })
    expect(atCap.unit).toBe('oz')
    expect(atCap.price).toBe(7.85)
    expect(over.unit).toBe('lb')
    expect(over.bandWeight).toBe(2)
  })

  it('sends 16 oz Kivema to the 1 lb band because the ounce bands stop at 15.99', () => {
    const match = matchClientPrice(sheet(), { clientName: 'Kivema', weightOz: 16, zone: 1, service: 'ground' })
    expect(match.unit).toBe('lb')
    expect(match.bandWeight).toBe(1)
    expect(match.price).toBe(16.59)
  })

  it('keeps Suteka inside the raw start and end weights', () => {
    const light = matchClientPrice(sheet(), { clientName: 'Suteka', weightOz: 0.3 * 16, zone: 1, service: 'ground' })
    const gap = matchClientPrice(sheet(), { clientName: 'Suteka', weightOz: 0.55 * 16, zone: 1, service: 'ground' })
    const next = matchClientPrice(sheet(), { clientName: 'Suteka', weightOz: 0.7 * 16, zone: 1, service: 'ground' })
    expect(light.price).toBe(8.14)
    expect(gap.price).toBeNull()
    expect(gap.reason).toMatch(/outside the bands/)
    expect(next.price).toBe(9.34)
  })

  it('says when the client, the zone, or the weight cannot be priced', () => {
    expect(matchClientPrice(sheet(), { clientName: 'Nayax', weightOz: 16, zone: 4, service: 'ground' })).toMatchObject({
      kind: 'no_sheet',
      reason: 'no sheet rates',
    })
    expect(matchClientPrice(sheet(), { clientName: 'SitnStand', weightOz: 16, zone: 0, service: 'ground' }).reason).toMatch(/No zone/)
    expect(matchClientPrice(sheet(), { clientName: 'Suteka', weightOz: 7 * 16, zone: 4, service: 'ground' })).toMatchObject({
      kind: 'manual',
      reason: 'Needs manual price (client approval)',
    })
  })

  it('rounds ounce sections up to the next ounce and pound sections up to the next pound', () => {
    const rounded = matchClientPrice(sheet(), { clientName: 'Creative Pea', weightOz: 10.2, zone: 1, service: 'ground' })
    expect(rounded.unit).toBe('oz')
    expect(rounded.bandWeight).toBe(11)
    const pounds = matchClientPrice(sheet(), { clientName: 'SitnStand', weightOz: 18, zone: 4, service: 'usps_ground_advantage' })
    expect(pounds.unit).toBe('lb')
    expect(pounds.bandWeight).toBe(2)
  })

  it('does not round Suteka off its band edges', () => {
    const inside = matchClientPrice(sheet(), { clientName: 'Suteka', weightOz: 1.2 * 16, zone: 1, service: 'ground' })
    const gap = matchClientPrice(sheet(), { clientName: 'Suteka', weightOz: 1.05 * 16, zone: 1, service: 'ground' })
    expect(inside.bandWeight).toBe(2)
    expect(inside.price).toBe(14.52)
    expect(gap.kind).toBe('unmatched')
  })

  it('uses a higher dimensional weight and notes missing dimensions', () => {
    const higher = chargeableOunces({
      weight: 16, weightUnit: 'ounces', length: 20, width: 15, height: 10,
      dimWeight: null, carrier: 'usps', service: 'usps_ground_advantage',
    })
    expect(higher.ounces).toBeGreaterThan(16)
    expect(higher.note).toBeNull()
    const missing = chargeableOunces({
      weight: 16, weightUnit: 'ounces', length: null, width: null, height: null,
      dimWeight: null, carrier: 'usps', service: 'ground',
    })
    expect(missing.ounces).toBe(16)
    expect(missing.note).toBe(NO_DIMENSIONS)
  })

  it('keeps ICL as its own price list and does not price another client from it', () => {
    const icl = sheet().bands.filter((b) => b.client === 'ICL')
    expect(new Set(icl.map((b) => b.service))).toEqual(new Set(['regular', '2nd_day', 'next_day']))
    const sitn = matchClientPrice(sheet(), { clientName: 'SitnStand', weightOz: 32, zone: 4, service: 'ground' })
    expect(sitn.price).not.toBe(icl.find((b) => b.service === 'regular' && b.zone === '4' && b.weightMax === 2)?.price)
  })
})
