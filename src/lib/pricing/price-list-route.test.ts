// The price-list upload inserts. It must not delete an earlier list, and
// it must not be reachable without the staff session. The route is a
// Next handler, so this checks the source the same way the paging guards do.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(
  join(__dirname, '../../app/api/clients/[id]/price-lists/route.ts'),
  'utf8',
)

describe('price list upload route', () => {
  it('requires a staff session and only inserts', () => {
    expect(SRC).toContain('requireStaff()')
    expect(SRC).toContain(".insert(")
    expect(SRC).not.toContain('.delete(')
    expect(SRC).not.toContain('.update(')
    expect(SRC).not.toMatch(/nodemailer|sendMail|resend/i)
  })
})
