import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) files(path, out)
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) out.push(path)
  }
  return out
}

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

describe('ship day consumers', () => {
  it('does not print a ship instant without the source-day helper', () => {
    const hits: string[] = []
    for (const path of files('src')) {
      const code = codeOnly(readFileSync(path, 'utf8'))
      if (/easternCalendarDay\([^)]*ship_?[Dd]ate/.test(code)) hits.push(path)
    }
    expect(hits).toEqual([])
  })
})
