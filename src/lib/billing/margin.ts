// Profit and margin from two incomplete sums, and the UNKNOWN cases the old
// expressions had no way to say.
//
// /pnl computed a per-client row like this:
//
//   const revenue = a.shipRev + a.whRev + a.inRev
//   const cost    = a.shipCost + a.inCost
//   const profit  = revenue - cost
//   const margin  = revenue > 0 ? (profit / revenue) * 100 : 0
//
// Every one of those five columns was a running total that skipped the figures
// it could not read and counted them separately, so a client whose figures were
// ALL withheld arrived here as five zeros. `0 - 0` is a profit of 0, and
// `revenue > 0 ? ... : 0` made that a margin of 0%, and 0% renders green. The
// amber count was on the row the whole time; it just sat beside four figures
// that each read as a decided, break-even zero. A client nobody has priced is
// not a client who broke even.
//
// This lives in a .ts module rather than in the page for a reason worth stating
// plainly, because the page already carries a note about it for `spend`: the
// type system cannot hold this rule. `margin: number | null` is satisfied just
// as well by a producer that never returns null, so reverting the ternary to
// `: 0` compiles cleanly. Verified by positive control -- of seven reversions
// probed against `npx tsc --noEmit` with the arithmetic inline in page.tsx,
// five compiled without a word, including returning `revSum.total` instead of
// `totalOrUnknown(revSum)` and taking `(cost ?? 0)`. What the compiler DOES
// hold is the rendering: `fmt(d.totalProfit)` is a type error and
// `c.margin.toFixed(0)` outside its null branch is a type error. So the
// rendering can stay in the page and the decision cannot, and vitest.config.ts
// excludes `.test.tsx`, which is what makes "in a .ts module" and "covered by
// tests" the same sentence.

import { totalOrUnknown, type PricedSum } from './unpriced'

/** The four figures of one P&L line, each UNKNOWN rather than 0 when unread. */
export interface PnlFigures {
  /** Total revenue, or null when every revenue figure was withheld. */
  revenue: number | null
  /** Total cost, or null when every cost figure was withheld. */
  cost: number | null
  /** revenue - cost, or null when either side is unknown. */
  profit: number | null
  /** Profit as a percentage of revenue, or null when it cannot be computed. */
  margin: number | null
  /** How many money figures across both sums could not be read. */
  unread: number
}

/**
 * One P&L line's revenue, cost, profit and margin.
 *
 * Taking PricedSums rather than numbers is the whole mechanism. A number cannot
 * say whether it is a total of zero or a total of nothing readable; a sum knows
 * how many figures it counted and how many of those it had to withhold, and
 * `totalOrUnknown` is what turns "counted some, read none" into null while
 * leaving "counted none" -- a client with no shipments at all -- as the real
 * $0.00 it is.
 *
 * `unread` is a count of FIGURES, not rows: one inbound line with neither
 * amount readable has withheld two numbers from this line's margin, and a note
 * saying "1 line not included" would understate what is missing.
 */
export function pnlFigures(revSum: PricedSum, costSum: PricedSum): PnlFigures {
  const revenue = totalOrUnknown(revSum)
  const cost = totalOrUnknown(costSum)
  // Not `revenue - (cost ?? 0)`. Subtracting a real cost from a revenue nobody
  // could read produces a loss equal to the whole cost, which looks like a
  // conservative estimate and is a fabricated one: the revenue might have
  // covered it twice over. The null check on `revenue` is also what narrows it
  // for the subtraction, so deleting either half is a compile error here even
  // though it was not one in the page.
  const profit = revenue === null || cost === null ? null : revenue - cost
  return {
    revenue,
    cost,
    profit,
    margin: marginOf(profit, revenue),
    unread: revSum.unpriced + costSum.unpriced,
  }
}

/**
 * Profit as a percentage of revenue, or null when there is no such percentage.
 *
 * Three different reasons to answer null, and the old expression answered 0 for
 * all three:
 *
 *   - the profit is unknown, so its ratio to anything is unknown;
 *   - the revenue is unknown, so there is nothing to take a percentage OF;
 *   - the revenue is a real 0, and a percentage of zero is undefined rather
 *     than zero. This is the one case where the behaviour on screen changes for
 *     data that was never broken: a client with genuinely no revenue and a real
 *     carrier cost used to show `0%` in red, and now shows a dash beside the
 *     real negative figure in the Profit column. 0% was never true of that
 *     client -- it lost the whole cost on no revenue -- and "cannot be
 *     computed" is what a dash says.
 */
export function marginOf(profit: number | null, revenue: number | null): number | null {
  if (profit === null || revenue === null || revenue <= 0) return null
  return (profit / revenue) * 100
}

/**
 * One client's fulfillment revenue as attributed to the campaign that won it.
 *
 * Three states where `(clientRevenue[c.id] ?? 0)` saw two, and the two it
 * collapsed are the ones that matter:
 *
 *   - ABSENT (undefined): the client has no shipment, warehouse or inbound rows
 *     at all, so it has genuinely contributed $0.00. That zero is attributed,
 *     and correctly drags the campaign's revenue down -- winning a client who
 *     never shipped is a real outcome and the campaign should wear it.
 *   - NULL: the client HAS rows and not one of their figures could be read. That
 *     is not revenue of zero and must not be summed as though it were.
 *   - a number: itself.
 *
 * Trivial as a line of code, and here rather than inline because `?? 0` reads
 * as the obvious tidy-up of it and would silently restore the defect: `??`
 * falls through on null as well as undefined, so the one case this function
 * exists to separate is exactly the one it would re-merge.
 */
export function attributedRevenue(revenue: number | null | undefined): number | null {
  return revenue === undefined ? 0 : revenue
}

/** What a campaign's spend bought, each figure UNKNOWN rather than flattering. */
export interface CampaignFigures {
  /** revenue - spend, or null when either is unknown. */
  profit: number | null
  /** Return on spend as a percentage, or null when it cannot be computed. */
  roi: number | null
  /** Spend per client won, or null when it cannot be computed. */
  cac: number | null
}

/**
 * A campaign's profit, ROI and cost per acquisition.
 *
 * These are the figures that decide where next month's budget goes, which is
 * why both inputs are nullable and both nulls propagate. The spend half was
 * fixed first: `(monthly ?? 0) + (one_time ?? 0)` made a campaign nobody had
 * costed into a campaign that cost nothing and then divided by it, producing an
 * infinite ROI printed as a tidy percentage and a CAC of $0.00 per client won.
 *
 * The revenue half is the same defect one table over. Attributed revenue is the
 * sum of the fulfillment revenue of every client tagged to the campaign, and
 * when those clients' revenue could not be read the sum used to arrive here as
 * 0 -- so a campaign with real spend and unreadable revenue reported a
 * confident ROI of -100%, "this campaign lost its entire budget", from figures
 * nobody had read. That is the most actionable wrong number on the page: it is
 * an argument for cancelling the campaign.
 *
 * CAC is deliberately still computed when revenue is unknown. It is spend per
 * client won and does not touch revenue, so withholding it would hide a figure
 * that is genuinely known.
 */
export function campaignFigures(
  revenue: number | null,
  spend: number | null,
  clientsWon: number,
): CampaignFigures {
  return {
    profit: revenue === null || spend === null ? null : revenue - spend,
    // `spend > 0` guards the division, and is not the same test as
    // `spend !== null`: a campaign with a real, entered spend of 0 has no
    // return-on-spend to report either, and 0 would be the wrong answer for a
    // different reason -- it is a division by zero, not a break-even.
    roi: revenue !== null && spend !== null && spend > 0
      ? ((revenue - spend) / spend) * 100
      : null,
    cac: spend !== null && clientsWon > 0 ? spend / clientsWon : null,
  }
}
