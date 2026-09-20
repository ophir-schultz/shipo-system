#!/bin/bash
# One command: pull LIVE UPS rates from ShipStation, then build the price list.
# Run it from anywhere:   bash ~/shipo-system/scripts/make-price-list.sh
#
# Step 1 takes about 20 minutes (350 quotes per usable UPS carrier code,
# throttled to stay under ShipStation's 40-requests-per-minute limit).
# Leave the window open. It saves progress every 10 quotes.
# Nothing is published, emailed or charged. Credentials are never printed.
set -e
cd "$HOME/shipo-system"

echo "=== STEP 1 of 3: pulling live UPS rates from ShipStation (~20 min) ==="
node scripts/ss-ups-rates.mjs

echo
echo "=== STEP 2 of 3: topping up any destination not yet quoted (~6 min) ==="
# No-op if the raw file already covers every destination. Exists so that adding a
# city to the DESTS list doesn't force another full 20-minute pull.
node scripts/ss-ups-topup.mjs

echo
echo "=== STEP 3 of 3: building the Excel price list ==="
# Zone numbers are re-read here from scripts/ups-zone-chart-198.txt — the official
# UPS chart for origin ZIP 198 — and overwrite whatever the pull recorded. Watch
# for "RE-ZONED" lines in the output: they mean the pull's label disagreed with UPS
# and UPS won.
python3 scripts/build-price-list.py

echo
echo "=== DONE ==="
ls -la "$HOME/shipo-system/scripts/out/"
echo
echo "To quote a single box without opening Excel:"
echo "  python3 ~/shipo-system/scripts/quote.py 60601 8 12x12x12"
echo "  (destination ZIP, actual weight in lb, box LxWxH in inches)"
