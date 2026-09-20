#!/usr/bin/env python3
"""
Builds the Shipo UPS 2-3 Day customer price list from LIVE ShipStation rates.

Input : scripts/out/ups-rates-raw.json   (written by ss-ups-rates.mjs)
Output: scripts/out/Shipo-UPS-2-3-Day-Price-List.xlsx

Prices are FORMULAS (cost + markup), so editing the markup ladder recalculates
the whole book. No rate is ever invented: if a weight/zone wasn't returned by
ShipStation the cell is left blank and listed on the Gaps sheet.
"""
import json
import os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
RAW = os.path.join(OUT, "ups-rates-raw.json")
XLSX = os.path.join(OUT, "Shipo-UPS-2-3-Day-Price-List.xlsx")

# --- markup ladder: $5 at 1 lb -> $15 at 10 lb -> $40 at 50 lb, in steps -----
#
# Set by Ophir Schultz. Three anchors he gave explicitly:
#   1 lb  = $5.00   (original instruction, 2026-09-03)
#   10 lb = $15.00  (raised 2026-09-03: "10 lbs to 50 lbs make it higher profit
#                    of starting 15$ profit for 10lbs than go up")
#   50 lb = $40.00  (2026-09-03: chose $40 when asked to name the ceiling he had
#                    previously left open)
# The 1-9 lb steps ramp to meet the $15 anchor, and 12-50 lb climbs from it to
# the $40 top. Change column C on the 'Markup Ladder' sheet and the whole book
# re-prices; nothing downstream hardcodes a markup.
LADDER = [
    (1, 1, 5.00),
    (2, 3, 6.00),
    (4, 5, 7.50),
    (6, 7, 9.00),
    (8, 9, 11.00),
    (10, 11, 15.00),      # <- Ophir's anchor
    (12, 14, 17.00),
    (15, 17, 19.00),
    (18, 20, 21.00),
    (21, 25, 24.00),
    (26, 30, 27.00),
    (31, 35, 30.00),
    (36, 40, 33.00),
    (41, 45, 36.50),
    (46, 50, 40.00),      # <- Ophir's anchor
]

ZONES = [2, 3, 4, 5, 6, 7, 8]
WEIGHTS = list(range(1, 51))

ARIAL = "Arial"
BLUE = Font(name=ARIAL, size=10, color="0000FF")          # hardcoded input
BLACK = Font(name=ARIAL, size=10)                          # formula
BOLD = Font(name=ARIAL, size=10, bold=True)
TITLE = Font(name=ARIAL, size=13, bold=True)
HDRFILL = PatternFill("solid", fgColor="DDDDDD")
YELLOW = PatternFill("solid", fgColor="FFFF00")
MONEY = '$#,##0.00;($#,##0.00);-'
THIN = Side(style="thin", color="BBBBBB")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


ZONE_CHART = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "ups-zone-chart-198.txt")


def load_zone_chart():
    """{dest 3-digit ZIP prefix: zone} from the OFFICIAL UPS chart for origin 198.

    Source of truth is scripts/ups-zone-chart-198.txt, transcribed 2026-09-03 from
    https://www.ups.com/media/us/currentrates/zone-csv/198.xls -- the chart UPS
    publishes for "shipments originating in ZIP Codes 198-01 to 198-99", i.e. Shipo.

    Why this exists: the rate puller used to carry a hand-written zone number
    alongside each destination city, and five of the seven were wrong. A wrong
    zone number does not look wrong -- the rates beside it are real, so the card
    reads perfectly while quoting Zone 6 money under a Zone 5 heading. Reading the
    zone from the published chart instead of from the pull removes the only step
    where a human opinion could enter the number.

    Verified across all 906 destination prefixes in the file: UPS Ground,
    3 Day Select and 2nd Day Air share one zone for every mainland prefix, so a
    single number per prefix is enough for everything Shipo prices. Puerto Rico
    is the sole exception and is deliberately excluded rather than approximated.
    """
    chart = {}
    with open(ZONE_CHART) as f:
        for line in f:
            line = line.split("#")[0].strip()
            if not line:
                continue
            for tok in line.split():
                if "=" not in tok:
                    continue          # the Puerto Rico rows use a different format
                rng, _, z = tok.partition("=")
                if not z.isdigit():
                    continue
                if "-" in rng:
                    lo, hi = rng.split("-", 1)
                    if not (lo.isdigit() and hi.isdigit()):
                        continue
                    for p in range(int(lo), int(hi) + 1):
                        chart[f"{p:03d}"] = int(z)
                elif rng.isdigit():
                    chart[f"{int(rng):03d}"] = int(z)
    return chart


def apply_zone_chart(rows):
    """Overwrite every row's `zone` with the zone UPS publishes for its dest ZIP.

    Returns (rows_kept, report). Any row whose destination prefix is not in the
    chart is DROPPED, not guessed -- an unmapped ZIP means the chart does not
    cover it, and a fabricated zone is worse than a missing column.
    """
    chart = load_zone_chart()
    kept, unmapped, changed = [], {}, {}
    for r in rows:
        pre = str(r.get("destZip") or "")[:3]
        z = chart.get(pre)
        if z is None:
            unmapped[r.get("destCity") or pre] = pre
            continue
        if r.get("zone") != z:
            changed[(r.get("destCity"), r.get("zone"), z)] = pre
        r["zone"] = z
        kept.append(r)
    return kept, {"unmapped": unmapped, "changed": changed, "chart_size": len(chart)}


def load():
    with open(RAW) as f:
        return json.load(f)


def index_costs(rows, pattern, carrier=None):
    """{(zone, lb): totalCost} for services matching pattern, on one carrier.

    Ophir has several UPS accounts connected. Mixing them in one price card would
    quote rates he can't actually buy consistently, so a card is always built from
    a single carrier. carrier=None means 'whatever is in the file' (single-account
    pulls, kept for backwards compatibility).
    """
    out = {}
    for r in rows:
        if carrier is not None and r.get("carrier") != carrier:
            continue
        name = (r.get("serviceName") or "").lower()
        if pattern not in name:
            continue
        out[(r["zone"], r["lb"])] = r["totalCost"]
    return out


def pick_baseline(rows):
    """Which UPS account to publish the card from.

    Set SHIPO_BASELINE_CARRIER to force it (e.g. 'ups' or 'ups_walleted').

    Otherwise: prefer 'ups_walleted' — the "UPS by ShipStation" / DAP card.

    This used to prefer the own-contract code 'ups'. The 2026-09-03 pull settled it
    on measured numbers, and it was not close:

      2nd Day Air, 50 lb   'ups' (acct ...4A60)   'ups_walleted'
        Philadelphia            $91.28                $42.76
        Chicago                $203.93                $93.87
        Los Angeles            $345.76               $174.13

    The walleted card is 50-65% cheaper on every air and 3 Day Select lane. It also
    prices FLAT BY ZONE: New York and Philadelphia (both Zone 2) come back identical
    at all 50 weights, as do Atlanta and Dallas (both Zone 6). The 'ups' account does
    not — it adds a $8.53 urban delivery-area surcharge to New York and Chicago,
    which is what made a zone-column card come out non-monotonic.

    So the walleted card is both cheaper AND quotable from a plain zone x weight
    grid, with no surcharge caveat. Ground is the one exception: there the two
    accounts are within a dollar and 'ups' is marginally cheaper above ~10 lb, which
    the Compare Accts sheets show.

    Note the account 'ups' resolves to is ...4A60 — the same account number Ophir
    nicknamed "Shipo UPS DOnt use", returning UPS retail pricing. Its rates are real
    but they are not rates to sell against.

    Flip with:  SHIPO_BASELINE_CARRIER=ups python3 scripts/build-price-list.py
    """
    carriers = [c for c in {r.get("carrier") for r in rows} if c]
    if not carriers:
        return None
    forced = os.environ.get("SHIPO_BASELINE_CARRIER")
    if forced and forced in carriers:
        return forced
    for c in carriers:
        if "1k" in c.lower():
            return c
    if "ups_walleted" in carriers:
        return "ups_walleted"
    if "ups" in carriers:
        return "ups"
    return max(carriers, key=lambda c: sum(1 for r in rows if r.get("carrier") == c))


def norm_service(s):
    """'UPS 2nd Day Air A.M.®' -> '2nd day air am'. Used for exact service matching."""
    s = (s or "").lower().strip()
    if s.startswith("ups "):
        s = s[4:]
    s = "".join(ch if (ch.isalnum() or ch == " ") else "" for ch in s)
    return " ".join(s.split())


def resolve_service(services, target):
    """The ONE service name that means `target`, never a near-neighbour.

    Substring matching is dangerous here: '2nd day air' also matches
    'UPS 2nd Day Air A.M.', which is a different, dearer product. Mixing them
    would silently publish A.M. rates on the standard card. So: exact normalised
    match first; only if that fails, the SHORTEST containing name.
    """
    t = norm_service(target)
    for s in services:
        if norm_service(s) == t:
            return s
    cands = [s for s in services if t in norm_service(s)]
    return min(cands, key=len) if cands else None


def comparison_sheet(wb, rows, carriers, service, title):
    """Side-by-side UPS account costs, so the cheapest card is visible, not assumed."""
    ws = wb.create_sheet(title)
    ws["A1"] = f"{title} — same shipment, every connected UPS account"
    ws["A1"].font = TITLE
    ws["A2"] = ("Live ShipStation costs. Lowest cost per row is the cheapest card for that "
                "zone/weight. Blank = that account returned no quote.")
    ws["A2"].font = Font(name=ARIAL, size=9, italic=True)

    hdr = ["Weight (lb)", "Zone"] + list(carriers) + ["Cheapest", "Spread ($)"]
    for c, h in enumerate(hdr, start=1):
        cell = ws.cell(row=4, column=c, value=h)
        cell.font = BOLD
        cell.fill = HDRFILL
        cell.border = BOX
        cell.alignment = Alignment(horizontal="center", wrap_text=True)

    idx = {c: service_costs(rows, service, c) for c in carriers}
    r = 5
    for lb in WEIGHTS:
        for z in ZONES:
            vals = [idx[c].get((z, lb)) for c in carriers]
            if all(v is None for v in vals):
                continue
            ws.cell(row=r, column=1, value=lb).font = BOLD
            ws.cell(row=r, column=2, value=z).font = BOLD
            for j, v in enumerate(vals):
                cell = ws.cell(row=r, column=3 + j)
                if v is not None:
                    cell.value = v
                    cell.font = BLUE
                cell.number_format = MONEY
                cell.border = BOX
            first = get_column_letter(3)
            last = get_column_letter(2 + len(carriers))
            lo = ws.cell(row=r, column=3 + len(carriers))
            lo.value = f"=IFERROR(MIN({first}{r}:{last}{r}),\"\")"
            lo.number_format = MONEY
            lo.font = BLACK
            sp = ws.cell(row=r, column=4 + len(carriers))
            sp.value = (f'=IF(COUNT({first}{r}:{last}{r})<2,"",'
                        f'MAX({first}{r}:{last}{r})-MIN({first}{r}:{last}{r}))')
            sp.number_format = MONEY
            sp.font = BLACK
            for col in range(1, 5 + len(carriers)):
                ws.cell(row=r, column=col).border = BOX
            r += 1

    ws.column_dimensions["A"].width = 12
    ws.column_dimensions["B"].width = 8
    for j in range(len(carriers) + 2):
        ws.column_dimensions[get_column_letter(3 + j)].width = 16
    ws.freeze_panes = "C5"


def ladder_sheet(wb):
    ws = wb.create_sheet("Markup Ladder")
    ws["A1"] = "Shipo markup ladder — EDIT THESE YELLOW CELLS TO RESET ALL PRICING"
    ws["A1"].font = TITLE
    ws["A2"] = (f"Profit added on top of Shipo's actual UPS cost. "
                f"${LADDER[0][2]:,.0f} at {LADDER[0][0]} lb, rising in steps to "
                f"${LADDER[-1][2]:,.0f} at {LADDER[-1][1]} lb.")
    ws["A2"].font = Font(name=ARIAL, size=9, italic=True)

    hdr = ["Min weight (lb)", "Max weight (lb)", "Markup / profit ($)"]
    for c, h in enumerate(hdr, start=1):
        cell = ws.cell(row=4, column=c, value=h)
        cell.font = BOLD
        cell.fill = HDRFILL
        cell.border = BOX
        cell.alignment = Alignment(horizontal="center", wrap_text=True)

    for i, (lo, hi, mk) in enumerate(LADDER):
        r = 5 + i
        ws.cell(row=r, column=1, value=lo).font = BLUE
        ws.cell(row=r, column=2, value=hi).font = BLUE
        c = ws.cell(row=r, column=3, value=mk)
        c.font = BLUE
        c.number_format = MONEY
        c.fill = YELLOW
        for col in (1, 2, 3):
            ws.cell(row=r, column=col).border = BOX

    n = len(LADDER)
    ws.cell(row=5 + n + 1, column=1, value="Assumption: markup is per shipment, added to Shipo's landed UPS cost.").font = Font(name=ARIAL, size=9, italic=True)
    ws.cell(row=5 + n + 2, column=1, value="Source of markup values: set by Ophir Schultz, 2026-09-03. Not derived from a carrier document.").font = Font(name=ARIAL, size=9, italic=True)

    ws.column_dimensions["A"].width = 18
    ws.column_dimensions["B"].width = 18
    ws.column_dimensions["C"].width = 20
    return 5, 5 + n - 1  # first/last data row


def cost_sheet(wb, title, costs, meta):
    ws = wb.create_sheet(title)
    ws["A1"] = f"{title} — Shipo's ACTUAL UPS cost (what Shipo pays)"
    ws["A1"].font = TITLE
    ws["A2"] = (
        f"Live from ShipStation {meta['pulledAt'][:10]} · carrier '{meta['carrier']}' · "
        f"UPS account {meta.get('primaryAccount', '(unknown)')} · "
        f"from ZIP {meta['fromZip']} · residential={meta['residential']} · no dim-weight applied"
    )
    ws["A2"].font = Font(name=ARIAL, size=9, italic=True)

    ws.cell(row=4, column=1, value="Weight (lb)").font = BOLD
    ws.cell(row=4, column=1).fill = HDRFILL
    ws.cell(row=4, column=1).border = BOX
    for j, z in enumerate(ZONES):
        c = ws.cell(row=4, column=2 + j, value=f"Zone {z}")
        c.font = BOLD
        c.fill = HDRFILL
        c.border = BOX
        c.alignment = Alignment(horizontal="center")

    for i, lb in enumerate(WEIGHTS):
        r = 5 + i
        ws.cell(row=r, column=1, value=lb).font = BOLD
        ws.cell(row=r, column=1).border = BOX
        for j, z in enumerate(ZONES):
            c = ws.cell(row=r, column=2 + j)
            v = costs.get((z, lb))
            if v is not None:
                c.value = v
                c.font = BLUE
            c.number_format = MONEY
            c.border = BOX

    ws.column_dimensions["A"].width = 12
    for j in range(len(ZONES)):
        ws.column_dimensions[get_column_letter(2 + j)].width = 12
    ws.freeze_panes = "B5"
    return ws


def price_sheet(wb, title, cost_title, lad_first, lad_last):
    ws = wb.create_sheet(title)
    ws["A1"] = f"{title} — CUSTOMER PRICE (what the client pays)"
    ws["A1"].font = TITLE
    ws["A2"] = "= Shipo's UPS cost + markup from the 'Markup Ladder' sheet. Change the ladder and every price here updates."
    ws["A2"].font = Font(name=ARIAL, size=9, italic=True)
    ws["A3"] = ("ACTUAL WEIGHT ONLY — a light-but-bulky box bills on dimensional weight and costs MORE. "
                "Use the QUOTE CALCULATOR sheet for those.")
    ws["A3"].font = Font(name=ARIAL, size=9, bold=True, color="CC0000")

    ws.cell(row=4, column=1, value="Weight (lb)").font = BOLD
    ws.cell(row=4, column=1).fill = HDRFILL
    ws.cell(row=4, column=1).border = BOX
    for j, z in enumerate(ZONES):
        c = ws.cell(row=4, column=2 + j, value=f"Zone {z}")
        c.font = BOLD
        c.fill = HDRFILL
        c.border = BOX
        c.alignment = Alignment(horizontal="center")
    mk_col = len(ZONES) + 3
    c = ws.cell(row=4, column=mk_col, value="Markup applied")
    c.font = BOLD
    c.fill = HDRFILL
    c.border = BOX

    lad_min = f"'Markup Ladder'!$A${lad_first}:$A${lad_last}"
    lad_mk = f"'Markup Ladder'!$C${lad_first}:$C${lad_last}"

    for i, lb in enumerate(WEIGHTS):
        r = 5 + i
        ws.cell(row=r, column=1, value=lb).font = BOLD
        ws.cell(row=r, column=1).border = BOX
        mk = f"INDEX({lad_mk},MATCH($A{r},{lad_min},1))"
        for j, z in enumerate(ZONES):
            col = get_column_letter(2 + j)
            src = f"'{cost_title}'!{col}{r}"
            c = ws.cell(row=r, column=2 + j)
            # blank cost -> blank price, never a fabricated number
            c.value = f'=IF({src}="","",{src}+{mk})'
            c.font = BLACK
            c.number_format = MONEY
            c.border = BOX
        m = ws.cell(row=r, column=mk_col, value=f"={mk}")
        m.font = BLACK
        m.number_format = MONEY
        m.border = BOX

    ws.column_dimensions["A"].width = 12
    for j in range(len(ZONES)):
        ws.column_dimensions[get_column_letter(2 + j)].width = 12
    ws.column_dimensions[get_column_letter(mk_col)].width = 16
    ws.freeze_panes = "B5"


def margin_sheet(wb, title, price_title):
    """Markup as a % of the customer price, cell by cell. Formula-driven."""
    ws = wb.create_sheet(title)
    ws["A1"] = f"{title} — margin as a % of what the client pays"
    ws["A1"].font = TITLE
    ws["A2"] = "= markup / customer price. Shows where a flat-dollar ladder gets thin. Updates with the ladder."
    ws["A2"].font = Font(name=ARIAL, size=9, italic=True)

    ws.cell(row=4, column=1, value="Weight (lb)").font = BOLD
    ws.cell(row=4, column=1).fill = HDRFILL
    ws.cell(row=4, column=1).border = BOX
    for j, z in enumerate(ZONES):
        c = ws.cell(row=4, column=2 + j, value=f"Zone {z}")
        c.font = BOLD
        c.fill = HDRFILL
        c.border = BOX
        c.alignment = Alignment(horizontal="center")

    mk_col = get_column_letter(len(ZONES) + 3)  # "Markup applied" col on the PRICE sheet
    for i, lb in enumerate(WEIGHTS):
        r = 5 + i
        ws.cell(row=r, column=1, value=lb).font = BOLD
        ws.cell(row=r, column=1).border = BOX
        for j, z in enumerate(ZONES):
            col = get_column_letter(2 + j)
            price = f"'{price_title}'!{col}{r}"
            mk = f"'{price_title}'!${mk_col}{r}"
            c = ws.cell(row=r, column=2 + j)
            # guard the zero/blank denominator: blank price -> blank margin
            c.value = f'=IF(OR({price}="",{price}=0),"",{mk}/{price})'
            c.font = BLACK
            c.number_format = "0.0%"
            c.border = BOX

    ws.column_dimensions["A"].width = 12
    for j in range(len(ZONES)):
        ws.column_dimensions[get_column_letter(2 + j)].width = 12
    ws.freeze_panes = "B5"


def safe_sheet_name(prefix, service, used):
    """Excel caps sheet names at 31 chars and forbids []:*?/\\ — and duplicates."""
    s = service
    for ch in "[]:*?/\\":
        s = s.replace(ch, "")
    s = s.replace("UPS ", "").strip()
    name = f"{prefix} {s}"[:31].strip()
    base, i = name, 2
    while name in used:
        suffix = f" {i}"
        name = base[: 31 - len(suffix)] + suffix
        i += 1
    used.add(name)
    return name


def discover_services(rows, carrier=None):
    """Every distinct service ShipStation actually returned, most-quoted first.

    Nothing is hardcoded: if UPS adds or drops a product, this picks it up on the
    next pull without a code change.
    """
    counts = {}
    for r in rows:
        if carrier is not None and r.get("carrier") != carrier:
            continue
        n = (r.get("serviceName") or "").strip()
        if n:
            counts[n] = counts.get(n, 0) + 1
    return [s for s, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


def service_costs(rows, service, carrier=None):
    """{(zone, lb): totalCost} for one exact service name on one carrier.

    WORST-CASE RULE. After the UPS chart is applied, two quoted cities can land in
    the same zone -- Philadelphia and New York are both Zone 2, Atlanta and Dallas
    are both Zone 6. Their BASE rates are identical (verified 50/50 at every weight,
    which is what proves the zone mapping), but their SURCHARGES are not: New York
    carries about $8.53 more than Philadelphia at every weight.

    So one number has to represent the zone, and a plain dict assignment would let
    whichever row happened to come last decide it -- silently, and differently on a
    re-pull. Take the HIGHEST cost in the zone instead. A card built on the dearest
    measured city can only ever beat its own cost; one built on the cheapest quietly
    loses money on every urban delivery. See the 'Zone Surcharges' sheet for the
    spread this hides.
    """
    out = {}
    for r in rows:
        if carrier is not None and r.get("carrier") != carrier:
            continue
        if (r.get("serviceName") or "").strip() != service:
            continue
        k = (r["zone"], r["lb"])
        c = r["totalCost"]
        if k not in out or c > out[k]:
            out[k] = c
    return out


def zone_surcharge_sheet(wb, rows, services, carrier):
    """Every city quoted, its UPS zone, and its base-vs-surcharge split.

    The reason this sheet exists: a zone/weight price card is only honest about the
    BASE rate. UPS charges the same base to every ZIP in a zone but adds
    destination-specific surcharges on top (residential, delivery-area, urban).
    Two Zone 2 cities differed by $8.53 a parcel here. Anyone reading the card needs
    to see that number, or they will quote a Manhattan delivery at Philadelphia cost.
    """
    ws = wb.create_sheet("Zone Surcharges")
    ws["A1"] = "ZONE CHECK — every city quoted, its official UPS zone, and its surcharge"
    ws["A1"].font = Font(name=ARIAL, size=13, bold=True)
    ws["A2"] = ("Zones are read from the UPS chart for origin 198 (scripts/ups-zone-chart-198.txt), "
                "not inferred from price. Cities sharing a zone MUST show the same base rate — "
                "that is the proof the mapping is right. Surcharge is what differs.")
    ws["A2"].font = Font(name=ARIAL, size=9, italic=True, color="666666")
    ws["A3"] = ("The price card uses the HIGHEST total in each zone, so it never under-prices. "
                "Where the spread below is large, quote the surcharge as a pass-through.")
    ws["A3"].font = Font(name=ARIAL, size=9, italic=True, color="C00000")

    hdr = ["Service", "Zone", "City", "Dest ZIP", "Weight", "Base rate",
           "Surcharge", "Total", "Used on card?"]
    r = 5
    for j, h in enumerate(hdr):
        c = ws.cell(row=r, column=j + 1, value=h)
        c.font = Font(name=ARIAL, size=10, bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="333333")
        c.border = BOX
    r += 1

    for svc in services:
        for lb in (1, 25, 50):
            sub = [x for x in rows
                   if x.get("carrier") == carrier
                   and (x.get("serviceName") or "").strip() == svc
                   and x.get("lb") == lb]
            if not sub:
                continue
            best = {}
            for x in sub:
                z = x["zone"]
                if z not in best or x["totalCost"] > best[z]["totalCost"]:
                    best[z] = x
            for x in sorted(sub, key=lambda y: (y["zone"], -y["totalCost"])):
                vals = [svc, x["zone"], x.get("destCity"), x.get("destZip"), lb,
                        x.get("shipmentCost"), x.get("otherCost"), x.get("totalCost"),
                        "YES" if best[x["zone"]] is x else ""]
                for j, v in enumerate(vals):
                    c = ws.cell(row=r, column=j + 1, value=v)
                    c.font = Font(name=ARIAL, size=10,
                                  bold=(j == 8 and v == "YES"))
                    c.border = BOX
                    if j in (5, 6, 7):
                        c.number_format = MONEY
                r += 1
    for j, w in enumerate((26, 7, 15, 10, 9, 12, 12, 12, 14)):
        ws.column_dimensions[get_column_letter(j + 1)].width = w
    ws.freeze_panes = "A6"
    return ws


def service_summary_sheet(wb, rows, services, carrier, meta):
    """One row per UPS service: coverage and cost range. The 'what did we get' sheet."""
    ws = wb.create_sheet("Service Summary", 0)
    ws["A1"] = "ALL UPS SERVICES — what ShipStation actually quoted"
    ws["A1"].font = TITLE
    ws["A2"] = (f"Carrier account '{carrier}' · from ZIP {meta['fromZip']} · "
                f"residential={meta['residential']} · pulled {str(meta['pulledAt'])[:10]} · "
                f"actual weight only, no dim weight applied here")
    ws["A2"].font = Font(name=ARIAL, size=9, italic=True)

    hdr = ["UPS service", "Quotes returned", "of possible", "Coverage",
           "Cheapest quote", "Dearest quote", "Cost @ 1 lb Z2", "Cost @ 50 lb Z8"]
    for c, h in enumerate(hdr, start=1):
        cell = ws.cell(row=4, column=c, value=h)
        cell.font = BOLD
        cell.fill = HDRFILL
        cell.border = BOX
        cell.alignment = Alignment(horizontal="center", wrap_text=True)

    possible = len(ZONES) * len(WEIGHTS)
    r = 5
    for svc in services:
        costs = service_costs(rows, svc, carrier)
        vals = [v for v in costs.values() if v is not None]
        ws.cell(row=r, column=1, value=svc).font = BOLD
        ws.cell(row=r, column=2, value=len(vals)).font = BLUE
        ws.cell(row=r, column=3, value=possible).font = BLUE
        cov = ws.cell(row=r, column=4, value=f"=IF($C{r}=0,\"\",$B{r}/$C{r})")
        cov.font = BLACK
        cov.number_format = "0.0%"
        for col, v in ((5, min(vals) if vals else None), (6, max(vals) if vals else None),
                       (7, costs.get((2, 1))), (8, costs.get((8, 50)))):
            c = ws.cell(row=r, column=col)
            if v is not None:
                c.value = v
                c.font = BLUE
            c.number_format = MONEY
        for col in range(1, 9):
            ws.cell(row=r, column=col).border = BOX
        r += 1

    r += 1
    for line in [
        "Blank = ShipStation returned no quote for that box. Never estimated.",
        "Coverage below 100% means that service does not serve every zone/weight tested.",
        "Cost is what Shipo pays. Customer prices are on the PRICE sheets.",
    ]:
        ws.cell(row=r, column=1, value=line).font = Font(name=ARIAL, size=9, italic=True)
        r += 1

    ws.column_dimensions["A"].width = 34
    for col in "BCDEFGH":
        ws.column_dimensions[col].width = 15
    return ws


def cheapest_service_sheet(wb, rows, services, carrier):
    """Per zone/weight: which UPS service is cheapest, and what the next one costs.

    This is the sheet that answers 'am I quoting the right product' — sometimes
    Ground or Ground Saver lands in 2-3 days anyway and undercuts the air products.
    """
    ws = wb.create_sheet("Cheapest Service")
    ws["A1"] = "CHEAPEST UPS SERVICE per zone and weight"
    ws["A1"].font = TITLE
    ws["A2"] = ("Compares every service returned. 'Penalty' is what the 2-3 day air product "
                "costs above the outright cheapest option.")
    ws["A2"].font = Font(name=ARIAL, size=9, italic=True)

    hdr = ["Weight (lb)", "Zone", "Cheapest service", "Cost",
           "Runner-up service", "Cost", "Gap ($)"]
    for c, h in enumerate(hdr, start=1):
        cell = ws.cell(row=4, column=c, value=h)
        cell.font = BOLD
        cell.fill = HDRFILL
        cell.border = BOX
        cell.alignment = Alignment(horizontal="center", wrap_text=True)

    idx = {s: service_costs(rows, s, carrier) for s in services}
    r = 5
    for lb in WEIGHTS:
        for z in ZONES:
            opts = sorted(
                ((s, idx[s][(z, lb)]) for s in services if (z, lb) in idx[s]),
                key=lambda kv: kv[1],
            )
            if not opts:
                continue
            ws.cell(row=r, column=1, value=lb).font = BOLD
            ws.cell(row=r, column=2, value=z).font = BOLD
            ws.cell(row=r, column=3, value=opts[0][0]).font = BLACK
            c = ws.cell(row=r, column=4, value=opts[0][1])
            c.font = BLUE
            c.number_format = MONEY
            if len(opts) > 1:
                ws.cell(row=r, column=5, value=opts[1][0]).font = BLACK
                c2 = ws.cell(row=r, column=6, value=opts[1][1])
                c2.font = BLUE
                c2.number_format = MONEY
                g = ws.cell(row=r, column=7, value=f"=IF(OR($D{r}=\"\",$F{r}=\"\"),\"\",$F{r}-$D{r})")
                g.font = BLACK
                g.number_format = MONEY
            for col in range(1, 8):
                ws.cell(row=r, column=col).border = BOX
            r += 1

    ws.column_dimensions["A"].width = 12
    ws.column_dimensions["B"].width = 8
    ws.column_dimensions["C"].width = 30
    ws.column_dimensions["D"].width = 12
    ws.column_dimensions["E"].width = 30
    ws.column_dimensions["F"].width = 12
    ws.column_dimensions["G"].width = 12
    ws.freeze_panes = "C5"
    return ws


def zone_lookup_sheet(wb):
    """The official UPS chart for origin 198, written into the workbook as
    lo/hi/zone rows so Excel can resolve a destination ZIP to a zone by itself.

    Why it is in the book at all: quoting by ZIP is the only way to be exact.
    Asking the person quoting to "pick a zone" just moves my old mistake onto
    them — five of the seven zones in the original pull were wrong precisely
    because a human assigned them by eye.

    Rows are the run-length ranges from scripts/ups-zone-chart-198.txt, sorted
    ascending on the low prefix, which is what MATCH(...,1) requires. Prefixes
    UPS does not list (military APO/FPO, some PO-box-only prefixes, Alaska and
    Hawaii on this chart) are simply absent: the lookup returns blank for them,
    never a nearest-neighbour guess.

    Returns (sheet_name, first_data_row, last_data_row).
    """
    chart = load_zone_chart()
    runs = []                       # [lo, hi, zone] collapsed from single prefixes
    for pre in sorted(chart, key=int):
        p, z = int(pre), chart[pre]
        if runs and runs[-1][2] == z and runs[-1][1] == p - 1:
            runs[-1][1] = p
        else:
            runs.append([p, p, z])

    ws = wb.create_sheet("Zone Lookup")
    ws["A1"] = "UPS ZONE CHART — origin ZIP 198xx (Wilmington, DE)"
    ws["A1"].font = TITLE
    ws["A2"] = ("Source: ups.com/media/us/currentrates/zone-csv/198.xls — "
                "'For shipments originating in ZIP Codes 198-01 to 198-99.' "
                "Not inferred from price. Do not hand-edit.")
    ws["A2"].font = Font(name=ARIAL, size=9, italic=True)
    ws["A3"] = ("Ground, 3 Day Select and 2nd Day Air share one zone on this chart — "
                "verified identical across all 903 mainland prefixes.")
    ws["A3"].font = Font(name=ARIAL, size=9, italic=True)

    for j, h in enumerate(["From prefix", "To prefix", "Zone"]):
        c = ws.cell(row=5, column=1 + j, value=h)
        c.font = BOLD
        c.fill = HDRFILL
        c.border = BOX
    first = 6
    for i, (lo, hi, z) in enumerate(runs):
        r = first + i
        ws.cell(row=r, column=1, value=lo).font = BLUE
        ws.cell(row=r, column=2, value=hi).font = BLUE
        ws.cell(row=r, column=3, value=z).font = BLUE
        for col in (1, 2, 3):
            ws.cell(row=r, column=col).border = BOX
    last = first + len(runs) - 1

    ws.cell(row=last + 2, column=1,
            value=f"{len(runs)} ranges covering {len(chart)} destination ZIP prefixes.").font = \
        Font(name=ARIAL, size=9, italic=True)
    for col, w in (("A", 12), ("B", 12), ("C", 8)):
        ws.column_dimensions[col].width = w
    ws.freeze_panes = "A6"
    return ws.title, first, last


def quote_sheet(wb, lad_first, lad_last, zl):
    """Quote calculator: destination ZIP + box -> customer price.

    Two things a weight x zone grid cannot do, both handled here:

      1. ZONE. The grid needs a zone number; a customer gives you a ZIP. This
         sheet reads the zone straight off the official UPS 198 chart on the
         'Zone Lookup' sheet, so nobody has to know or guess a zone.
      2. DIM WEIGHT. It changes WHICH WEIGHT ROW a shipment bills at, so it
         cannot be baked into the grid at all.

    Billable weight = the greater of actual weight and (L x W x H) / divisor,
    rounded up to the next whole pound. That is the same rule already printed on
    Ophir's existing UPS/FedEx rate card, which uses divisor 166.

    An unlisted ZIP or an out-of-range weight yields a BLANK price, never an
    estimate. `zl` is (sheet_name, first_row, last_row) from zone_lookup_sheet.
    """
    zl_name, zl_first, zl_last = zl
    Z_LO = f"'{zl_name}'!$A${zl_first}:$A${zl_last}"
    Z_HI = f"'{zl_name}'!$B${zl_first}:$B${zl_last}"
    Z_Z = f"'{zl_name}'!$C${zl_first}:$C${zl_last}"
    ws = wb.create_sheet("QUOTE CALCULATOR", 0)
    ws["A1"] = "QUOTE CALCULATOR — enter a real box, get the real price"
    ws["A1"].font = TITLE
    ws["A2"] = "Fill the YELLOW cells only. Everything else is a formula."
    ws["A2"].font = Font(name=ARIAL, size=9, italic=True)

    def lbl(row, text, note=""):
        c = ws.cell(row=row, column=1, value=text)
        c.font = BOLD
        if note:
            n = ws.cell(row=row, column=3, value=note)
            n.font = Font(name=ARIAL, size=9, italic=True)

    def inp(row, value, fmt=None):
        c = ws.cell(row=row, column=2, value=value)
        c.font = BLUE
        c.fill = YELLOW
        c.border = BOX
        if fmt:
            c.number_format = fmt
        return c

    def out(row, formula, fmt=None):
        c = ws.cell(row=row, column=2, value=formula)
        c.font = BLACK
        c.border = BOX
        if fmt:
            c.number_format = fmt
        return c

    ws.cell(row=4, column=1, value="INPUTS").font = BOLD
    lbl(5, "Destination ZIP", "The customer's ZIP. The zone is looked up for you — never type a zone.")
    inp(5, "60601")
    lbl(6, "Service", 'Pick from the drop-down: 2nd Day Air   OR   3 Day Select')
    inp(6, "2nd Day Air")
    dv = DataValidation(type="list", formula1='"2nd Day Air,3 Day Select"',
                        allow_blank=False, showDropDown=False)
    ws.add_data_validation(dv)
    dv.add("B6")
    lbl(7, "Actual weight (lb)", "What the scale says.")
    inp(7, 8)
    lbl(8, "Length (in)")
    inp(8, 12)
    lbl(9, "Width (in)")
    inp(9, 12)
    lbl(10, "Height (in)")
    inp(10, 12)
    lbl(11, "Dim divisor", "166 — CONFIRMED by Ophir Schultz 2026-09-03; matches Shipo's published UPS/FedEx rate card. Change to 139 if UPS applies the standard-card divisor to air services.")
    inp(11, 166)

    ws.cell(row=13, column=1, value="CALCULATED").font = BOLD
    lbl(14, "ZIP prefix", "First 3 digits — what the UPS chart is keyed on.")
    # Apple Numbers has no TEXT() function — it silently drops any formula that
    # uses one, which blanked this whole sheet on the first build. Ophir has
    # Numbers, not Excel, so the prefix is taken ARITHMETICALLY instead:
    # a 5-digit ZIP divided by 100 and truncated IS its 3-digit prefix, and it
    # stays correct for leading-zero ZIPs (07001 -> 7001 / 100 -> 70), because
    # the chart's own prefixes are stored as the same plain integers (070 -> 70).
    out(14, '=IFERROR(INT(VALUE(LEFT($B$5&"",5))/100),"")', "000")
    # MATCH(...,1) finds the last range starting at or below this prefix; the
    # <=hi test then rejects prefixes that fall in a GAP between ranges instead
    # of silently borrowing the zone of the range below them.
    mrow = f"MATCH($B$14,{Z_LO},1)"
    lbl(15, "ZONE (from UPS chart)", "Looked up on the 'Zone Lookup' sheet. Blank = UPS does not list that ZIP; do not quote it from this book.")
    zc = out(15, f'=IF($B$14="","",IFERROR(IF($B$14<=INDEX({Z_HI},{mrow}),'
                 f'INDEX({Z_Z},{mrow}),""),""))', "0")
    zc.font = BOLD
    zc.fill = HDRFILL
    lbl(16, "Cubic inches")
    out(16, "=B8*B9*B10", "#,##0")
    lbl(17, "Dim weight (lb)", "Rounded up to the next whole pound.")
    out(17, "=IF(B11=0,0,ROUNDUP(B16/B11,0))", "#,##0")
    lbl(18, "BILLABLE weight (lb)", "The greater of actual and dim. This is what UPS charges on.")
    b = out(18, "=MAX(ROUNDUP(B7,0),B17)", "#,##0")
    b.font = BOLD
    b.fill = HDRFILL

    lad_mk = f"'Markup Ladder'!$C${lad_first}:$C${lad_last}"
    lad_min = f"'Markup Ladder'!$A${lad_first}:$A${lad_last}"
    n = len(WEIGHTS)
    c2 = f"INDEX('Cost 2nd Day Air'!$B$5:$H${4+n},$B$18,$B$15-1)"
    c3 = f"INDEX('Cost 3 Day Select'!$B$5:$H${4+n},$B$18,$B$15-1)"
    # out of range, or a ZIP the chart does not cover -> blank, never a guess
    guard = (f'OR($B$15="",$B$18<1,$B$18>{n},'
             f'$B$15<{ZONES[0]},$B$15>{ZONES[-1]})')
    cost = f'IF({guard},"",IF($B$6="3 Day Select",{c3},{c2}))'

    ws.cell(row=20, column=1, value="RESULT").font = BOLD
    lbl(21, "Shipo's UPS cost", "Live ShipStation rate at the BILLABLE weight, in the looked-up zone.")
    out(21, f'=IFERROR(IF({cost}="","",{cost}),"")', MONEY)
    lbl(22, "Markup", "From the Markup Ladder sheet.")
    out(22, f'=IF($B$21="","",INDEX({lad_mk},MATCH($B$18,{lad_min},1)))', MONEY)
    lbl(23, "CUSTOMER PRICE", "What you quote the client.")
    p = out(23, '=IF($B$21="","",$B$21+$B$22)', MONEY)
    p.font = Font(name=ARIAL, size=12, bold=True)
    p.fill = YELLOW
    lbl(24, "Margin %", "Markup as a share of the price.")
    out(24, '=IF(OR($B$23="",$B$23=0),"",$B$22/$B$23)', "0.0%")

    r = 26
    for line in [
        "HOW THE ZONE IS FOUND",
        "  You type the customer's ZIP. Excel takes the first 3 digits and reads the zone",
        "  off the 'Zone Lookup' sheet — the official UPS chart for shipments leaving 198xx.",
        "  Nobody picks a zone by hand. If the ZONE cell comes back blank, UPS does not list",
        "  that prefix on this chart (military APO/FPO, Alaska, Hawaii): quote it from",
        "  ShipStation directly, do not estimate it.",
        "",
        "HOW BILLABLE WEIGHT WORKS",
        "  UPS charges on the GREATER of actual weight and dimensional weight.",
        "  Dim weight = (L x W x H) / divisor, rounded up to the next whole pound.",
        "  A 12x12x12 box at divisor 166 bills as 11 lb even if it weighs 3 lb.",
        "",
        "  The PRICE sheets are indexed by ACTUAL weight only. For any box that is",
        "  light for its size, use THIS sheet instead - the grid will under-quote it.",
        "",
        "  Divisor 166 — CONFIRMED by Ophir Schultz on 2026-09-03. It matches the divisor",
        "  already printed on Shipo's published UPS/FedEx rate card. If UPS ever applies",
        "  139 to air services on your account, change the divisor cell and everything",
        "  on this sheet re-prices itself.",
        "",
        "  Blank price = that weight/zone was not returned by ShipStation. See Gaps & Notes.",
        "  Nothing on this sheet is estimated or filled in by hand.",
    ]:
        ws.cell(row=r, column=1, value=line).font = Font(
            name=ARIAL, size=10, bold=line.isupper() and bool(line))
        r += 1

    ws.column_dimensions["A"].width = 24
    ws.column_dimensions["B"].width = 16
    ws.column_dimensions["C"].width = 95
    return ws


def customer_quote_sheet(wb, lad_first, lad_last, zl, meta, lines=15):
    """A QUOTE you can actually send: one row per box, priced, with a total.

    Same engine as the QUOTE CALCULATOR — same ZIP-to-zone chart, same billable
    weight rule, same ladder — just repeated down 15 rows so a customer shipping
    a mixed pallet gets one document instead of fifteen lookups.

    Only the white input columns are typed. Zone, billable weight, cost, markup
    and price are all formulas, so nothing on a quote can drift from the book.
    A row with no weight stays completely blank rather than pricing a 0 lb box.
    """
    zl_name, zl_first, zl_last = zl
    Z_LO = f"'{zl_name}'!$A${zl_first}:$A${zl_last}"
    Z_HI = f"'{zl_name}'!$B${zl_first}:$B${zl_last}"
    Z_Z = f"'{zl_name}'!$C${zl_first}:$C${zl_last}"
    lad_mk = f"'Markup Ladder'!$C${lad_first}:$C${lad_last}"
    lad_min = f"'Markup Ladder'!$A${lad_first}:$A${lad_last}"
    n = len(WEIGHTS)

    ws = wb.create_sheet("CUSTOMER QUOTE", 0)
    ws["A1"] = "SHIPO LLC — SHIPPING QUOTE"
    ws["A1"].font = Font(name=ARIAL, size=15, bold=True)
    ws["A2"] = "310 Cornell Dr, Wilmington, DE 19801  ·  302-442-2343  ·  shipousa.com"
    ws["A2"].font = Font(name=ARIAL, size=9)
    ws["A3"] = (f"UPS rates pulled live from ShipStation {str(meta.get('pulledAt',''))[:10]} · "
                f"carrier '{meta.get('carrier','')}' · residential · origin ZIP {meta.get('fromZip','')}")
    ws["A3"].font = Font(name=ARIAL, size=9, italic=True)

    ws["A5"] = "Customer"
    ws["A5"].font = BOLD
    c = ws["B5"]
    c.value = "(customer name)"
    c.font = BLUE
    c.fill = YELLOW
    ws["D5"] = "Quote date"
    ws["D5"].font = BOLD
    d = ws["E5"]
    d.value = "=TODAY()"
    d.font = BLACK
    d.number_format = "yyyy-mm-dd"
    ws["G5"] = "Valid 14 days — UPS rates and fuel change."
    ws["G5"].font = Font(name=ARIAL, size=9, italic=True)

    heads = ["#", "Dest ZIP", "Service", "Actual lb", "L in", "W in", "H in",
             "Zone", "Billable lb", "Shipo cost", "Markup", "PRICE"]
    hrow = 7
    for j, h in enumerate(heads):
        cell = ws.cell(row=hrow, column=1 + j, value=h)
        cell.font = BOLD
        cell.fill = HDRFILL
        cell.border = BOX
        cell.alignment = Alignment(horizontal="center", wrap_text=True)

    first = hrow + 1
    for i in range(lines):
        r = first + i
        ws.cell(row=r, column=1, value=i + 1).font = BOLD
        for col in range(2, 8):                     # B..G are typed
            cell = ws.cell(row=r, column=col)
            cell.font = BLUE
            cell.fill = YELLOW
            cell.border = BOX
        if i == 0:                                  # one worked example row
            for col, v in ((2, "60601"), (3, "2nd Day Air"),
                           (4, 8), (5, 12), (6, 12), (7, 12)):
                ws.cell(row=r, column=col, value=v)

        # No TEXT() — see the note on the QUOTE CALCULATOR sheet. Numbers drops it.
        pre = f'IFERROR(INT(VALUE(LEFT($B{r}&"",5))/100),"")'
        mrow = f"MATCH({pre},{Z_LO},1)"
        zone = (f'=IF($B{r}="","",IFERROR(IF({pre}<=INDEX({Z_HI},{mrow}),'
                f'INDEX({Z_Z},{mrow}),""),""))')
        ws.cell(row=r, column=8, value=zone).number_format = "0"

        bill = (f'=IF($D{r}="","",MAX(ROUNDUP($D{r},0),'
                f'IF(OR($E{r}="",$F{r}="",$G{r}=""),0,'
                f"ROUNDUP($E{r}*$F{r}*$G{r}/'QUOTE CALCULATOR'!$B$11,0))))")
        ws.cell(row=r, column=9, value=bill).number_format = "#,##0"

        c2 = f"INDEX('Cost 2nd Day Air'!$B$5:$H${4+n},$I{r},$H{r}-1)"
        c3 = f"INDEX('Cost 3 Day Select'!$B$5:$H${4+n},$I{r},$H{r}-1)"
        guard = (f'OR($H{r}="",$I{r}="",$I{r}<1,$I{r}>{n},'
                 f'$H{r}<{ZONES[0]},$H{r}>{ZONES[-1]})')
        cost = f'IF({guard},"",IF($C{r}="3 Day Select",{c3},{c2}))'
        ws.cell(row=r, column=10, value=f'=IFERROR(IF({cost}="","",{cost}),"")').number_format = MONEY
        ws.cell(row=r, column=11,
                value=f'=IF($J{r}="","",INDEX({lad_mk},MATCH($I{r},{lad_min},1)))').number_format = MONEY
        p = ws.cell(row=r, column=12, value=f'=IF($J{r}="","",$J{r}+$K{r})')
        p.number_format = MONEY
        p.font = BOLD
        for col in range(8, 13):
            ws.cell(row=r, column=col).border = BOX

    # Drop-down, not free text. A typo in the service column would silently fall
    # through to the 2nd Day Air price and nobody would ever see it.
    dv = DataValidation(type="list", formula1='"2nd Day Air,3 Day Select"',
                        allow_blank=True, showDropDown=False)
    ws.add_data_validation(dv)
    dv.add(f"C{first}:C{first + lines - 1}")

    last = first + lines - 1
    tr = last + 1
    ws.cell(row=tr, column=9, value="TOTAL").font = BOLD
    for col, rng in ((10, "J"), (11, "K"), (12, "L")):
        c = ws.cell(row=tr, column=col, value=f"=SUM({rng}{first}:{rng}{last})")
        c.number_format = MONEY
        c.font = BOLD
        c.fill = HDRFILL
        c.border = BOX
    ws.cell(row=tr + 1, column=9, value="Margin %").font = BOLD
    c = ws.cell(row=tr + 1, column=12,
                value=f'=IF($L{tr}=0,"",$K{tr}/$L{tr})')
    c.number_format = "0.0%"
    c.font = BOLD

    r = tr + 3
    for line in [
        "HOW TO USE THIS QUOTE",
        "  Type only the yellow columns: destination ZIP, service, actual weight, and the box L x W x H.",
        "  Zone, billable weight, cost and price fill themselves in. Delete the example in row 8.",
        "  Service must read exactly '2nd Day Air' or '3 Day Select'.",
        "",
        "  Blank PRICE means one of three things, all of them deliberate:",
        "    • no weight typed yet;",
        "    • UPS does not list that ZIP prefix on the origin-198 chart (APO/FPO, AK, HI);",
        "    • that zone/weight was not returned by ShipStation — see 'Gaps & Notes'.",
        "  In every case the cell stays empty. Nothing here is estimated.",
        "",
        "  Prices are RESIDENTIAL delivery and exclude: additional handling, oversize, peak-season",
        "  surcharges, address corrections, and Saturday delivery. Fuel is already inside the cost.",
        "  The dim divisor lives in one place — 'QUOTE CALCULATOR' cell B11 (currently 166).",
    ]:
        ws.cell(row=r, column=1, value=line).font = Font(
            name=ARIAL, size=10, bold=line.isupper() and bool(line))
        r += 1

    widths = {"A": 5, "B": 11, "C": 15, "D": 10, "E": 7, "F": 7, "G": 7,
              "H": 8, "I": 11, "J": 12, "K": 10, "L": 12}
    for col, w in widths.items():
        ws.column_dimensions[col].width = w
    ws.freeze_panes = f"A{first}"
    return ws


def main():
    data = load()
    rows = data["rows"]
    meta = {
        "pulledAt": data.get("pulledAt", ""),
        "carrier": data.get("carrier", ""),
        "primaryAccount": data.get("primaryAccount", "(unknown)"),
        "fromZip": data.get("fromZip", ""),
        "residential": data.get("residential", ""),
    }

    # ---- ZONE TRUTH ---------------------------------------------------------
    # Do this before ANY sheet is built. The zone number that came back with each
    # quote was written by hand in the puller and five of seven were wrong; the
    # published UPS chart for origin 198 is the only authority. Rows whose ZIP the
    # chart does not cover are dropped rather than guessed.
    rows, zrep = apply_zone_chart(rows)
    print(f"zone chart: {zrep['chart_size']} dest prefixes loaded")
    for (city, was, now), pre in sorted(zrep["changed"].items(), key=lambda kv: str(kv[0])):
        print(f"  RE-ZONED {city} ({pre}): zone {was} -> {now}")
    for city, pre in sorted(zrep["unmapped"].items()):
        print(f"  DROPPED {city} ({pre}): not in the UPS 198 chart")
    have = sorted({r["zone"] for r in rows})
    missing_z = [z for z in ZONES if z not in have]
    if missing_z:
        print(f"  WARNING: no quotes at all for zone(s) {missing_z} — "
              f"those columns will be blank and listed on Gaps & Notes.")

    carriers = sorted({r.get("carrier") for r in rows if r.get("carrier")})
    baseline = pick_baseline(rows)
    meta["carrier"] = baseline or meta["carrier"]

    # Every UPS product ShipStation actually returned, not a hardcoded shortlist.
    services = discover_services(rows, baseline)

    # The two headline 2-3 day products keep FIXED sheet names, because the
    # QUOTE CALCULATOR formulas reference them by name. Resolved EXACTLY, so
    # '2nd Day Air A.M.' can never leak into the standard 2nd Day Air card.
    svc2 = resolve_service(services, "2nd day air")
    svc3 = resolve_service(services, "3 day select")
    c2 = service_costs(rows, svc2, baseline) if svc2 else {}
    c3 = service_costs(rows, svc3, baseline) if svc3 else {}

    wb = Workbook()
    wb.remove(wb.active)

    lad_first, lad_last = ladder_sheet(wb)
    cost_sheet(wb, "Cost 2nd Day Air", c2, meta)
    cost_sheet(wb, "Cost 3 Day Select", c3, meta)
    price_sheet(wb, "PRICE 2nd Day Air", "Cost 2nd Day Air", lad_first, lad_last)
    price_sheet(wb, "PRICE 3 Day Select", "Cost 3 Day Select", lad_first, lad_last)
    margin_sheet(wb, "Margin % 2nd Day Air", "PRICE 2nd Day Air")
    margin_sheet(wb, "Margin % 3 Day Select", "PRICE 3 Day Select")

    # ...then a Cost + PRICE pair for EVERY other UPS service in the pull.
    used = {"Cost 2nd Day Air", "Cost 3 Day Select",
            "PRICE 2nd Day Air", "PRICE 3 Day Select"}
    headline = {s for s in (svc2, svc3) if s}
    per_service = []          # [(service name, costs dict)] for gaps + CSV
    for svc in services:
        if svc in headline:
            continue          # already built above under its fixed name
        costs = service_costs(rows, svc, baseline)
        if not costs:
            continue
        cname = safe_sheet_name("Cost", svc, used)
        pname = safe_sheet_name("PRICE", svc, used)
        cost_sheet(wb, cname, costs, meta)
        price_sheet(wb, pname, cname, lad_first, lad_last)
        per_service.append((svc, costs))

    if len(carriers) > 1:
        if svc2:
            comparison_sheet(wb, rows, carriers, svc2, "Compare Accts 2nd Day")
        if svc3:
            comparison_sheet(wb, rows, carriers, svc3, "Compare Accts 3 Day")

    # cross-service views
    if services:
        cheapest_service_sheet(wb, rows, services, baseline)
        zone_surcharge_sheet(wb, rows, services, baseline)
        service_summary_sheet(wb, rows, services, baseline, meta)   # inserted at 0
    # The zone chart has to exist as a sheet before anything can point at it.
    zl = zone_lookup_sheet(wb)
    quote_sheet(wb, lad_first, lad_last, zl)       # inserted first; needs the cost sheets
    customer_quote_sheet(wb, lad_first, lad_last, zl, meta)   # ...and lands in front of it

    # gaps: any zone/weight ShipStation did not return, for EVERY service
    ws = wb.create_sheet("Gaps & Notes")
    ws["A1"] = "Missing quotes — these cells were left BLANK, never guessed"
    ws["A1"].font = TITLE
    r = 3
    gap_targets = [(svc2 or "UPS 2nd Day Air", c2),
                   (svc3 or "UPS 3 Day Select", c3)] + per_service
    for label, costs in gap_targets:
        missing = [(z, lb) for z in ZONES for lb in WEIGHTS if (z, lb) not in costs]
        ws.cell(row=r, column=1, value=f"{label}: {len(missing)} of {len(ZONES)*len(WEIGHTS)} missing").font = BOLD
        r += 1
        if missing:
            ws.cell(row=r, column=1, value="; ".join(f"z{z}/{lb}lb" for z, lb in missing[:80])).font = Font(name=ARIAL, size=9)
            r += 1
        r += 1
    for e in data.get("errors", [])[:40]:
        ws.cell(row=r, column=1, value=f"error zone {e.get('zone')} {e.get('lb')}lb: {str(e.get('error'))[:120]}").font = Font(name=ARIAL, size=9, color="FF0000")
        r += 1
    r += 1
    for line in [
        "HOW TO READ THIS BOOK",
        "  • 'Cost' sheets  = what Shipo pays UPS. Blue = pulled live from ShipStation, not typed by hand.",
        "  • 'PRICE' sheets = what the client pays. Every cell is a formula: cost + markup.",
        "  • 'Markup Ladder' = the only sheet to edit. Yellow cells drive all pricing.",
        "",
        "CAVEATS — read before quoting",
        "  • Residential rates. Commercial delivery is cheaper; these prices are safe (slightly high) for B2B.",
        "  • No dimensional weight applied. A light-but-bulky box bills on dim weight and will cost MORE.",
        "    UPS air/3-day dim divisor is 139 on the standard card, 166 on the DAP/walleted card.",
        "  • No fuel surcharge drift, no residential/DAS surcharge changes, no peak surcharges modelled.",
        "  • Zones come from the OFFICIAL UPS chart for origin 198 (scripts/ups-zone-chart-198.txt,",
        "    from ups.com/media/us/currentrates/zone-csv/198.xls). They are NOT inferred from price.",
        "    Cross-checked: cities the chart puts in the same zone returned identical base rates at",
        "    all 50 weights (Philadelphia=New York Zone 2; Atlanta=Dallas Zone 6).",
        "  • Within a zone the BASE rate is fixed but SURCHARGES are not — New York costs ~$8.53/parcel",
        "    more than Philadelphia on the same Zone 2 base. The card uses the HIGHEST city in each zone",
        "    so it never under-prices. See the 'Zone Surcharges' sheet before quoting a dense metro.",
        "  • Rates move. Re-run scripts/ss-ups-rates.mjs to refresh.",
    ]:
        ws.cell(row=r, column=1, value=line).font = Font(name=ARIAL, size=10, bold=line.isupper())
        r += 1
    ws.column_dimensions["A"].width = 120

    for sheet in wb.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                if cell.font and cell.font.name != ARIAL:
                    cell.font = Font(name=ARIAL, size=cell.font.size or 10,
                                     bold=cell.font.bold, italic=cell.font.italic,
                                     color=cell.font.color)

    wb.save(XLSX)

    # Plain-text mirror of the same numbers, so the table can be read/printed
    # without Excel. Computed with the SAME ladder lookup Excel uses.
    def markup_for(lb):
        for lo, hi, mk in LADDER:
            if lo <= lb <= hi:
                return mk
        return None

    csv_path = os.path.join(OUT, "price-list.csv")
    with open(csv_path, "w") as f:
        f.write("service,weight_lb,zone,ups_cost,markup,customer_price,margin_pct\n")
        for label, costs in gap_targets:
            for lb in WEIGHTS:
                mk = markup_for(lb)
                for z in ZONES:
                    cost = costs.get((z, lb))
                    if cost is None:
                        f.write(f"{label},{lb},{z},,,,\n")
                        continue
                    price = round(cost + mk, 2)
                    f.write(f"{label},{lb},{z},{cost:.2f},{mk:.2f},{price:.2f},"
                            f"{(mk / price * 100):.1f}\n")
    print("wrote", csv_path)
    print("wrote", XLSX)
    print("UPS accounts quoted:", ", ".join(carriers) or "(single/unknown)")
    print("price card built from:", baseline or "(single/unknown)")
    print("UPS services found:", len(services))
    for label, costs in gap_targets:
        print(f"  {label}: {len(costs)} of {len(ZONES)*len(WEIGHTS)} quotes")


if __name__ == "__main__":
    main()
