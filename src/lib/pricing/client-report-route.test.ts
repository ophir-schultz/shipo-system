import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const download = readFileSync(
  join(__dirname, '../../app/api/client-reports/download/route.ts'),
  'utf8',
)
const imported = readFileSync(
  join(__dirname, '../../app/api/client-reports/import/route.ts'),
  'utf8',
)

describe('client report routes stay inside the building', () => {
  it('requires staff and does not email or delete', () => {
    for (const src of [download, imported]) {
      expect(src).toContain('requireStaff()')
      expect(src).not.toMatch(/nodemailer|sendMail|resend|mailto:/i)
      expect(src).not.toContain('.delete(')
    }
    expect(imported).toContain('.insert(')
  })
})
