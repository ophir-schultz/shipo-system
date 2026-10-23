import { describe, expect, it, vi } from 'vitest'
import { abandonSigningWindow, settleSigningWindow } from './partner-signing-window'

/**
 * Where a partner's DocuSign signing session is put once the route hands
 * back a URL.
 *
 * THE WHOLE REASON THIS IS A PURE FUNCTION is that every branch here is a
 * state the partner can reach and none of them can be produced by clicking
 * the button in a browser on purpose. A blocked popup, a popup he closed
 * while the request was in flight, and a request that failed after the
 * popup opened are three different screens, and two of them end with him
 * looking at a blank window wondering whether he has signed anything.
 */

/**
 * Declared standalone rather than as `SigningWindowHandle & {...}`: the
 * handle's `closed` is readonly, which is right for the production type and
 * wrong for a fake that has to simulate the partner closing the window. A
 * mutable `closed` still satisfies a readonly one structurally, so this is
 * accepted everywhere the real handle is.
 */
interface FakeWindow {
  closed: boolean
  href: string
  focused: number
  closes: number
  readonly location: { href: string }
  focus: () => void
  close: () => void
}

function fakeWindow(): FakeWindow {
  return {
    closed: false,
    href: 'about:blank',
    focused: 0,
    closes: 0,
    get location() {
      const self = this
      return {
        get href() {
          return self.href
        },
        set href(v: string) {
          self.href = v
        },
      }
    },
    focus() {
      this.focused++
    },
    close() {
      this.closes++
      this.closed = true
    },
  }
}

const URL_OK = 'https://demo.docusign.net/Signing/MTRedeem/v1/abc-123'

describe('settleSigningWindow', () => {
  it('hands the URL to the popup that was opened on the click', () => {
    const win = fakeWindow()
    const navigateSelf = vi.fn()

    const result = settleSigningWindow(win, URL_OK, { navigateSelf })

    expect(result).toBe('popup')
    expect(win.href).toBe(URL_OK)
    expect(navigateSelf).not.toHaveBeenCalled()
  })

  it('focuses the popup, because it opens behind the statement on some browsers', () => {
    const win = fakeWindow()

    settleSigningWindow(win, URL_OK, { navigateSelf: vi.fn() })

    expect(win.focused).toBe(1)
  })

  // The case that makes the popup worth doing carefully rather than at all.
  // window.open() after an await is not user-initiated, so Safari and
  // hardened Chrome return null. Without this branch the button would look
  // to the partner like it does nothing whatsoever.
  it('navigates this tab instead when the popup was blocked', () => {
    const navigateSelf = vi.fn()

    const result = settleSigningWindow(null, URL_OK, { navigateSelf })

    expect(result).toBe('same-tab')
    expect(navigateSelf).toHaveBeenCalledWith(URL_OK)
  })

  it('navigates this tab when he closed the popup while the request was in flight', () => {
    const win = fakeWindow()
    win.closed = true
    const navigateSelf = vi.fn()

    const result = settleSigningWindow(win, URL_OK, { navigateSelf })

    expect(result).toBe('same-tab')
    expect(navigateSelf).toHaveBeenCalledWith(URL_OK)
    // Not written into a window nobody is looking at.
    expect(win.href).toBe('about:blank')
  })

  // The popup we opened is same-origin about:blank, so assigning a
  // `javascript:` URL to it would EXECUTE IN OUR ORIGIN, with the partner's
  // session cookie. The URL arrives over the wire; it is not ours to trust
  // just because our own route forwarded it.
  it('refuses a javascript: URL rather than handing it to a same-origin window', () => {
    const win = fakeWindow()
    const navigateSelf = vi.fn()

    const result = settleSigningWindow(win, 'javascript:fetch("/api/partner/report")', { navigateSelf })

    expect(result).toBe('refused')
    expect(win.href).toBe('about:blank')
    expect(navigateSelf).not.toHaveBeenCalled()
    // And it does not leave a blank window sitting open.
    expect(win.closes).toBe(1)
  })

  it.each(['http://demo.docusign.net/x', 'data:text/html,<script>1</script>', '/relative', ''])(
    'refuses %j',
    (bad) => {
      const win = fakeWindow()
      const navigateSelf = vi.fn()

      expect(settleSigningWindow(win, bad, { navigateSelf })).toBe('refused')
      expect(navigateSelf).not.toHaveBeenCalled()
    },
  )

  // Control: the refusals above must not be refusing everything. If this
  // ever fails alongside them, the predicate is simply off.
  it('accepts a plain https URL (control)', () => {
    expect(settleSigningWindow(fakeWindow(), URL_OK, { navigateSelf: vi.fn() })).toBe('popup')
  })
})

describe('abandonSigningWindow', () => {
  // Without this the partner gets an error message AND a blank popup, and
  // the blank popup is the one he will believe.
  it('closes the blank popup when the request failed', () => {
    const win = fakeWindow()

    abandonSigningWindow(win)

    expect(win.closes).toBe(1)
  })

  it('does nothing when the popup was blocked in the first place', () => {
    expect(() => abandonSigningWindow(null)).not.toThrow()
  })

  it('does not call close twice on a window he already closed', () => {
    const win = fakeWindow()
    win.closed = true

    abandonSigningWindow(win)

    expect(win.closes).toBe(0)
  })
})
