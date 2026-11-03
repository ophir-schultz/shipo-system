# Shipo P&L — status

Branch: `cursor/shipo-pnl-4d1b`

Work is add-only. Migrations are files and are not applied. Nothing here is merged or deployed. Zenventory prices and shipousa.com are untouched.

| Step | Status | Reason |
| --- | --- | --- |
| Bug fixes (paging and payout read) | done | `/pnl` now pages `warehouse_daily_log`, `inbound_shipments`, `referral_payouts` and `clients` through `readAllPages` with `id` as the unique sort key. The old inbound `.limit(500)` and payout `.limit(200)` shortened totals, so they are not used for those reads. Partner payout detail treats a failed `referral_payouts` read as unreadable and does not show Paid as $0. |
| Nayax price-list rules | done | Price lists are JSON documents (`price-lists/nayax.json`), not rates in code. The engine prices devices as floor(units/20)×$1.50 plus the remainder×$0.32, accessories at $0.20, the listed box sizes, receiving, storage, labour, materials at cost+15%, and an 8% peak from Oct 15 to Jan 15 on warehouse fees. Shipping cells are the ICL card already in `supabase/nayax_icl_zone_rates_2026_10.sql`, with a schedule that divides by 1.03 before 2026-05-19. Upload is on the client page and only inserts. Migration file: `supabase/client_price_lists.sql` (not applied). |
| Sheet test | done | 1,315 orders with an order number (the workbook has 1,325 rows, including the title, header, month labels and subtotal rows). Pick matches 1,311. Box material matches 1,283. Shipping matches the ICL card on 1,180 of 1,247 orders on or after 2026-05-19, using the higher of scale weight and volume weight, one price per box. Before 2026-05-19, 57 of 68 match the same card divided by 1.03. Mismatches: `reports/nayax-reconciliation-mismatches.csv`. The prior note of about 1,076 post-May-19 matches is lower than this; volume weight explains the extra matches. |
| Client report | done | `/client-report` uses the existing sidebar and shell. Columns match the workbook, including the line breaks. Any date range, client filter, Excel and CSV download, and an import that only inserts. PDF and the approval gate are the next step. The page does not email. |
| Profit view | done | `/order-pnl` reads `shipments.actual_cost` (the cost the existing ShipStation sync already stored) and `client_rate`. Profit is client price minus that cost, per order and per client. A missing price or cost stays unknown. The page does not call ShipStation and does not write a rate. |
| Finance approve / PDF | done | Approve records a row in `client_report_approvals` for one client and one date range. Excel, CSV and PDF download only after that approval. The routes do not import mail and do not send the file. |
| Login | done | Staff password login was already Supabase Auth (`/login` and `src/proxy.ts`). It was left in place. `/client-report` and `/order-pnl` are inside that guard. New API routes call `requireStaff()` and are not public. |
| Preview type check | done | `ClientReportRow` now carries `clientId`, set from `client_billing_lines.client_id` when a row is built and left null on a sheet that has not been stored yet. `npm run build` completes TypeScript cleanly. |
