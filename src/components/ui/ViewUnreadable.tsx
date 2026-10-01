/**
 * The one place this sentence is written.
 *
 * Every screen in this app has an empty state, and an empty state is a CLAIM:
 * "we looked, and there is nothing there". When a read fails and its error is
 * discarded, that claim gets made on no evidence at all — the ledger page would
 * have said "No dated leaks in the last three months" over a view that does not
 * exist, and the client page would have said "No warehouse rates yet" over a
 * rate card that is sitting in the table perfectly intact, which sends you off
 * to re-upload something you already have.
 *
 * It lives in its own file rather than being pasted into each page because the
 * wording is the load-bearing part. Two copies of it would drift, and the copy
 * that drifted would be the one that quietly went back to looking like an
 * absence.
 */
export function ViewUnreadable({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-800/50 bg-red-950/20 p-3">
      <p className="text-sm font-medium text-red-300">
        Could not read this, so nothing is shown for it. This is not an absence
        of data — it is an absence of an answer.
      </p>
      <p className="mt-1 font-mono text-xs text-red-400">{message}</p>
    </div>
  )
}

export default ViewUnreadable
