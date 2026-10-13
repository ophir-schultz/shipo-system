import { describe, it, expect } from 'vitest'
import { describeBlankLabel } from '@/lib/sync/label-identity'

// What this function is FOR, because the assertions below are about wording and
// that normally means they are worth nothing.
//
// A ShipStation label with a blank orderNumber cannot be matched to a Zenventory
// order, so the sync never gives it a client and never bills it. The monitor
// alerted on the count of those and told the operator the revenue was
// "unrecoverable until someone identifies them by hand in ShipStation".
//
// Measured 2026-10-13, every such row in the table -- 9 of them, all at store
// 202015 -- carried BOTH a ShipStation orderId and a shipTo.name, and seven of
// the names read "SHIPO LLC - SITNSTAND (RET-2026-118)" or "SHIPO LLC - SUTEKA
// (#S7143)". The client was written on the label. So the identification the
// alert sent someone away to do by hand was already in the payload, and the
// alert was spending attention on a lookup it could have performed.
//
// Hence a string rather than a boolean or a count: the whole value of this
// function is the CONTENT it carries into the email.

describe('describeBlankLabel: the handles a blank-order-number label still has', () => {
  it('names the ShipStation orderId and the recipient', () => {
    const d = describeBlankLabel(
      { orderId: 561469848, shipTo: { name: 'SHIPO LLC - SUTEKA (#S7143)' } },
      9001,
    )

    // Asserted as three separate contains rather than one whole-string equality.
    // The exact punctuation between the parts is presentation and will change;
    // that all three facts SURVIVE into the message is the contract, and a
    // whole-string assertion would fail on a comma while passing on a dropped
    // orderId.
    expect(d).toContain('9001')
    expect(d).toContain('561469848')
    expect(d).toContain('SHIPO LLC - SUTEKA (#S7143)')
  })

  it('falls back to the recipient company when the name is absent', () => {
    // Not hypothetical padding: on the measured rows shipTo carried both, and a
    // label with a company and no name would otherwise be reported as having no
    // recipient while its identity sat one key away.
    const d = describeBlankLabel(
      { orderId: '42', shipTo: { company: 'SITNSTAND' } },
      9002,
    )

    expect(d).toContain('SITNSTAND')
    expect(d).not.toContain('no recipient')
  })

  it('prefers the name over the company when both are present', () => {
    // The measured data is exactly this shape -- company 'SHIPO LLC' on every
    // row, which identifies nobody, and the client's name inside shipTo.name.
    // Preferring company would turn nine distinguishable labels into nine
    // identical ones.
    const d = describeBlankLabel(
      { orderId: '42', shipTo: { name: 'SHIPO LLC - SUTEKA (#S7143)', company: 'SHIPO LLC' } },
      9003,
    )

    expect(d).toContain('SUTEKA')
  })

  it('says there is no recipient rather than inventing one', () => {
    const d = describeBlankLabel({ orderId: '42' }, 9004)

    expect(d).toContain('9004')
    expect(d).toContain('42')
    expect(d).toContain('no recipient')
  })

  it('says there is no orderId rather than quietly omitting the fact', () => {
    // The difference that matters to whoever reads the email: with an orderId
    // the label can be looked up in ShipStation, without one it cannot. A
    // message that simply left the orderId out would read as the first case.
    const d = describeBlankLabel({ shipTo: { name: 'A Person' } }, 9005)

    expect(d).toContain('9005')
    expect(d).toContain('A Person')
    expect(d).toMatch(/no .*orderId/i)
  })

  it('still identifies the shipment when the payload carries nothing at all', () => {
    // shipmentId comes from the caller, which has already guarded it as a
    // positive integer, so there is always something addressable to print. A
    // null return here would have made the array of descriptions shorter than
    // the count beside it, and two numbers that disagree in an alert get read as
    // a bug in the alert.
    const d = describeBlankLabel({}, 9006)

    expect(d).toContain('9006')
    expect(d).toContain('no recipient')
  })

  it('does not throw on a payload that is not an object', () => {
    // Same defensive shape as storeIdOf: this reads an external API's JSON, and
    // a throw here would abort a sync pass over a cosmetic field.
    for (const bad of [null, undefined, 'a string', 42, []]) {
      expect(() => describeBlankLabel(bad, 9007)).not.toThrow()
      expect(describeBlankLabel(bad, 9007)).toContain('9007')
    }
  })

  it('treats a whitespace-only recipient name as no name', () => {
    const d = describeBlankLabel({ shipTo: { name: '   ' } }, 9008)

    expect(d).toContain('no recipient')
  })

  it('falls through to the company when the name is BLANK, not merely absent', () => {
    // Added because a mutation survived. Making stringText return '' instead of
    // null passed every other test in this file: '' is falsy, so the final
    // `recipient ? ... : 'no recipient name'` still printed the right thing for
    // a blank name with no company.
    //
    // It is observable in exactly this combination, because `??` does not fall
    // through on '' the way `||` would -- so a label with a whitespace name and
    // a real company would report "no recipient name" while its identity sat in
    // the next key. Not hypothetical: `company` was populated on every one of
    // the nine measured rows.
    const d = describeBlankLabel(
      { shipTo: { name: '   ', company: 'SITNSTAND' } }, 9013)

    expect(d).toContain('SITNSTAND')
    expect(d).not.toContain('no recipient')
  })

  it('accepts a numeric orderId, which is the shape ShipStation actually sends', () => {
    // The measured payload had orderId: 561423093 as a JSON number. A
    // string-only guard would have reported "no orderId" on every real row --
    // the failure would have looked like ShipStation omitting the field.
    const d = describeBlankLabel({ orderId: 561423093 }, 9009)

    expect(d).toContain('561423093')
    expect(d).not.toMatch(/no .*orderId/i)
  })

  it('refuses an orderId that is not a usable value', () => {
    // NaN, Infinity and a nested object all stringify into something that looks
    // like an identifier in an email and is not one. 'NaN' pasted into
    // ShipStation finds nothing, and the operator blames ShipStation.
    for (const bad of [NaN, Infinity, {}, [], true, '', '   ']) {
      expect(describeBlankLabel({ orderId: bad }, 9010)).toMatch(/no .*orderId/i)
    }
  })

  it('refuses a recipient name that is not a string', () => {
    // '[object Object]' is a worse answer than "no recipient name", because it
    // is not obviously wrong -- it reads as a real, if strange, recipient.
    const d = describeBlankLabel({ shipTo: { name: { first: 'A' } } }, 9011)

    expect(d).not.toContain('object')
    expect(d).toContain('no recipient')
  })

  it('reads a shipTo that is null without treating it as a recipient', () => {
    expect(describeBlankLabel({ shipTo: null }, 9012)).toContain('no recipient')
  })
})
