import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================
// One prop, on one line, that tsc cannot pin.
//
// WarehouseRatesUpload takes `existingRates: StoredRate[] | null`, where null
// means "the read FAILED" and [] means "this client genuinely has no legacy
// rates". The component seeds its editor from that prop, and POST
// /api/clients/[id]/warehouse-rates REPLACES the legacy card with exactly what
// the editor submits. So the two values have opposite consequences:
//
//   null  -> the editor refuses to open. Nothing is written.
//   []    -> the editor opens on one blank row and a save writes a one-line
//            card over whatever the client actually had.
//
// `read()` returns `{ rows, error }` and sets `rows: []` on failure, which is
// why `lib/db/read.ts` exists at all -- its header says the collapsed form
// "instructs you to destroy data". The call site therefore has to branch on
// `error`, not just hand over `rows`.
//
// WHY A TEST AND NOT JUST THE CODE.
//
// `warehouseRates.rows` is `StoredRate[]`, which is assignable to
// `StoredRate[] | null`. Deleting the `error ? null :` guard typechecks
// cleanly, passes every other test in the suite, builds, and renders
// identically -- right up until a client's rate card happens to be unreadable
// on the day someone opens the editor. There is nothing else in the repo that
// would notice. tsc checks that a value of the right TYPE arrives; only this
// file checks that the right VALUE does.
//
// This cannot be a component test: vitest.config.ts includes only
// `src/**/*.test.ts`, so a .tsx cannot be rendered here. Asserting on the
// source text is the available instrument, and the thing asserted -- the
// presence of the branch -- is exactly the thing that fails silently.
// ============================================================

const ROOT = join(__dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('existingRates is passed as error ? null : rows', () => {
  const page = read('src/app/clients/[id]/page.tsx')

  it('passes null when the read failed, rows when it did not', () => {
    // Whitespace-insensitive, because the line is long enough that a
    // formatter will wrap it differently than it is written today, and this
    // test should fail for a changed MEANING -- not for a changed line break.
    const normalised = page.replace(/\s+/g, ' ')
    expect(normalised).toContain(
      'existingRates={warehouseRates.error ? null : warehouseRates.rows}',
    )
  })

  it('never hands over rows unguarded', () => {
    /**
     * The mutation this kills. `existingRates={warehouseRates.rows}` is the
     * shorter, more obvious thing to write, it typechecks, and it is the
     * precise defect read.ts was built to prevent. Spelled out as its own
     * assertion so the failure message names the mistake rather than just
     * reporting that a long string is absent.
     */
    const normalised = page.replace(/\s+/g, ' ')
    expect(normalised).not.toContain('existingRates={warehouseRates.rows}')
  })

  it('the component still treats null as the refusing case', () => {
    /**
     * The other half of the contract. If the component stopped refusing on
     * null, the branch above would be pointless -- correct input routed into
     * code that ignores it. Two assertions because the guard has to hold in
     * BOTH places: the editor refuses to seed, and the buttons are disabled.
     *
     * Checked as text for the same reason as above: a .tsx cannot be rendered
     * under this config, and the behaviour lives in JSX.
     */
    const component = read('src/components/billing/WarehouseRatesUpload.tsx')
      .replace(/\s+/g, ' ')
    expect(component).toContain('if (existingRates === null) return')
    expect(component).toContain('const unreadable = existingRates === null')
    // Both entry points into a destructive save are closed, not just one.
    // The Excel path replaces the card too.
    expect(component.match(/disabled=\{xlsxLoading \|\| unreadable\}/)).not.toBeNull()
    expect(component.match(/onClick=\{openEditor\} disabled=\{unreadable\}/)).not.toBeNull()
  })
})
