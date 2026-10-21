// Whether the monitor is allowed to send its report, and -- just as important
// -- whether NOT sending it is a failure.
//
// Why this exists
// ---------------
// The monitor ran six times a day and emailed every single time, "All clear"
// included. Over a week that is 42 messages, most of them restating the same
// known backlog (unmapped stores, two 401s, the NULL-rate shipments). Ophir
// asked for them to stop: "stop sending those now."
//
// The trap this file is here to avoid
// -----------------------------------
// The obvious implementation -- skip the sendEmail() call -- quietly breaks the
// route's failure signal. monitor/route.ts answers `ok: emailResult.sent` and
// `status: emailResult.sent ? 200 : 500`, and that 500 is deliberate: Vercel
// records cron status, so a dead mail provider shows up as a failed run instead
// of disappearing. A skipped send looks identical to a failed send at the
// `sent: false` level, so skipping without saying so would 500 the cron six
// times a day for ever, and would also push the "THIS REPORT WAS NOT DELIVERED"
// line into errors[] -- a report of a problem that does not exist.
//
// So the decision has to be carried, not inferred. `send: false` here means WE
// CHOSE NOT TO; a false `sent` from sendEmail() after `send: true` means WE
// TRIED AND FAILED. Those two must never collapse into one boolean. It is the
// same null-versus-zero distinction this codebase is built on, applied to a
// delivery rather than to money.
//
// The findings are NOT suppressed
// -------------------------------
// Nothing here touches errors[] or the scans. Every issue is still computed and
// still returned in the route's JSON body, which is what `/api/agent/monitor`
// answers to a signed-in browser and to the AutoSync widget. Silencing the
// email silences the NOTIFICATION, not the monitoring.

export type MonitorEmailMode = 'off' | 'problems' | 'always'

export interface MonitorEmailDecision {
  /** Call sendEmail()? */
  send: boolean
  /** The mode actually applied, after parsing and defaulting. */
  mode: MonitorEmailMode
  /** Why, in words, for the run log. Never empty. */
  reason: string
}

/**
 * Parse MONITOR_EMAIL. Unset or unrecognised => 'off'.
 *
 * DEFAULTING TO 'off' IS THE POINT, and it is deliberately not 'always'.
 * Ophir asked for the emails to stop, and a default of 'off' makes that true on
 * the next deploy with no Vercel configuration -- which matters because this
 * repo deploys to four production projects and an env var would have to be set
 * in all four, with the emails continuing from whichever one was missed.
 *
 * Turning them back on is then one env var and no deploy, which is the right
 * way round for a switch somebody may want to flip in a hurry.
 *
 * An unrecognised value also lands on 'off' rather than throwing or falling
 * back to 'always': a typo in an env var must not quietly restore six mails a
 * day. The chosen mode is reported in the run log either way, so a typo is
 * visible rather than silent.
 */
export function parseMonitorEmailMode(raw: string | undefined | null): MonitorEmailMode {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 'always' || v === 'on' || v === 'true' || v === '1') return 'always'
  if (v === 'problems' || v === 'problems-only' || v === 'issues' || v === 'on-issues') {
    return 'problems'
  }
  return 'off'
}

/**
 * @param raw        process.env.MONITOR_EMAIL, unparsed.
 * @param hasErrors  whether this run found anything. Only consulted in
 *                   'problems' mode.
 */
export function monitorEmailDecision(
  raw: string | undefined | null,
  hasErrors: boolean,
): MonitorEmailDecision {
  const mode = parseMonitorEmailMode(raw)

  if (mode === 'off') {
    return {
      send: false,
      mode,
      // Names the switch and its values, because the person reading this line
      // in the run log is the person who wants the emails back.
      reason: 'MONITOR_EMAIL is off — report not sent. '
        + 'Findings are in this response. Set MONITOR_EMAIL=problems to be '
        + 'mailed only when something is wrong, or =always for every run.',
    }
  }

  if (mode === 'problems') {
    return hasErrors
      ? { send: true, mode, reason: 'MONITOR_EMAIL=problems and this run found issues' }
      : {
          send: false,
          mode,
          reason: 'MONITOR_EMAIL=problems and this run is clean — nothing to report',
        }
  }

  return { send: true, mode, reason: 'MONITOR_EMAIL=always' }
}

/**
 * Did the alert channel actually break?
 *
 * The ONLY caller-visible way to ask. `!sent` on its own is not the question --
 * a suppressed report is also `!sent` and is working as intended. This is what
 * the route's 500 and its "THIS REPORT WAS NOT DELIVERED" line must both key
 * off, so that a deliberate silence never pages anyone and a real mail outage
 * always does.
 */
export function deliveryFailed(decision: MonitorEmailDecision, sent: boolean): boolean {
  return decision.send && !sent
}
