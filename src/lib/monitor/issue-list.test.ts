// What the dashboard is allowed to say about what the monitor found.

import { describe, expect, it } from 'vitest'
import { summariseMonitorIssues } from './issue-list'

describe('summariseMonitorIssues', () => {
  it('keeps the monitor order rather than imposing its own', () => {
    // The route emits worst-first. Sorting here would override a judgement
    // made with more context than this function has.
    const s = summariseMonitorIssues(['31 shipments have no rate match', '7x no legacy card', '1x no cell for 695 LB'])
    expect(s.items).toEqual(['31 shipments have no rate match', '7x no legacy card', '1x no cell for 695 LB'])
    expect(s.count).toBe(3)
  })

  it('drops an exact repeat without dropping a similar finding', () => {
    // Two findings that differ only in the weight are two real gaps and two
    // separate cells to add. Only a byte-identical repeat is noise.
    const s = summariseMonitorIssues([
      '1x no cell for 105 LB / zone 4',
      '1x no cell for 105 LB / zone 4',
      '1x no cell for 119 LB / zone 4',
    ])
    expect(s.count).toBe(2)
    expect(s.items).toEqual(['1x no cell for 105 LB / zone 4', '1x no cell for 119 LB / zone 4'])
  })

  it('drops blanks, which are bullets nobody can act on', () => {
    expect(summariseMonitorIssues(['real finding', '', '   ']).items).toEqual(['real finding'])
  })

  it('trims, so whitespace does not make one finding look like two', () => {
    expect(summariseMonitorIssues(['  same  ', 'same']).count).toBe(1)
  })

  it('says "1 issue", not "1 issues"', () => {
    // A money screen whose own alerting reads like an unfinished template
    // invites the reader to discount the number next to it.
    expect(summariseMonitorIssues(['one']).label).toBe('1 issue')
    expect(summariseMonitorIssues(['one', 'two']).label).toBe('2 issues')
  })

  it('is empty, with an empty label, when there is nothing to report', () => {
    // The widget renders nothing on this -- a clean pass must not leave a
    // button on screen implying there is something to open.
    const s = summariseMonitorIssues([])
    expect(s.count).toBe(0)
    expect(s.label).toBe('')
    expect(s.items).toEqual([])
  })

  it('survives a body that is not a list of strings at all', () => {
    // The shape comes off the wire. An older deployment, or a 500 body, must
    // degrade to "nothing to show" rather than throwing inside a poll that
    // runs every five minutes for the life of the page.
    expect(summariseMonitorIssues(undefined).count).toBe(0)
    expect(summariseMonitorIssues(null).count).toBe(0)
    expect(summariseMonitorIssues('not a list').count).toBe(0)
    expect(summariseMonitorIssues([1, 2, { a: 1 }, null]).count).toBe(0)
    expect(summariseMonitorIssues(['kept', 7, null]).items).toEqual(['kept'])
  })
})
