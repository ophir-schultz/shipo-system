// Where a partner's DocuSign signing session gets put.
//
// W9Prompt used to do `window.location.href = json.url`, which works and
// costs him the statement. He is signing a tax form so that figures he is
// currently looking at will appear; sending his only tab to DocuSign means
// the screen that explains why he is signing is gone while he decides
// whether to hand over a taxpayer identification number, and he comes back
// only if DocuSign's returnUrl fires — which it does not when he abandons
// the envelope by closing it.
//
// THE POPUP IS THE EASY HALF. The hard half is that a popup opened AFTER an
// await is not user-initiated, so Safari and hardened Chrome return null
// from window.open and the button appears to do nothing at all. So the
// caller opens a blank window SYNCHRONOUSLY inside the click handler and
// this module settles it once the URL arrives. Every outcome below is a
// state the partner can reach and none can be produced on purpose in a
// browser:
//
//   popup opened, URL arrived       hand it over, and FOCUS it
//   popup blocked (null)            navigate this tab — the old behaviour
//   popup closed mid-flight         navigate this tab, write nothing
//   request failed                  CLOSE the blank window (abandon-)
//   URL is not https                refuse, and close
//
// WHY THE SCHEME CHECK IS NOT PARANOIA. The window we opened is
// about:blank, which is SAME-ORIGIN with the portal. Assigning a
// `javascript:` URL to a same-origin window executes that script in our
// origin, holding the partner's session. The URL is read off a JSON
// response; our own route forwarding it is not the same as our having
// written it, and a scheme test is one line.

/**
 * The slice of `Window` this module touches. Narrow on purpose: it keeps
 * the tests honest (a real Window cannot be told it was blocked) and makes
 * the surface auditable — nothing here can navigate anything but the one
 * window the click opened.
 */
export interface SigningWindowHandle {
  readonly closed: boolean
  readonly location: { href: string }
  focus?: () => void
  close: () => void
}

export interface SigningWindowDeps {
  /** Sends the CURRENT tab to the URL. The fallback, not the default. */
  navigateSelf: (url: string) => void
}

export type SigningDelivery = 'popup' | 'same-tab' | 'refused'

/**
 * Only https, only absolute.
 *
 * `new URL` and not a regex: the parser is the thing that decides what a
 * browser will treat this string as, and a regex over a URL is a second,
 * worse parser that disagrees at the edges. A relative path throws here,
 * which is correct — a signing URL is always absolute, and a relative one
 * would navigate inside the portal.
 */
function isSigningUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Put `url` in front of the partner, and say where it went.
 *
 * `handle` is whatever the click handler's synchronous window.open
 * returned — null when it was blocked.
 */
export function settleSigningWindow(
  handle: SigningWindowHandle | null,
  url: string,
  deps: SigningWindowDeps,
): SigningDelivery {
  // Scheme first, ahead of every other branch. A bad URL must not reach
  // the popup OR this tab, and ordering it after the blocked-popup check
  // would navigate the tab to it.
  if (!isSigningUrl(url)) {
    abandonSigningWindow(handle)
    return 'refused'
  }

  // `closed` as well as null: he can close the blank popup while the
  // request is in flight, and writing a location into a closed window is
  // silently dropped — the one failure that leaves him with no signing
  // session and no error either.
  if (!handle || handle.closed) {
    deps.navigateSelf(url)
    return 'same-tab'
  }

  handle.location.href = url
  // Chrome and Firefox can open the popup BEHIND the window that spawned
  // it. Unfocused, this is indistinguishable from the button having done
  // nothing, and he clicks it again.
  handle.focus?.()
  return 'popup'
}

/**
 * Close a blank popup that is never going to be used.
 *
 * Called when the request failed, so the partner is not left reading an
 * error message next to an empty window — of the two, the empty window is
 * the one he will believe.
 */
export function abandonSigningWindow(handle: SigningWindowHandle | null): void {
  // `closed` guard because close() on an already-closed window is a no-op
  // in browsers but a second call in the tests, and "we closed it twice"
  // and "we closed it once" are different facts about this code.
  if (handle && !handle.closed) handle.close()
}
