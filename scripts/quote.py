#!/usr/bin/env python3
"""Quote one box from the terminal. No Excel, no zone lookup in your head.

    python3 scripts/quote.py 60601 8
    python3 scripts/quote.py 60601 8 12x12x12
    python3 scripts/quote.py 60601 8 12x12x12 "2nd day air"

Prints every UPS service Shipo can actually quote for that ZIP and box, with
Shipo's cost, the markup from the ladder, and the customer price.

It imports build-price-list.py rather than re-implementing anything, so the
number printed here is by construction the number in the workbook. The zone
comes from the official UPS chart for origin 198 — scripts/ups-zone-chart-198.txt
— never from a guess, and never from the label the puller wrote.

If a ZIP prefix is not on that chart (APO/FPO, Alaska, Hawaii) or a zone/weight
was not returned by ShipStation, it says so and quotes nothing. A blank is
always better than an invented rate.
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bpl", os.path.join(HERE, "build-price-list.py"))
bpl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bpl)

DIVISOR = 166          # CONFIRMED by Ophir 2026-09-03; matches Shipo's printed card


def usage():
    print(__doc__.strip())
    sys.exit(1)


def markup_for(lb):
    for lo, hi, mk in bpl.LADDER:
        if lo <= lb <= hi:
            return mk
    return None


def main():
    if len(sys.argv) < 3:
        usage()
    zip_code = sys.argv[1].strip()
    try:
        actual = float(sys.argv[2])
    except ValueError:
        usage()

    dims = None
    want = None
    for arg in sys.argv[3:]:
        a = arg.strip().lower().replace(" ", "")
        if "x" in a and all(p.replace(".", "", 1).isdigit() for p in a.split("x")) \
                and len(a.split("x")) == 3:
            dims = [float(p) for p in a.split("x")]
        else:
            want = arg.strip()

    prefix = "".join(ch for ch in zip_code if ch.isdigit())[:3].zfill(3)
    chart = bpl.load_zone_chart()
    zone = chart.get(prefix)
    if zone is None:
        print(f"ZIP {zip_code} (prefix {prefix}) is NOT on the UPS origin-198 zone chart.")
        print("That covers APO/FPO, Alaska and Hawaii. Quote it in ShipStation directly —")
        print("this tool will not estimate a zone.")
        sys.exit(2)

    dim_lb = 0
    if dims:
        import math
        dim_lb = math.ceil(dims[0] * dims[1] * dims[2] / DIVISOR)
    billable = max(int(-(-actual // 1)), dim_lb)     # ceil(actual), then vs dim

    data = bpl.load()
    rows, _ = bpl.apply_zone_chart(data["rows"])
    carrier = bpl.pick_baseline(rows)
    services = bpl.discover_services(rows, carrier)
    if want:
        resolved = bpl.resolve_service(services, want)
        services = [resolved] if resolved else []
        if not services:
            print(f"No UPS service matching '{want}'. Available:")
            for s in bpl.discover_services(rows, carrier):
                print("   ", s)
            sys.exit(2)

    mk = markup_for(billable)
    print(f"Dest {zip_code}  ->  ZONE {zone}   (UPS chart for origin 198)")
    print(f"Actual {actual:g} lb" + (f"   dim {dims[0]:g}x{dims[1]:g}x{dims[2]:g} "
                                     f"/ {DIVISOR} = {dim_lb} lb" if dims else "   (no dims given)"))
    print(f"BILLABLE {billable} lb   markup +${mk:.2f}" if mk else
          f"BILLABLE {billable} lb   NO MARKUP DEFINED above 50 lb — not quotable here")
    print(f"carrier '{carrier}'   ·   rates pulled {str(data.get('pulledAt',''))[:10]}")
    print()
    print(f"{'service':<34}{'Shipo cost':>12}{'markup':>9}{'PRICE':>11}")
    print("-" * 66)
    any_row = False
    for svc in services:
        costs = bpl.service_costs(rows, svc, carrier)
        c = costs.get((zone, billable))
        if c is None or mk is None:
            print(f"{svc[:33]:<34}{'not quoted':>12}{'':>9}{'—':>11}")
            continue
        any_row = True
        print(f"{svc[:33]:<34}{'$%.2f' % c:>12}{'+$%.2f' % mk:>9}{'$%.2f' % (c + mk):>11}")
    if not any_row:
        print("\nNothing quotable at this zone/weight. See scripts/out/ups-rates-raw.json"
              " or the Gaps & Notes sheet — no price was invented to fill the hole.")


if __name__ == "__main__":
    main()
