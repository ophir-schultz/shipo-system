# Shipo P&L — status

Branch: `cursor/shipo-pnl-4d1b`

Work is add-only. Migrations are files and are not applied. Nothing here is merged or deployed. Zenventory prices and shipousa.com are untouched.

| Step | Status | Reason |
| --- | --- | --- |
| Bug fixes (paging and payout read) | done | `/pnl` now pages `warehouse_daily_log`, `inbound_shipments`, `referral_payouts` and `clients` through `readAllPages` with `id` as the unique sort key. The old inbound `.limit(500)` and payout `.limit(200)` shortened totals, so they are not used for those reads. Partner payout detail treats a failed `referral_payouts` read as unreadable and does not show Paid as $0. |
| Nayax price-list rules | not started | Per-client price list model, upload, and the Nayax rates from the owner. |
| Sheet test | not started | Price every order on the May–Aug Nayax billing report and write the mismatch CSV. |
| Client report | not started | Same columns as the billing workbook, any date range, Excel and CSV download. |
| Profit view | not started | ShipStation cost and profit or loss per order and per client, read-only. |
| Finance approve / PDF | not started | Finance approves a report in the system, then downloads it, including PDF. The system does not email it. |
| Login | not started | Staff password login already exists (Supabase Auth in `src/proxy.ts` and `/login`). New pages must stay behind it. |
