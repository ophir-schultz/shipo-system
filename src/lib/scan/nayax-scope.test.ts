import { describe, expect, it } from 'vitest'
import { queuedOutsideNayax, serializationClientAllowed } from './nayax-scope'

describe('serialization is Nayax only', () => {
  it('allows Nayax and refuses other names', () => {
    expect(serializationClientAllowed('Nayax')).toBe(true)
    expect(serializationClientAllowed(' nayax ')).toBe(true)
    expect(serializationClientAllowed('Creative Pea')).toBe(false)
    expect(serializationClientAllowed('Orcam')).toBe(false)
    expect(serializationClientAllowed('')).toBe(false)
    expect(serializationClientAllowed(null)).toBe(false)
  })

  it('blocks a queued job whose client is not Nayax, including an unknown id', () => {
    const names = new Map<string, string | null>([
      ['nayax', 'Nayax'],
      ['pea', 'Creative Pea'],
    ])
    expect(queuedOutsideNayax([
      { id: 'keep', clientId: 'nayax', status: 'pending' },
      { id: 'pea', clientId: 'pea', status: 'failed' },
      { id: 'gone', clientId: 'missing', status: 'pending' },
      { id: 'done', clientId: 'pea', status: 'done' },
    ], names)).toEqual(['pea', 'gone'])
  })
})
