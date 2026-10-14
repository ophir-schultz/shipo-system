import { describe, it, expect } from 'vitest'
import {
  validateLegacyRates, LEGACY_UNITS, WAREHOUSE_SERVICE_TYPES,
  WAREHOUSE_SERVICE_GROUPS, composeServiceNotes, overlapWarning,
  toEditableRates, ratesToSubmit, droppedServices, nextUnusedService,
} from './warehouse-rate-card'

// The function under test is the only thing standing between a request body
// and `insert()` on a table two different writers share. Its predecessor was
// nothing: POST /api/clients/[id]/warehouse-rates handed `body.rates` straight
// to Supabase, so a caller could name another client, could author the
// structured charge_type rows the seed files own, and could store a rate of
// NaN -- which JSON.stringify sends as null, and which the warehouse log then
// cannot price.
//
// Two properties are asserted throughout:
//
//   1. A refusal says WHICH row and WHY, because these bodies come from
//      spreadsheets and "invalid rates" sends the operator back to a file with
//      no idea which cell to look at.
//   2. A blank is never silently a 0. `Number('')` is 0, so the empty-cell
//      check has to run before coercion -- and 0 is a real price meaning "this
//      service is free", which is a statement someone made on purpose.

const CLIENT = 'client-aaa'

function ok(r: ReturnType<typeof validateLegacyRates>) {
  if ('error' in r) throw new Error(`expected success, got: ${r.error}`)
  return r
}

function err(r: ReturnType<typeof validateLegacyRates>) {
  if (!('error' in r)) throw new Error(`expected an error, got ${JSON.stringify(r)}`)
  return r.error
}

describe('validateLegacyRates', () => {
  // --- the accepted shape, the positive control for everything below --------

  it('accepts a well-formed rate and writes client_id from the URL', () => {
    const r = ok(validateLegacyRates(
      [{ service_type: 'storage', rate: 2.5, unit: 'per_unit' }], CLIENT))
    expect(r.rates).toEqual([
      { client_id: CLIENT, service_type: 'storage', rate: 2.5, unit: 'per_unit' },
    ])
    expect(r.warnings).toEqual([])
  })

  it('accepts several rates and keeps their order', () => {
    const r = ok(validateLegacyRates([
      { service_type: 'storage', rate: 1 },
      { service_type: 'receiving', rate: 2 },
      { service_type: 'labor_hours', rate: 3, unit: 'per_hour' },
    ], CLIENT))
    expect(r.rates.map((x) => x.service_type))
      .toEqual(['storage', 'receiving', 'labor_hours'])
  })

  it('coerces a rate that arrives as a string, as the uploader sends it', () => {
    // WarehouseRatesUpload.tsx builds `rate` with parseFloat over a
    // spreadsheet cell and the manual form holds it as input text, so a quoted
    // number is the normal case rather than the odd one.
    const r = ok(validateLegacyRates(
      [{ service_type: 'storage', rate: '3.40' }], CLIENT))
    expect(r.rates[0].rate).toBe(3.4)
  })

  it('keeps a rate of exactly 0, which means the service is free', () => {
    // The distinction this module exists to preserve, in the direction that is
    // easy to lose: refusing a 0 would make "this service is free" unsayable.
    const r = ok(validateLegacyRates(
      [{ service_type: 'storage', rate: 0 }], CLIENT))
    expect(r.rates[0].rate).toBe(0)
  })

  it('keeps a negative rate, which is a credit', () => {
    const r = ok(validateLegacyRates(
      [{ service_type: 'storage', rate: -1.25 }], CLIENT))
    expect(r.rates[0].rate).toBe(-1.25)
  })

  it('defaults a missing unit to per_unit rather than refusing', () => {
    const r = ok(validateLegacyRates([{ service_type: 'storage', rate: 1 }], CLIENT))
    expect(r.rates[0].unit).toBe('per_unit')
  })

  it('defaults an empty-string unit to per_unit', () => {
    // The Excel path writes `String(row['unit'] ?? 'per_unit')`, which yields
    // '' for a present-but-blank cell. '' is not in LEGACY_UNITS, so without
    // this the whole upload is refused over an empty column.
    const r = ok(validateLegacyRates(
      [{ service_type: 'storage', rate: 1, unit: '' }], CLIENT))
    expect(r.rates[0].unit).toBe('per_unit')
  })

  it('trims whitespace off service_type', () => {
    const r = ok(validateLegacyRates(
      [{ service_type: '  storage  ', rate: 1 }], CLIENT))
    expect(r.rates[0].service_type).toBe('storage')
  })

  it('accepts an explicit client_id that agrees with the URL', () => {
    const r = ok(validateLegacyRates(
      [{ client_id: CLIENT, service_type: 'storage', rate: 1 }], CLIENT))
    expect(r.rates[0].client_id).toBe(CLIENT)
  })

  it.each(LEGACY_UNITS)('accepts the unit %s', (unit) => {
    const r = ok(validateLegacyRates([{ service_type: 'storage', rate: 1, unit }], CLIENT))
    expect(r.rates[0].unit).toBe(unit)
  })

  // --- the body shape itself -----------------------------------------------

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty array', []],
    ['an object', { rates: [] }],
    ['a string', 'storage'],
  ])('refuses %s as the rates list', (_label, raw) => {
    expect(err(validateLegacyRates(raw, CLIENT))).toMatch(/No rates provided/)
  })

  it.each([
    ['a string', 'storage'],
    ['a number', 7],
    ['null', null],
    ['an array', []],
  ])('refuses %s as a rate row, naming the index', (_label, item) => {
    expect(err(validateLegacyRates([{ service_type: 'storage', rate: 1 }, item], CLIENT)))
      .toMatch(/rates\[1\] is not an object/)
  })

  // --- the two writers that must not reach each other ----------------------

  it.each(['charge_type', 'variant', 'effective_from', 'effective_to', 'id'])(
    'refuses a row carrying %s rather than stripping it', (key) => {
      // Rejected, not stripped. A caller that sent charge_type meant something
      // by it; dropping the field would store a row that does not say what was
      // asked for, and that row would then be silently overwritten the next
      // time the seed in supabase/ is applied -- because the seed's own delete
      // is keyed on `charge_type is not null`, which is what partitions the two
      // writers.
      const e = err(validateLegacyRates(
        [{ service_type: 'storage', rate: 1, [key]: 'x' }], CLIENT))
      expect(e).toMatch(/rates\[0\] carries/)
      expect(e).toMatch(new RegExp(key))
      // The message must say where the structured rows DO come from, or the
      // reader's next move is to retry without the field, which loses the
      // intent entirely.
      expect(e).toMatch(/seed files/)
    })

  it('names every unexpected column, not just the first', () => {
    const e = err(validateLegacyRates(
      [{ service_type: 'storage', rate: 1, charge_type: 'pick', variant: 'device' }],
      CLIENT))
    expect(e).toMatch(/charge_type/)
    expect(e).toMatch(/variant/)
  })

  it('refuses a row naming a different client than the URL', () => {
    // Refused rather than rewritten. One of the two is a different client's
    // rate card, and guessing which picks a client to overwrite.
    const e = err(validateLegacyRates(
      [{ client_id: 'client-bbb', service_type: 'storage', rate: 1 }], CLIENT))
    expect(e).toMatch(/client-bbb/)
    expect(e).toMatch(new RegExp(CLIENT))
    expect(e).toMatch(/Refusing rather than guessing/)
  })

  // --- service_type --------------------------------------------------------

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['a number', 7],
    ['null', null],
  ])('refuses a %s service_type', (_label, service_type) => {
    expect(err(validateLegacyRates([{ service_type, rate: 1 }], CLIENT)))
      .toMatch(/rates\[0\]: service_type is required/)
  })

  it('refuses two rates for the same service', () => {
    // Both rows would be in effect at once, and warehouse-log-rate.ts refuses
    // to price an ambiguous service rather than picking one -- so accepting
    // this upload makes the service unbillable, surfacing weeks later on a
    // daily log instead of now, while the person who typed it is looking at
    // the form.
    const e = err(validateLegacyRates([
      { service_type: 'storage', rate: 1 },
      { service_type: 'storage', rate: 2 },
    ], CLIENT))
    expect(e).toMatch(/'storage' appears more than once/)
    expect(e).toMatch(/unpriceable/)
  })

  it('catches a duplicate that only matches after trimming', () => {
    // The Excel path produces service_type from arbitrary cell text, so a
    // trailing space in one of two otherwise identical rows is the realistic
    // way this arrives. The duplicate check has to run on the trimmed value or
    // it passes the pair straight through.
    expect(err(validateLegacyRates([
      { service_type: 'storage', rate: 1 },
      { service_type: 'storage ', rate: 2 },
    ], CLIENT))).toMatch(/appears more than once/)
  })

  // --- the rate, where a wrong answer is money ------------------------------

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace', '  '],
  ])('refuses %s as a rate instead of storing 0', (_label, rate) => {
    // `Number('')` is 0 and `Number(null)` is 0, so every one of these coerces
    // to a perfectly valid free rate. This check has to run BEFORE the
    // coercion; if it ran after, a blank spreadsheet cell would be stored as a
    // deliberate decision to do the work for nothing.
    const e = err(validateLegacyRates([{ service_type: 'storage', rate }], CLIENT))
    expect(e).toMatch(/rate is empty/)
    expect(e).toMatch(/storage/)
    expect(e).toMatch(/0 means the service is free/)
  })

  it.each([
    ['n/a', 'n/a'],
    ['a dash', '-'],
    ['a currency string', '$2.50'],
    ['NaN itself', NaN],
  ])('refuses %s as a rate', (_label, rate) => {
    // parseFloat('n/a') is NaN and JSON.stringify sends NaN as null, so
    // without this an unreadable cell became a stored NULL rate. That is a
    // legitimate value in the column -- ledger_03_charges.sql drops the NOT
    // NULL so an at_cost line can be expressed -- so nothing downstream would
    // reject it. It would surface as a line nobody can price, with no trace of
    // the cell that caused it.
    const e = err(validateLegacyRates([{ service_type: 'storage', rate }], CLIENT))
    expect(e).toMatch(/is not a number/)
    expect(e).toMatch(/storage/)
  })

  it.each([
    ['true', true, 'boolean'],
    ['false', false, 'boolean'],
    ['an empty array', [], 'array'],
    ['a one-element array', [5], 'array'],
    ['an object', { v: 1 }, 'object'],
  ])('refuses %s as a rate rather than coercing it', (_label, rate, kind) => {
    // The finiteness check alone does NOT catch these: Number(true) is 1,
    // Number(false) and Number([]) are 0, and Number([5]) is 5. Every one of
    // them is a finite, plausible price that nothing downstream could tell
    // apart from a deliberate one -- a rate of $1.00 nobody agreed to, or a
    // service marked free. Only an object coerces to NaN.
    const e = err(validateLegacyRates([{ service_type: 'storage', rate }], CLIENT))
    expect(e).toMatch(/storage/)
    expect(e).toMatch(new RegExp(`is a ${kind}, not a number`))
    expect(e).toMatch(/refused rather than converted/)
  })

  it('refuses Infinity, which JSON cannot carry back out again', () => {
    expect(err(validateLegacyRates(
      [{ service_type: 'storage', rate: Infinity }], CLIENT)))
      .toMatch(/is not a number/)
  })

  // --- units ---------------------------------------------------------------

  it('refuses a unit outside the allowed set, listing the allowed ones', () => {
    const e = err(validateLegacyRates(
      [{ service_type: 'storage', rate: 1, unit: 'per_cubic_metre' }], CLIENT))
    expect(e).toMatch(/per_cubic_metre/)
    for (const u of LEGACY_UNITS) expect(e).toMatch(new RegExp(u))
  })

  // --- warn, rather than refuse or hide ------------------------------------

  it('saves a service no screen can log, and says it will never bill', () => {
    // Three options, and only one neither blocks nor hides. Refusing would
    // block a workflow this code cannot see; storing silently leaves dead
    // weight on a rate card nobody audits. So: saved, and reported.
    const r = ok(validateLegacyRates(
      [{ service_type: 'palletizing', rate: 1 }], CLIENT))
    expect(r.rates).toHaveLength(1)
    expect(r.rates[0].service_type).toBe('palletizing')
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/'palletizing'/)
    expect(r.warnings[0]).toMatch(/nothing will ever bill from it/)
    // And it has to name the services that DO work, or the reader cannot tell
    // what to type instead.
    expect(r.warnings[0]).toMatch(/storage/)
  })

  it('warns once per unknown service and not at all for known ones', () => {
    const r = ok(validateLegacyRates([
      { service_type: 'storage', rate: 1 },
      { service_type: 'palletizing', rate: 2 },
      { service_type: 'shrinkwrap', rate: 3 },
    ], CLIENT))
    expect(r.rates).toHaveLength(3)
    expect(r.warnings).toHaveLength(2)
  })

  it.each(WAREHOUSE_SERVICE_TYPES.map((s) => s.value))(
    'does not warn about %s, which the daily log can record', (service_type) => {
      const r = ok(validateLegacyRates([{ service_type, rate: 1 }], CLIENT))
      expect(r.warnings).toEqual([])
    })
})

describe('LEGACY_UNITS', () => {
  it('names every unit a legacy rate may be expressed in', () => {
    // Asserted as a literal rather than by iterating the constant. The
    // `it.each(LEGACY_UNITS)` test above cannot catch an entry being deleted,
    // because deleting it also deletes the case that would have checked it --
    // and a missing unit is not cosmetic: it is a rate that cannot be entered
    // through the UI at all, which is how labor_hours came to be unbillable.
    expect([...LEGACY_UNITS]).toEqual([
      'per_unit', 'per_order', 'per_pallet', 'per_hour', 'flat', 'per_lb',
    ])
  })

  it('starts with per_unit, which every other default falls back to', () => {
    // Both the uploader's initial row and this module's missing-unit default
    // are the literal 'per_unit'. If it ever left the set, every rate with no
    // unit column would be refused.
    expect(LEGACY_UNITS).toContain('per_unit')
  })
})

describe('WAREHOUSE_SERVICE_TYPES', () => {
  // This list is the fix for a drift that cost money: app/warehouse/page.tsx
  // offered nine services to log and WarehouseRatesUpload.tsx offered eight to
  // price. The missing one was labor_hours, so labour could be logged against
  // a service for which no rate could ever be entered through the UI -- and
  // under the old `rateRow?.rate ?? 0` every hour of it billed at nothing.
  //
  // These assertions exist so that a future edit removing an entry from the
  // shared list fails here rather than on an invoice.

  it('includes labor_hours, the entry whose absence was the defect', () => {
    expect(WAREHOUSE_SERVICE_TYPES.map((s) => s.value)).toContain('labor_hours')
  })

  it('names every service the daily log can record', () => {
    expect(WAREHOUSE_SERVICE_TYPES.map((s) => s.value)).toEqual([
      'storage', 'receiving',
      'receiving_pallet', 'receiving_carton', 'devan_20ft', 'devan_40ft',
      'pallet_in',
      'fba_prep', 'returns', 'labeling', 'kitting', 'pallet_out',
      'labor_hours', 'special_task',
    ])
  })

  it('keeps generic receiving alongside the variants, not replaced by them', () => {
    // The variants were added for the shapes the structured card prices
    // separately. Generic 'receiving' has to survive that edit: existing
    // client_warehouse_rates rows and logged warehouse_daily_log history both
    // name it, so removing it strands those rates and makes history unreadable.
    const values = WAREHOUSE_SERVICE_TYPES.map((s) => s.value)
    expect(values).toContain('receiving')
    expect(values).toContain('receiving_pallet')
  })

  it('does NOT offer pick_pack, which the ledger already bills per order', () => {
    /**
     * The one entry whose ADDITION is the defect, which is why this is an
     * assertion and not a comment.
     *
     * Pick and pack is the headline line on the published DTC card and is named
     * in the original schema comment, so it reads like an obvious omission. It
     * is raised automatically per order by lib/ledger/calculate-charges.ts and
     * counted in lib/billing/statement.ts. A hand-logged pick_pack line would
     * bill work the ledger has already billed -- the client pays twice, and the
     * statement looks internally consistent while doing it.
     */
    expect(WAREHOUSE_SERVICE_TYPES.map((s) => s.value)).not.toContain('pick_pack')
  })

  it('has no duplicate values and a label for each', () => {
    const values = WAREHOUSE_SERVICE_TYPES.map((s) => s.value)
    expect(new Set(values).size).toBe(values.length)
    for (const s of WAREHOUSE_SERVICE_TYPES) expect(s.label.trim()).not.toBe('')
  })

  it('puts every service in a group the form actually renders', () => {
    // The form iterates WAREHOUSE_SERVICE_GROUPS to lay out sections. A service
    // whose group is not in that list would be silently unreachable -- loggable
    // in principle, absent from the screen, which is how labor_hours became
    // unbillable in the first place.
    for (const s of WAREHOUSE_SERVICE_TYPES) {
      expect(
        WAREHOUSE_SERVICE_GROUPS as readonly string[],
        `service '${s.value}' is in group '${s.group}', which the form does not render`,
      ).toContain(s.group)
    }
  })
})

describe('composeServiceNotes', () => {
  it('keeps typed text when no step is ticked', () => {
    expect(composeServiceNotes([], 'rush order')).toBe('rush order')
  })

  it('joins ticked steps when nothing was typed', () => {
    expect(composeServiceNotes(['FNSKU label', 'Poly bag'], ''))
      .toBe('FNSKU label, Poly bag')
  })

  it('keeps BOTH, because the typed note is the part nothing else records', () => {
    // The requirement that matters. A composer preferring the checkboxes would
    // discard the only free-form thing on the row.
    expect(composeServiceNotes(['Inspection'], 'two cartons damaged'))
      .toBe('Inspection — two cartons damaged')
  })

  it('is empty when there is nothing to say', () => {
    expect(composeServiceNotes([], '   ')).toBe('')
  })

  it('ignores blank steps rather than emitting stray separators', () => {
    expect(composeServiceNotes(['', '  ', 'Bundle'], '')).toBe('Bundle')
  })
})

describe('overlapWarning', () => {
  it('warns when FBA prep and kitting are logged together', () => {
    const w = overlapWarning(['fba_prep', 'kitting'])
    expect(w).not.toBeNull()
    expect(w).toMatch(/billed for it twice/)
  })

  it('stays silent for either one alone', () => {
    // The warning has to be specific to the PAIR. Firing on FBA prep by itself
    // would train the operator to dismiss it, at which point it stops working
    // for the case it exists for.
    expect(overlapWarning(['fba_prep'])).toBeNull()
    expect(overlapWarning(['kitting'])).toBeNull()
  })

  it('stays silent for an empty day', () => {
    expect(overlapWarning([])).toBeNull()
  })

  it('names the blended rate as the reason, not just the collision', () => {
    // The operator has to be able to decide whether this instance is legitimate
    // -- kitting on non-FBA stock the same day is -- so the text must say WHY
    // the pair is suspect, not merely that it was detected.
    expect(overlapWarning(['kitting', 'fba_prep'])).toMatch(/blended FBA prep rate/)
  })
})

// The edit form seeds itself from the stored card, because the endpoint it
// posts to REPLACES that card. These three functions are what make "what is on
// screen" and "what the client ends up with" the same set.
describe('toEditableRates', () => {
  it('returns the stored legacy card as form rows', () => {
    expect(toEditableRates([
      { service_type: 'storage', rate: 25, unit: 'per_pallet' },
    ])).toEqual([{ service_type: 'storage', rate: '25', unit: 'per_pallet' }])
  })

  it('drops structured charge_type rows', () => {
    /**
     * The seed files own charge_type lines and validateLegacyRates rejects a
     * body carrying the column. Seeding one into the form would therefore
     * either fail the whole save, or -- if the field were stripped on the way
     * out -- re-insert a seed line as a legacy duplicate, which is exactly the
     * ambiguity warehouse-log-rate.ts then refuses to price.
     */
    expect(toEditableRates([
      { service_type: 'storage', rate: 25, unit: 'per_pallet' },
      { service_type: null, rate: 20, unit: 'per_pallet', charge_type: 'receiving' },
    ])).toEqual([{ service_type: 'storage', rate: '25', unit: 'per_pallet' }])
  })

  it('drops a structured row that ALSO carries a service_type', () => {
    /**
     * The row shape the charge_type filter actually exists for, and the one
     * the test above does NOT reach: with service_type null, the
     * "service_type is a non-blank string" filter already drops the row, so
     * deleting the charge_type filter entirely leaves that test green. A
     * mutation check caught exactly that.
     *
     * Both columns set is reachable. `service_type` was `not null` with four
     * permitted values before ledger_03 dropped the constraint
     * (supabase/ledger_03_charges.sql:486-501), nothing added a CHECK tying
     * the two columns together, and the exclusion constraint keyed
     * `charge_type with =` does not care what service_type holds.
     *
     * If such a row round-tripped: validateLegacyRates' ALLOWED set has no
     * charge_type, so the field is stripped on the way out and the row is
     * re-inserted as a LEGACY line -- while the route's delete, keyed
     * `.is('charge_type', null)`, cannot reach the structured original. The
     * result is two live rows naming one service, which is precisely what
     * priceServiceLine refuses to price. One silent edit turns a priced
     * service into an unbillable one.
     */
    expect(toEditableRates([
      { service_type: 'receiving', rate: 20, unit: 'per_pallet', charge_type: 'receiving' },
    ])).toEqual([])
  })

  it('preloads a NULL rate as blank, never as 0', () => {
    // null is UNKNOWN, 0 is a price. Seeding '0' would turn "nobody has
    // priced this" into "this service is free" for anyone who saved without
    // reading the row.
    expect(toEditableRates([
      { service_type: 'returns', rate: null, unit: 'per_unit' },
    ])[0].rate).toBe('')
  })

  it('reads a numeric rate that arrives as a string', () => {
    // numeric(10,2) comes back over PostgREST as either.
    expect(toEditableRates([
      { service_type: 'storage', rate: '25.00', unit: 'per_pallet' },
    ])[0].rate).toBe('25.00')
  })

  it('defaults a missing unit to per_unit', () => {
    expect(toEditableRates([{ service_type: 'returns', rate: 1 }])[0].unit)
      .toBe('per_unit')
  })

  it('drops a row with no service_type', () => {
    expect(toEditableRates([{ service_type: '  ', rate: 1 }])).toEqual([])
  })

  it('orders by service_type so the form is stable between opens', () => {
    expect(toEditableRates([
      { service_type: 'storage', rate: 1 },
      { service_type: 'fba_prep', rate: 2 },
    ]).map((r) => r.service_type)).toEqual(['fba_prep', 'storage'])
  })
})

describe('ratesToSubmit', () => {
  it('keeps a filled row', () => {
    expect(ratesToSubmit([{ service_type: 'storage', rate: '25', unit: 'per_pallet' }]))
      .toHaveLength(1)
  })

  it('drops a blank row', () => {
    expect(ratesToSubmit([{ service_type: 'storage', rate: '', unit: 'per_pallet' }]))
      .toEqual([])
  })

  it('drops a row typed as 0', () => {
    // Pins PRE-EXISTING behaviour rather than endorsing it: a deliberate "this
    // service is free" cannot be saved from this form. Asserted so that
    // changing it is a deliberate act with a failing test attached, and so
    // droppedServices and the submit agree about it in the meantime.
    expect(ratesToSubmit([{ service_type: 'storage', rate: '0', unit: 'per_pallet' }]))
      .toEqual([])
  })
})

describe('droppedServices', () => {
  it('names every service the save would delete -- the bug this prevents', () => {
    /**
     * The exact shape of the defect. The form used to open on one blank row
     * no matter what the client already had, so an operator adding ONE new
     * service was submitting a one-line card -- and the endpoint replaces.
     * Storage, receiving and labour were deleted, silently, by a button
     * labelled "Add".
     */
    const stored = [
      { service_type: 'storage', rate: 25, unit: 'per_pallet' },
      { service_type: 'receiving', rate: 14, unit: 'per_pallet' },
      { service_type: 'labor_hours', rate: 45, unit: 'per_hour' },
    ]
    const edited = [{ service_type: 'fba_prep', rate: '1.25', unit: 'per_unit' }]
    expect(droppedServices(stored, edited))
      .toEqual(['labor_hours', 'receiving', 'storage'])
  })

  it('names a service left on screen but blank', () => {
    // Still on the form, so it LOOKS kept -- but the submit filter skips it,
    // which is precisely the case a reader of the form would miss.
    expect(droppedServices(
      [{ service_type: 'storage', rate: 25, unit: 'per_pallet' }],
      [{ service_type: 'storage', rate: '', unit: 'per_pallet' }],
    )).toEqual(['storage'])
  })

  it('is silent when every stored service is kept', () => {
    expect(droppedServices(
      [{ service_type: 'storage', rate: 25, unit: 'per_pallet' }],
      [
        { service_type: 'storage', rate: '25', unit: 'per_pallet' },
        { service_type: 'fba_prep', rate: '1.25', unit: 'per_unit' },
      ],
    )).toEqual([])
  })

  it('does not report a newly added service as a drop', () => {
    expect(droppedServices([], [
      { service_type: 'fba_prep', rate: '1.25', unit: 'per_unit' },
    ])).toEqual([])
  })

  it('never warns about structured rows, which this endpoint cannot touch', () => {
    /**
     * The route's delete is scoped `is('charge_type', null)`, so a seed line
     * is not at risk and naming it would be a false alarm. A warning that
     * cries wolf is worse than none: it trains the operator to click past the
     * one that is real.
     */
    expect(droppedServices(
      [{ service_type: null, rate: 20, unit: 'per_pallet', charge_type: 'receiving' }],
      [{ service_type: 'fba_prep', rate: '1.25', unit: 'per_unit' }],
    )).toEqual([])
  })

  it('picks the first service not already on the form', () => {
    expect(nextUnusedService([])).toBe(WAREHOUSE_SERVICE_TYPES[0].value)
    expect(nextUnusedService([WAREHOUSE_SERVICE_TYPES[0].value]))
      .toBe(WAREHOUSE_SERVICE_TYPES[1].value)
  })

  it('falls back to the first service when the card is complete', () => {
    // Every service taken. A duplicate is returned deliberately -- the
    // duplicate check then names it, which beats an empty or unloggable value.
    expect(nextUnusedService(WAREHOUSE_SERVICE_TYPES.map((s) => s.value)))
      .toBe(WAREHOUSE_SERVICE_TYPES[0].value)
  })

  it('names a dropped service once even if stored twice', () => {
    expect(droppedServices(
      [
        { service_type: 'storage', rate: 25, unit: 'per_pallet' },
        { service_type: 'storage', rate: 30, unit: 'per_pallet' },
      ],
      [],
    )).toEqual(['storage'])
  })
})
