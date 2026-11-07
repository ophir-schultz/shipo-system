// What the Campaigns + P&L "Net Profit" card is, and what it is not.
//
// The card is shipping revenue minus carrier cost, plus warehouse revenue,
// plus inbound billed minus receiving cost. It is gross of warehouse labor.
// The dashboard year card is a different question: reconciled shipping
// margin only ($17,745.80 on the verified year). The gap is inbound,
// packing, and storage, not a broken subtraction.
//
// Unknown ledger amounts are excluded. They are not $0 and they are not
// client fees this page invented.

export const FULFILLMENT_PNL_BASIS =
  'Fulfillment net profit is shipment revenue minus carrier cost, plus warehouse revenue, plus inbound billed minus receiving cost. It is gross of warehouse labor. It is not the dashboard shipping margin. Unknown amounts are excluded, not counted as $0, and this is not a full ledger P&L.'

export const DASHBOARD_SHIPPING_BASIS =
  'Dashboard shipping margin is reconciled shipments only: client rate minus carrier cost, for rows where both are known. Unrated shipments are excluded. It does not include warehouse, inbound, packing, or storage.'
