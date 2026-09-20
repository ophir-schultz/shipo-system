#!/usr/bin/env python3
"""Print the customer price table to the terminal — the same numbers the Excel
book contains, in a form you can read without opening Excel.

Zones are taken from the official UPS chart for origin 198, exactly as the
workbook does, by importing the builder rather than re-implementing the logic.
If the two ever disagree, that is a bug, not a rounding difference.

Usage:  python3 scripts/show-price-table.py ["UPS 2nd Day Air®"] [carrier]
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bpl", os.path.join(HERE, "build-price-list.py"))
bpl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bpl)

data = bpl.load()
rows, rep = bpl.apply_zone_chart(data["rows"])
print(f"UPS account: {data.get('primaryAccount', '(unknown)')}")
print(f"pulled: {data.get('pulledAt', '?')[:19]}   topped up: {str(data.get('toppedUpAt'))[:19]}")
for (city, was, now), pre in sorted(rep["changed"].items(), key=lambda kv: str(kv[0])):
    print(f"  RE-ZONED {city} ({pre}): pull said zone {was}, UPS says {now}")

carrier = sys.argv[2] if len(sys.argv) > 2 else bpl.pick_baseline(rows)
services = bpl.discover_services(rows, carrier)
want = sys.argv[1] if len(sys.argv) > 1 else None
targets = [s for s in services if s == want] if want else [
    s for s in (bpl.resolve_service(services, "2nd day air"),
                bpl.resolve_service(services, "3 day select")) if s]

# Which city ended up representing each zone, so the header can name it.
rep_city = {}
for r in rows:
    if r.get("carrier") != carrier:
        continue
    z = r["zone"]
    prev = rep_city.get(z)
    if prev is None or r["totalCost"] > prev[1]:
        rep_city[z] = (r.get("destCity"), r["totalCost"])


def markup_for(lb):
    for lo, hi, mk in bpl.LADDER:
        if lo <= lb <= hi:
            return mk
    return bpl.LADDER[-1][2]


for svc in targets:
    costs = bpl.service_costs(rows, svc, carrier)
    zones = [z for z in bpl.ZONES if any((z, lb) in costs for lb in bpl.WEIGHTS)]
    missing = [z for z in bpl.ZONES if z not in zones]
    print("\n" + "=" * 78)
    print(f"{svc}   —   carrier '{carrier}'")
    print("CUSTOMER PRICE = UPS cost + markup ladder "
          f"(${bpl.LADDER[0][2]:,.0f} at {bpl.LADDER[0][0]} lb, rising to "
          f"${bpl.LADDER[-1][2]:,.0f} at {bpl.LADDER[-1][1]} lb)")
    if missing:
        print(f"!! NO DATA for zone(s) {missing} — not quoted. Blank, never guessed.")
    print("=" * 78)
    print("     " + "".join(f"  Zone {z}" for z in zones) + "     markup")
    print("lb   " + "".join(f"{('(' + str(rep_city.get(z, ('?',))[0])[:6] + ')'):>8}" for z in zones))
    print("-" * 78)
    for lb in bpl.WEIGHTS:
        mk = markup_for(lb)
        cells = ""
        for z in zones:
            c = costs.get((z, lb))
            cells += f"{('$%.2f' % (c + mk)) if c is not None else '—':>8}"
        print(f"{lb:<4}{cells}   +${mk:.2f}")
