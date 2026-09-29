# Aligning shipo-system with the shipousa.com design

**Date:** 2026-09-29
**Status:** Design approved, pending spec review
**Scope:** All screens in `shipo-system` — staff and client-facing alike

---

## 1. Intent

The internal ops app and the public website currently look like products from
two different companies. The request is that the app match the site.

The two are near-opposites today:

| | shipousa.com | shipo-system |
| --- | --- | --- |
| Theme | Light — white cards on `#f4f8fd` | Dark — `#0a0f1a` |
| Primary | `#1a73e8` royal blue | `#00AAFF` cyan |
| Brand navy | `#0b3361` | — |
| CTA | lime `#e0ee47`, navy text | — |
| Text | `#0b1220` ink, `#475569` body | `#f0f4f8` on dark |
| Borders | `#e7ecf3` | `#1a2540` |
| Buttons | pill, `radius 999px`, `15px 28px`, weight 600 | square-ish, inconsistent |
| Headings | Roboto Slab | Arial |

So this is a theme inversion, not a palette tweak.

The site values above are not guesses. They are the CSS custom properties the
live site declares (`--shipo-acc`, `--shipo-accd`, `--navy`, `--m-ink`,
`--m-line`, `--m-body`), read from the rendered page on 2026-09-29.

**Success looks like:** a staff member and a customer see the same brand. No
screen still carries the cyan-on-navy theme. Changing a brand colour in future
means editing one file, not 1,400 call sites.

**Explicitly not in scope:** changing any behaviour, data flow, route, or API.
This is a presentation-layer change. If a diff touches logic, it is out of
scope and should be split out.

## 2. What we are actually changing

Measured on 2026-09-29:

- **1,646** `className` occurrences
- **852** `gray-*` utilities (`gray-700` × 230, `gray-400` × 246) used as a
  de-facto dark theme
- **200** `text-white`
- **362** hex literals — **133** inside Tailwind arbitrary classes
  (`bg-[#00AAFF]`), **229** inside inline `style={{}}` objects and component
  props (`color="#44dd88"`)
- **19** files hand-rolling `<input>` / `<select>` / `<textarea>` / `<form>`
- **1** component in `src/components/ui/` (`Toast.tsx`)
- **0** tests
- `clsx` and `tailwind-merge` are dependencies but are imported nowhere

### The outlier

`src/app/marketing/page.tsx` holds **170 of the 362 hex literals** and **144
of the ~175 inline-style objects**. Nearly half the colour surface is a single
file written in a different style from the rest of the app — inline styles
rather than Tailwind. Every other file has 17 or fewer.

It is treated as its own migration unit (§6), not fed through the codemod.

### The shortcut that does not work

Tailwind v4 allows redefining `--color-gray-700` in `@theme`, which would
invert the entire ramp and flip the app light from one file. Reject this:

- `text-white` (200 uses) is not on the gray ramp. It would stay white and
  become invisible on 200 light surfaces.
- The 362 hex literals bypass the token system entirely. Buttons would stay
  cyan.
- The resulting vocabulary lies — `text-gray-400` would mean "dark secondary
  text on a light background" — and every future reader pays for it.

## 3. Token layer

Semantic names in Tailwind v4's `@theme`, in `src/app/globals.css`. After this
work no component contains a hex literal.

```css
--color-canvas:        #f4f8fd   /* page background */
--color-surface:       #ffffff   /* cards, panels, input fills */
--color-surface-muted: #f6f8fb   /* table stripes, wells */
--color-line:          #e7ecf3   /* borders          (site --m-line) */
--color-line-strong:   #d5dee9   /* input borders, dividers */
--color-ink:           #0b1220   /* headings         (site --m-ink) */
--color-ink-body:      #475569   /* body copy        (site --m-body) */
--color-ink-muted:     #6b7a8d   /* labels, captions */
--color-navy:          #0b3361   /* brand navy       (site --navy) */
--color-accent:        #1a73e8   /* primary action   (site --shipo-acc) */
--color-accent-hover:  #0b5ed7   /* hover            (site --shipo-accd) */
--color-accent-soft:   #eaf1fd   /* selected rows, tints */
--color-cta:           #e0ee47   /* lime CTA, navy text on it */
```

### Status colours

The site declares none, and the app's current set (`#44dd88`, `#ffaa44`,
`#ff6688`, `#ff6644`) is tuned for a dark background — all four fail contrast
on white. Replacements, each with a soft tint for badge backgrounds:

```css
--color-success:      #0f7a3d    --color-success-soft: #e6f4ec
--color-warning:      #9a6400    --color-warning-soft: #fdf3e2
--color-danger:       #b3261e    --color-danger-soft:  #fdecea
```

Every one of these clears 4.5:1 against `--color-surface`.

### Removed

The `--color-shipo` / `--color-shipo-dark` / `--color-shipo-light` trio, the
dark `body` background, and the dark brand scrollbar block in `globals.css`.

## 4. Density and typography

Website *shapes*, application *scale*. The pill button is the site's most
recognisable signature and it stays; only the scale drops, because a
shipments table at marketing padding shows roughly a third as many rows.

| Element | Site | Here |
| --- | --- | --- |
| Button | `radius 999px`, `15px 28px`, 16px/600 | `rounded-full`, `px-4 py-2`, `text-sm`/600 |
| Input | — | `h-9 px-3 rounded-lg`, `border-line-strong` |
| Card | — | `rounded-xl border border-line bg-surface p-5` |
| Table row | — | `h-10` |

Typography:

- **Headings** (`h1`–`h3`): Roboto Slab via `next/font/google`, weights 500 and
  700. This is the only webfont loaded.
- **Body**: the system stack, copied verbatim from the site —
  `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu,
  Cantarell, "Helvetica Neue", sans-serif`. No webfont needed.
- 15px base at 1.65 line-height (site values); 14px inside tables.

This also removes the `Arial, Helvetica, sans-serif` currently on `body`,
which matches neither the site nor the unused `--font-geist-sans` variable
declared beside it.

## 5. Primitives — `src/components/ui/`

| File | Purpose |
| --- | --- |
| `cn.ts` | `clsx` + `tailwind-merge` wrapper — both deps already installed |
| `Button.tsx` | variants `primary` / `secondary` / `cta` / `ghost` / `danger`; sizes `sm` / `md` |
| `Input.tsx`, `Select.tsx`, `Textarea.tsx` | share one field shell |
| `Field.tsx` | label + control + error + hint |
| `Card.tsx` | surface container |
| `Table.tsx` | `Table` / `Head` / `Row` / `Cell`, density baked in |
| `Badge.tsx` | status pill — replaces the ad-hoc `bg-green-900 text-green-300` pattern |

`Toast.tsx` is restyled in place, not replaced.

These exist so the 19 form files stop hand-rolling inputs. That duplication is
the reason a restyle costs 1,400 edits instead of 8.

## 6. Migration

### 6.1 The codemod

`scripts/restyle-codemod.mjs`, driven by an explicit `scripts/restyle-map.json`.
Dry-run by default; `--write` applies. It handles both syntaxes:

- Tailwind classes → semantic classes (`bg-gray-800` → `bg-surface`)
- Inline styles and props → CSS vars
  (`color: '#8899bb'` → `color: 'var(--color-ink-muted)'`)

The mapping table is the reviewable artifact. A table of ~40 rows can be read
and corrected before it runs; 1,400 hand edits cannot be reviewed at all. That
is the whole argument for this approach.

Draft mapping, to be confirmed against real usage during implementation:

| From | To |
| --- | --- |
| `bg-gray-900`, `bg-[#0a0f1a]`, `bg-[#0d1420]` | `bg-canvas` |
| `bg-gray-800` | `bg-surface` |
| `bg-gray-700` | `bg-surface-muted` |
| `border-gray-600`, `border-gray-700`, `border-[#1a2540]` | `border-line` |
| `text-gray-300` | `text-ink-body` |
| `text-gray-400`, `text-gray-500` | `text-ink-muted` |
| `#00AAFF` | `accent` |
| `#33BBFF`, `#0090DD` | `accent-hover` |
| `#44dd88` | `success` |
| `#ffaa44` | `warning` |
| `#ff6688`, `#ff6644` | `danger` |

One row needs care: `bg-gray-700` is both a panel well *and* the current input
fill. It maps to `bg-surface-muted` here, which is correct for wells and wrong
for inputs — but every input is hand-migrated onto `<Input>` in step 6 of
§6.3, which supplies `bg-surface` itself. The codemod's value for those lines
is discarded, not shipped.

**`text-white` is not blind-mapped.** On accent and navy backgrounds white
remains correct. The codemod rewrites it only where the same `className`
carries no dark background utility, and flags every ambiguous case instead of
guessing.

Output: `restyle-report.md`, listing every unmapped token and every flagged
`text-white` with file and line. That report is the hand-fix worklist, and
driving it to zero is a completion criterion.

### 6.2 `src/app/marketing/page.tsx`

Migrated by hand onto the primitives, not by codemod. It is 47% of the colour
surface, it is the only file written in inline-style form, and running a
mechanical pass over it would produce a diff nobody can review. Converting it
to Tailwind + primitives also brings it in line with the other 23 components.

### 6.3 Sequence — and the trap

Flipping `globals.css` to a light background is **not** step one. Doing so
leaves a light canvas under 1,400 still-dark utilities: an unreadable app.

1. Token layer and fonts, **purely additive** — new names only, `body`
   background untouched. App still looks exactly as it does today.
2. Build the primitives. Still unused, still no visual change.
3. Codemod dry-run. Review `restyle-map.json` and `restyle-report.md`.
4. **Atomic commit:** apply the codemod *and* flip `body` / scrollbar /
   Turnstile theme together. There is no commit in which the app is half
   converted.
5. Hand-migrate `marketing/page.tsx`.
6. Hand-migrate the 19 form files onto `Field` / `Input` / `Button`.
7. Route-by-route visual pass.

## 7. Verification

There is no test suite, so verification is explicit:

- `next build` and `eslint` clean.
- `restyle-report.md` at zero unmapped tokens and zero unresolved
  `text-white` flags.
- A guard script that fails if any `#rrggbb` literal or `gray-*` /
  `text-white` class reappears in `src/**/*.tsx`. Scoped to `.tsx`
  deliberately: `globals.css` is where hex literals are *supposed* to live,
  and a guard that flags the token layer itself would be turned off within a
  week. Run it wherever lint runs so the old vocabulary cannot creep back.
- Manual pass over every route.

**The login page is verified first.** It hardcodes Turnstile `theme: 'dark'`,
and it is the one screen a locked-out user sees. Getting it wrong locks
everyone out of a production system.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Half-converted app is unreadable | Codemod and background flip land in one commit (§6.3 step 4) |
| No tests to catch regressions | Build + lint + report-at-zero + guard script + manual route pass |
| Contrast failures on white | Status colours retuned in §3; all clear 4.5:1 |
| Login lockout via Turnstile theme | Login verified first (§7) |
| Restyle confused with the unshipped Zenventory fix | Deploy current `main` **before** this work starts |

### The deploy ordering constraint

`~/shipo-system` has five unpushed commits and has never been deployed with
the Zenventory base-URL fix. Any deploy carrying this restyle also carries
that fix. Ship `vercel --prod` on the current code first, confirm the sync
recovers, and only then begin — otherwise a sync regression and a restyle
regression arrive in the same deploy and cannot be told apart.
