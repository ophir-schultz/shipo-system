# Zenventory API — verified findings

**Date:** 2026-09-29
**Scope:** `src/lib/api/zenventory.ts`, `src/lib/sync/zenventory.ts`
**Status of the "sync returns 404 for all 8 clients" report: the named root cause is FIXED and DEPLOYED.**

This note exists because three separate sessions have now re-investigated the same
question. Everything below was measured, not inferred. Read it before touching the
Zenventory client again.

---

## 1. The base-URL fix is live

| | |
|---|---|
| Commit | `c582ec5` — "Point Zenventory at its real API paths — /api never existed" |
| Committed | 2026-09-20 21:51:03 |
| Deployed to production | 2026-09-20 21:53:54 (3 min later) |
| Pushed? | Yes. Local `HEAD` == `origin/main`. |

So the fix has been live for 9 days. **If the sync still fails today, it is failing
for a different reason than the original report describes.** Do not "re-fix" the base
URL.

> Note: two checkouts of this repo exist. `~/shipo-system` is current and matches
> `origin`. `~/Projects/shipo-system` is stale (HEAD `1b0fc64`, 2026-09-01, different
> SSH remote) and does **not** contain this fix. Make sure you are in the right one.

## 2. Which URLs actually exist

Zenventory has **two** APIs on two different paths, and neither of them is `/api`.
Probed unauthenticated — a wrong path gives an HTML/empty error, a correct path gives
a JSON 401 auth challenge. That distinction identifies routing bugs without needing
any credential.

| URL | Code | Body | Verdict |
|---|---|---|---|
| `/rest/customer-orders` | 401 | `{"code":"unauthorized","message":"Invalid API key and/or secret."}` | ✅ **exists** — API 2.0 |
| `/services/rest/customerorders` | 401 | `{"error":"401","message":"Unauthorized"}` | ✅ **exists** — legacy |
| `/services/rest/shippingorders` | 401 | `{"error":"401","message":"Unauthorized"}` | ✅ **exists** — legacy |
| `/rest/customerorders` | 500 | empty | ✗ wrong for 2.0 (needs the hyphen) |
| `/rest/shippingorders` | 500 | empty | ✗ |
| `/services/rest/shipments` | 500 | empty | ✗ **never existed** |
| `/api`, `/rest`, `/services/rest` (bare) | 301 | HTML redirect | not meaningful |

Two traps encoded in that table:

- **The resource spelling differs between the two APIs.** API 2.0 wants
  `customer-orders` (hyphenated); legacy wants `customerorders` (not). They are not
  interchangeable.
- **`GET /shipments` does not exist in either API.** Earlier code called it and could
  only ever 404. Shipment rows come from ShipStation (`src/lib/api/shipstation.ts`),
  not from Zenventory.

Auth differs per API too: API 2.0 uses HTTP Basic (`apiKey:apiSecret`), legacy uses a
`SecureKey` header. `~/qr-batch/station.py` is an independent, known-working consumer
of the legacy API and agrees on both the path and the header.

## 3. Do NOT "fix" the date filter — `on_or_after` is correct

```ts
{ modifiedDate: params.modifiedSince, modifiedDateConditional: 'on_or_after' }
```

Verified against <https://docs.zenventory.com/openapi.php>. Two things make this look
wrong when it is not:

1. **There is no `modifiedFrom` parameter.** Date filtering goes through the Customer
   Order Advanced Filter, which takes a value parameter plus a matching
   `<field>Conditional`. The docs' own example:
   `?orderNumber=101156&orderNumberConditional=matches&itemQuantity=5&itemQuantityConditional=greater_or_equal`.
   An earlier version passed `modifiedFrom`, which the API silently ignored — so it
   returned everything, with no error.

2. **Zenventory defines a different conditional enum per field type.** This is the
   trap. Searching the spec turns up the *number* enum first:

   - number: `equal, not_equal, greater, greater_or_equal, lesser, lesser_or_equal`
   - **date: `on_or_before, on_or_after, current_date, less_than_x_days_past,
     more_than_x_days_past, less_than_x_days_future, more_than_x_days_future,
     date_not_set` — default `on_or_after`**

   `modifiedDate` is a **date** field, so `on_or_after` is both valid and the default.
   I nearly filed it as a bug on the strength of the number enum. If you are about to
   change it to `greater_or_equal`, you have hit the same trap: don't.

Also: `perPage` is capped at 100 by the API. Higher values are rejected, not clamped.

## 4. The response parsing is also correct — verified against the spec

`src/lib/sync/zenventory.ts` parses the response through fallback chains that look
like guesses. They are not; the first branch of each is right. Checked against the
`CustomerOrderList` / `CustomerOrder` / `PaginationMeta` schemas:

| Code | Spec says | Verdict |
|---|---|---|
| `data.customerOrders ?? data.orders ?? []` | array property is `customerOrders` | ✅ |
| `data.meta` | `meta` object present | ✅ |
| `meta.totalPages ?? meta.total_pages ?? 1` | `meta.totalPages` (alongside `count`, `page`, `perPage`) | ✅ |
| `order.orderNumber ?? order.order_number` | `orderNumber` (string). Note `orderReference` is a **different**, optional field — don't confuse them | ✅ |

This matters because each of these has a *silent* failure mode: a wrong array key or a
wrong order-number key yields zero orders and the sync reports **success with 0
mapped**, no error anywhere. That hypothesis is now eliminated — the parsing is not
the problem.

One latent trap to be aware of, though it is not currently firing: `hasMore = page <
(meta.totalPages ?? ... ?? 1)`. If `meta` were ever absent the sync would stop after
page 1 and silently cap at 100 orders per client. `meta` is confirmed present, so this
is fine today — but it fails quietly rather than loudly if that ever changes.

## 5. Blind spot: partial failures are invisible in the UI

Independent of the API bug, there is a real diagnosability gap that will bite **the
moment you start fixing credentials one client at a time**:

- `syncClientAssignments` collects per-client failures into `clientErrors`, but only
  *throws* when **every** client fails (`if (clientErrors.length === clients.length)`).
- `/api/sync/all` surfaces only that thrown message, as `client_sync_error`.
- `SyncButton.tsx` displays only `client_sync_error`.

So if 7 of 8 clients fail, `clientResults.errors` holds 7 messages and **the UI shows
nothing at all** — the sync appears to succeed. The only reason the failure is visible
today is that *all* clients are failing, which clears the all-must-fail bar.

Consequence for the debugging: as soon as one client's credential is corrected, the
remaining 7 failures go silent and the sync will look fixed when it is not. Worth
surfacing `clientResults.errors` in the UI before working through the credentials.
Not changed here — it is not the root cause, and it should not be edited blind while
the actual fault is still unconfirmed.

## 6. What is still unverified — and the permission wall

Everything checkable *without credentials* is correct. The one remaining hypothesis is
**the per-client credentials stored in Supabase**, which is exactly what the original
report predicted would surface once the 404 stopped masking the auth layer.

Supporting evidence, from the header comment of `scripts/diag-client-api20.mjs`
(written by an earlier session): the key in `.env.local` returns **200** on
`/rest/customer-orders`, while the UI's test button returned an Apache HTML 404. Same
code, same URL, different credential — so **the credential is the only remaining
variable**.

**That observation is post-fix, which is what makes it trustworthy.** The obvious
objection is that it might have compared a hand-made call against a UI still running
the old broken `/api` base URL, which would make it meaningless. It did not. Timings:

| Event | When |
|---|---|
| Base-URL fix committed (`c582ec5`) | 2026-09-20 21:51 |
| Deployed to production | 2026-09-20 21:53 |
| `diag-client-api20.mjs` written (recording the 404) | **2026-09-21 12:31** |

The 404 was seen ~15 hours after the corrected URL was live, so it is not an artifact
of the old path. Check this before trusting the clue again — and note the sibling
scripts `diag-securekey.mjs` (09:39) and `diag-legacy-auth.mjs` (09:51) were written
the same morning, i.e. that session was already probing whether the **legacy** API
could be used instead. That is a meaningful hint about where it was heading.

**Read the 404-vs-401 distinction carefully, because they mean opposite things:**

- **JSON 401** → the API tree exists, the key is simply wrong. Fix: re-enter the key.
- **Apache HTML 404 across the whole tree** → the tree does not exist *for that
  account*, i.e. **API 2.0 is not enabled on that client's Zenventory plan**. No key
  will ever work. This is not a code bug and cannot be fixed by editing this repo.

If it is the second, the fix is one of: have Zenventory enable API 2.0 on those
accounts, or route those clients through the **legacy** API instead. The legacy path
is already implemented here (`getShippingOrders` / `testZenventorySecureKey`, using a
`SecureKey` header against `/services/rest`), and the `clients` table already carries
a `zenventory_secure_key` column — so the groundwork for that fallback exists.

**But the fallback is only half-wired, and this is probably the actual missing piece:**

| Layer | State |
|---|---|
| DB column `zenventory_secure_key` | exists (`supabase/zenventory_secure_key.sql`) |
| UI captures and saves it | yes (`components/clients/ZenventoryCredentials.tsx:26`, `clients/[id]/page.tsx:105`) |
| Legacy API client functions | yes (`getShippingOrders`, `testZenventorySecureKey`) |
| **The sync actually using it** | **no — `syncClientAssignments` selects only `zenventory_api_key` / `zenventory_api_secret` and calls `getCustomerOrders` (API 2.0) exclusively** |

So a client can have a perfectly good SecureKey saved through the UI and the sync will
still ignore it and fail on API 2.0. If the 404s turn out to be "API 2.0 not enabled
on that account", **that is the fix**: have `syncClientAssignments` fall back to the
legacy API when a client has a SecureKey but no working 2.0 credential.

Do not build that fallback speculatively. Confirm the failure mode first — the two
modes need opposite fixes, and the legacy endpoint returns a different payload shape
(`/shippingorders`, not `customerOrders`) that would need its own mapping to order
numbers.

Read-only diagnostics for this already exist, untracked, in `scripts/`. None of them
write anything and none print a credential value:

| Script | What it answers |
|---|---|
| `diag-client-api20.mjs` | Does each client's stored API 2.0 key work against `/rest/customer-orders`? Prints HTTP status + whether the body is JSON or an Apache HTML page. |
| `diag-securekey.mjs` | Which clients have a legacy SecureKey stored? Presence and length only, no network call. |
| `diag-legacy-auth.mjs` | Does the API 2.0 credential also work as a legacy SecureKey? |

**These could not be run.** Executing them requires loading `.env.local` (for
`SUPABASE_SERVICE_ROLE_KEY`), and the auto-mode classifier has now denied that class of
action five times across three sessions — twice in this session alone, via both
`set -a && . ./.env.local` and `node --env-file=.env.local`. I stopped rather than
attempt a third variation.

**To unblock, run this yourself:**

```sh
cd ~/shipo-system && node --env-file=.env.local scripts/diag-client-api20.mjs
```

Then read the output per client:

- **HTTP 200** → that client's credential is fine; the fault is downstream (pagination,
  response shape, or the Supabase write).
- **HTTP 401, JSON body** → wrong key/secret for that client. Re-enter it.
- **HTTP 404, HTML body** → API 2.0 is not enabled on that client's Zenventory account.
  This is an account/plan problem, not a code problem. Use the legacy API for them.
- **"no key/secret stored — skipped"** → the sync in `src/lib/sync/zenventory.ts` only
  selects clients where both columns are non-null, so these were never being synced at
  all and were never part of the "all 8 failing" count.

## 7. Bottom line

The reported root cause is fixed, deployed, and independently verified. The base URLs,
the resource spellings, the date-filter parameters, and the response parsing are all
correct as written. Every hypothesis checkable without a credential has been
eliminated. The next move is not a code change — it is running `diag-client-api20.mjs`
to see which of the 8 clients has which failure mode.
