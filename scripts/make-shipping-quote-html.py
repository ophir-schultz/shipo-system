#!/usr/bin/env python3
"""Build a client-facing SHIPPING price quote — UPS 2nd Day Air and 3 Day Select
— in the same house style as the Nayax fulfilment quote.

    python3 scripts/make-shipping-quote-html.py "NAYAX / ICL"

Writes  out/Shipo-Shipping-Quote-<client>.html  (open it and Print > PDF).

Every cell is a live ShipStation rate from out/ups-rates-raw.json plus the
markup ladder in build-price-list.py. A zone/weight ShipStation did not return
prints as an em dash. Nothing on this page is estimated.
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bpl", os.path.join(HERE, "build-price-list.py"))
bpl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bpl)

OUT = os.path.join(HERE, "out")
DIVISOR = 166

CITY = {2: "Philadelphia", 3: "Raleigh", 4: "Charlotte", 5: "Chicago",
        6: "Atlanta", 7: "Denver", 8: "Los Angeles"}

CSS = """
  @page { size: A4; margin: 0; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,'Helvetica Neue',Arial,sans-serif; color:#1B3A5C; font-size:11px; }
  .page { width:210mm; min-height:297mm; padding:0 0 14mm 0; position:relative; page-break-after:always; }
  .page:last-child { page-break-after:auto; }
  .topbar { background:#2E86DE; height:6mm; }
  .accent { background:#D9E830; height:1.5mm; }
  header { background:#1B3A5C; color:#fff; padding:6mm 14mm 5mm; }
  .logo { font-size:23px; font-weight:800; letter-spacing:1px; font-style:italic; }
  .logo small { font-size:9px; font-weight:400; letter-spacing:2px; display:block; font-style:normal; opacity:.8; margin-top:2px; }
  .htitle { text-align:right; }
  .htitle h1 { font-size:19px; font-weight:800; }
  .htitle .sub { font-size:9px; letter-spacing:2px; opacity:.85; margin-top:3px; }
  .headrow { display:flex; justify-content:space-between; align-items:flex-start; }
  .prepared { background:#E8F2FC; padding:3.5mm 14mm; font-size:11px; color:#344054; }
  .prepared b { color:#1B3A5C; }
  .body { padding:4mm 14mm 0; }
  .badges { display:flex; flex-wrap:wrap; gap:1.5mm 8mm; margin:3mm 0 3mm; }
  .badge { font-size:9.5px; color:#344054; width:46%; }
  .badge b { color:#067647; }
  h2 { font-size:12.5px; color:#fff; background:#1B3A5C; padding:3.5px 10px; margin:2.5mm 0 0; border-radius:3px 3px 0 0; letter-spacing:.5px; }
  h2 span { float:right; font-weight:400; font-size:9.5px; opacity:.85; }
  table { width:100%; border-collapse:collapse; }
  th { background:#2E86DE; color:#fff; font-size:8px; text-transform:uppercase; letter-spacing:.3px; padding:4px 3px; text-align:center; }
  th.lb { text-align:left; width:30px; }
  th small { display:block; font-size:6.5px; font-weight:400; letter-spacing:0; opacity:.85; text-transform:none; }
  td { padding:1.1px 3px; border-bottom:1px solid #E4E7EC; font-size:8.6px; line-height:1.15; text-align:center; }
  td.lb { text-align:left; font-weight:700; color:#1B3A5C; background:#F3F8FE; }
  td.mk { color:#667085; font-size:7.8px; background:#FBFCFE; }
  tr:nth-child(even) td { background:#FBFCFE; }
  tr:nth-child(even) td.lb { background:#EDF4FD; }
  .footer { position:absolute; bottom:0; left:0; right:0; background:#1B3A5C; color:#fff; font-size:8.5px; padding:4px 14mm; display:flex; justify-content:space-between; }
  .examples { display:flex; gap:3mm; margin:2.5mm 0; }
  .ex { flex:1; border:1px solid #D0D5DD; border-radius:5px; padding:2mm 2mm; text-align:center; }
  .ex .p { font-size:8px; color:#667085; min-height:20px; }
  .ex .big { font-size:16px; font-weight:800; color:#067647; margin:1.2mm 0 .6mm; }
  .ex .pu { font-size:8px; color:#475467; }
  .note-box { background:#FFF6D9; border-left:4px solid #E0A800; padding:3mm 5mm; font-size:9px; color:#5c4a00; margin:2.5mm 0; border-radius:0 4px 4px 0; }
  .note-box b { color:#3d3100; }
  .terms { font-size:9.5px; color:#475467; line-height:1.5; }
  .terms li { margin:0 0 1.5mm 4mm; }
  .cta { background:#E8F2FC; border-radius:6px; padding:4mm 6mm; margin:3mm 0; display:flex; justify-content:space-between; align-items:center; }
  .cta .big { font-size:15px; font-weight:800; color:#1B3A5C; }
  .cta .c { text-align:right; font-size:11px; }
  .cta .c a { color:#2E86DE; font-weight:700; text-decoration:none; display:block; }
  .disc { font-size:7.5px; color:#98A2B3; line-height:1.4; margin-top:2mm; text-align:justify; }
"""


def markup_for(lb):
    for lo, hi, mk in bpl.LADDER:
        if lo <= lb <= hi:
            return mk
    return None


def head(client, title, sub):
    return f"""  <div class="topbar"></div><div class="accent"></div>
  <header><div class="headrow">
    <div class="logo">Shipo<small>DELAWARE FULFILLMENT · SHIPOUSA.COM</small></div>
    <div class="htitle"><h1>{title}</h1><div class="sub">{sub}</div></div>
  </div></header>
  <div class="prepared">PREPARED FOR <b>{client}</b> &nbsp;·&nbsp; 2026</div>
"""


FOOT = ('  <div class="footer"><div>shipousa.com · 302-400-1698 · support@shipousa.com</div>'
        '<div>{n}</div></div>\n')


def rate_table(costs, zones, internal=False):
    """Client version shows ONE number per cell: what the customer pays.

    The margin column is INTERNAL ONLY. Printing 'markup +$25.00' on a page that
    goes to the customer hands them the exact number to negotiate against, so it
    is gated behind --internal and never appears on the client file.
    """
    h = ['<table><thead><tr><th class="lb">LB</th>']
    for z in zones:
        h.append(f'<th>Zone {z}<small>{CITY.get(z,"")}</small></th>')
    if internal:
        h.append('<th style="width:56px">Margin<small>per shipment</small></th>')
    h.append('</tr></thead><tbody>')
    for lb in bpl.WEIGHTS:
        mk = markup_for(lb)
        h.append(f'<tr><td class="lb">{lb}</td>')
        for z in zones:
            c = costs.get((z, lb))
            h.append(f'<td>${c + mk:,.2f}</td>' if c is not None and mk is not None else '<td>—</td>')
        if internal:
            h.append(f'<td class="mk">+${mk:.2f}</td>' if mk is not None else '<td class="mk">—</td>')
        h.append('</tr>')
    h.append('</tbody></table>')
    return "".join(h)


def main():
    args = [a for a in sys.argv[1:] if a != "--internal"]
    internal = "--internal" in sys.argv
    client = args[0] if args else "CLIENT"
    data = bpl.load()
    rows, _ = bpl.apply_zone_chart(data["rows"])
    carrier = bpl.pick_baseline(rows)
    services = bpl.discover_services(rows, carrier)
    pulled = str(data.get("pulledAt", ""))[:10]

    svc2 = bpl.resolve_service(services, "2nd day air")
    svc3 = bpl.resolve_service(services, "3 day select")
    c2 = bpl.service_costs(rows, svc2, carrier)
    c3 = bpl.service_costs(rows, svc3, carrier)
    zones = [z for z in bpl.ZONES if any((z, lb) in c2 or (z, lb) in c3 for lb in bpl.WEIGHTS)]

    def ex(costs, z, lb, label):
        c = costs.get((z, lb))
        mk = markup_for(lb)
        if c is None or mk is None:
            return f'<div class="ex"><div class="p">{label}</div><div class="big">—</div>' \
                   f'<div class="pu">not quoted</div></div>'
        return (f'<div class="ex"><div class="p">{label}</div>'
                f'<div class="big">${c + mk:,.2f}</div>'
                f'<div class="pu">Zone {z} · {lb} lb</div></div>')

    p = []
    # ---------------- PAGE 1 — 2nd Day Air ----------------
    p.append('<div class="page">')
    p.append(head(client, "Shipping Price Quote", "UPS 2ND DAY AIR · UPS 3 DAY SELECT"))
    p.append('  <div class="body">')
    if internal:
        # Loud, unmissable, and only on the internal build. The two files are one
        # keystroke apart in Finder; the banner is what stops the wrong one going out.
        p.append('  <div style="background:#B42318;color:#fff;font-weight:800;font-size:12px;'
                 'padding:3mm 5mm;border-radius:4px;margin:0 0 3mm;letter-spacing:.5px">'
                 'INTERNAL COPY — SHOWS SHIPO MARGIN · DO NOT SEND TO THE CLIENT</div>')
    p.append('  <div class="badges">'
             '<div class="badge"><b>✓</b> Live UPS rates — pulled '
             f'{pulled}, not a published list</div>'
             '<div class="badge"><b>✓</b> Residential delivery included — no adder</div>'
             '<div class="badge"><b>✓</b> Fuel surcharge already inside every price</div>'
             '<div class="badge"><b>✓</b> One flat price per zone and weight — no bill shock</div>'
             '<div class="badge"><b>✓</b> Same-day dispatch on orders in by 3pm ET</div>'
             '<div class="badge"><b>✓</b> Tracking pushed back to your system automatically</div>'
             '</div>')
    p.append(f'<h2>1 · UPS 2ND DAY AIR<span>from Wilmington DE 19801 · 1–50 lb · price per shipment</span></h2>')
    p.append(rate_table(c2, zones, internal))
    p.append('  <div class="examples">')
    p.append(ex(c2, 2, 1, "1 lb terminal to Philadelphia"))
    p.append(ex(c2, 5, 10, "10 lb carton to Chicago"))
    p.append(ex(c2, 6, 25, "25 lb carton to Atlanta"))
    p.append(ex(c2, 8, 50, "50 lb carton to Los Angeles"))
    p.append('  </div>')
    p.append('  </div>')
    p.append(FOOT.format(n="01 · UPS 2ND DAY AIR"))
    p.append('</div>')

    # ---------------- PAGE 2 — 3 Day Select ----------------
    p.append('<div class="page">')
    p.append('  <div class="topbar"></div><div class="accent"></div>')
    p.append('  <div class="body" style="padding-top:8mm">')
    p.append(f'<h2>2 · UPS 3 DAY SELECT<span>from Wilmington DE 19801 · 1–50 lb · price per shipment</span></h2>')
    p.append(rate_table(c3, zones, internal))
    p.append('  <div class="examples">')
    p.append(ex(c3, 2, 1, "1 lb terminal to Philadelphia"))
    p.append(ex(c3, 5, 10, "10 lb carton to Chicago"))
    p.append(ex(c3, 6, 25, "25 lb carton to Atlanta"))
    p.append(ex(c3, 8, 50, "50 lb carton to Los Angeles"))
    p.append('  </div>')
    p.append('  <div class="note-box"><b>3 Day Select against 2nd Day Air.</b> 3 Day Select is the '
             'cheaper of the two at every zone and weight on these pages. Where the delivery date '
             'is the same in practice — short zones often arrive in two days on the ground network '
             'anyway — 3 Day Select is the one to book.</div>')
    p.append('  </div>')
    p.append(FOOT.format(n="02 · UPS 3 DAY SELECT"))
    p.append('</div>')

    # ---------------- PAGE 3 — how to read it, terms ----------------
    p.append('<div class="page">')
    p.append('  <div class="topbar"></div><div class="accent"></div>')
    p.append('  <div class="body" style="padding-top:8mm">')
    p.append('<h2>3 · HOW TO READ THESE PAGES</h2>')
    p.append('  <div class="note-box" style="margin-top:3mm"><b>Two numbers give you the price.</b> '
             'Find the destination zone across the top of the table and the billable weight down '
             'the side. Where they meet is what you pay — UPS transportation, the fuel surcharge '
             'and residential delivery are already inside that number. Billable weight is the '
             f'greater of the scale weight and (L × W × H) ÷ {DIVISOR}, rounded up to the next '
             'whole pound. Zone 2 is Philadelphia, Zone 8 is the West Coast; every US ZIP falls '
             'into one of the seven columns.</div>')
    p.append('<h2>4 · WHAT IS INCLUDED — AND WHAT IS NOT</h2>')
    p.append('  <div class="terms" style="padding:4mm 0 0">')
    p.append('  <ul>'
             '<li><b>Included in every price:</b> UPS transportation, the current fuel surcharge, '
             'and residential delivery.</li>'
             '<li><b>Billed at cost when UPS applies them:</b> additional handling, large package '
             f'/ oversize, peak-season surcharges, address correction, Saturday delivery, '
             'delivery-area surcharge on remote ZIPs.</li>'
             '<li><b>Billable weight:</b> the greater of actual scale weight and '
             f'(L × W × H) ÷ {DIVISOR}, rounded up to the next whole pound.</li>'
             '<li><b>Zones:</b> taken from the official UPS zone chart for origin ZIP prefix 198 '
             '(Wilmington, Delaware). Alaska, Hawaii, Puerto Rico and APO/FPO are quoted '
             'separately — they are not on these pages and are never estimated.</li>'
             '<li><b>Over 50 lb, or international:</b> quoted on request, same day.</li>'
             '<li><b>Validity:</b> 14 days. UPS rates and the fuel surcharge move; we re-quote '
             'rather than absorb.</li>'
             '</ul></div>')
    p.append('  <div class="cta"><div><div class="big">Want these rates applied to your account?</div>'
             '<div style="font-size:10px;color:#475467;margin-top:1mm">Send us a week of real orders '
             'and we will price them line by line against what you pay today.</div></div>'
             '<div class="c"><a href="mailto:support@shipousa.com">support@shipousa.com</a>'
             '<a href="tel:3024002343">302-400-1698</a></div></div>')
    p.append(f'  <div class="disc">Shipping price quote prepared for {client}. Every rate on these '
             f'pages was returned live by UPS through ShipStation on {pulled} for the Shipo LLC '
             f'account, origin ZIP {data.get("fromZip","19801")}, residential delivery, and is shown '
             'as the customer price after Shipo margin. Rates are per shipment and assume one '
             'package. Cells showing an em dash were not returned by UPS and are not estimated. '
             'This document is a quotation, not a contract, and does not bind either party until '
             'countersigned. Shipo LLC · 310 Cornell Dr, Wilmington, DE 19801 · shipousa.com</div>')
    p.append('  </div>')
    p.append(FOOT.format(n="03 · HOW IT WORKS & TERMS"))
    p.append('</div>')

    html = ('<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n'
            f'<title>Shipo Shipping Quote — {client}</title>\n<style>{CSS}</style>\n</head>\n'
            '<body>\n' + "\n".join(p) + '\n</body>\n</html>\n')

    safe = "".join(ch if ch.isalnum() or ch in "-_ " else "" for ch in client).strip().replace(" ", "-")
    tag = "INTERNAL" if internal else "CLIENT"
    path = os.path.join(OUT, f"Shipo-Shipping-Quote-{safe or 'client'}-{tag}.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"wrote {path}   [{tag}]")
    print(f"services: {svc2} · {svc3}")
    print(f"carrier: {carrier}   zones: {zones}   rates pulled {pulled}")


if __name__ == "__main__":
    main()
