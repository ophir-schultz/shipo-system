import { describe, it, expect } from 'vitest'
import { createSingleFlight } from './single-flight'

// The bug being locked down: AutoSync.tsx guarded re-entry with `if (syncing)
// return` inside a useCallback, while setInterval held the mount-time closure,
// in which `syncing` is permanently false. The guard could not fire for a timer
// tick, and /api/agent/monitor's maxDuration (300s) is exactly the poll
// interval, so a slow pass overlapping the next one is reachable.
//
// So the assertions that matter most are that repeated calls landing inside one
// unfinished pass start the work ONCE, and that the claim happens before the
// first await. The rest are about the gate not becoming a new failure of its
// own -- stuck shut, or swallowing errors.

/** A task whose completion the test controls, plus a count of its starts. */
function controllable() {
  const resolvers: Array<() => void> = []
  const rejecters: Array<(err: Error) => void> = []
  let starts = 0
  const task = () => {
    starts++
    return new Promise<void>((resolve, reject) => {
      resolvers.push(resolve)
      rejecters.push(reject)
    })
  }
  return {
    task,
    get starts() { return starts },
    resolveLast: () => resolvers[resolvers.length - 1](),
    rejectLast: (err: Error) => rejecters[rejecters.length - 1](err),
  }
}

describe('createSingleFlight refuses a call that would overlap one in flight', () => {
  it('starts the work once when four ticks land inside one slow pass', async () => {
    const gate = createSingleFlight()
    const ctl = controllable()

    // setInterval calls the same function again on schedule with no knowledge
    // of whether the previous call finished. This is that, four times over.
    const ticks = [gate(ctl.task), gate(ctl.task), gate(ctl.task), gate(ctl.task)]

    // The load-bearing assertion, checked while the first pass is still open: a
    // refused call must not have touched the task at all, rather than having
    // run and been ignored. Without the guard this is 4 -- four concurrent
    // ShipStation syncs and four thirty-day charge recalculations.
    expect(ctl.starts).toBe(1)

    ctl.resolveLast()
    expect(await Promise.all(ticks)).toEqual([true, false, false, false])
  })

  // `inFlight = true` has to be set before the first await, or two calls in one
  // tick both find the gate open and the guard is decorative.
  it('claims the gate synchronously, before the task is awaited', () => {
    const gate = createSingleFlight()
    let starts = 0
    const task = () => { starts++; return new Promise<void>(() => {}) }

    gate(task)
    gate(task) // same tick, nothing awaited in between
    expect(starts).toBe(1)
  })
})

describe('createSingleFlight reopens, so the guard cannot become the outage', () => {
  it('allows the next call once the previous pass resolves', async () => {
    const gate = createSingleFlight()
    const ctl = controllable()

    const first = gate(ctl.task)
    ctl.resolveLast()
    expect(await first).toBe(true)

    // A gate that never reopened would make this false, and the widget would
    // never sync again for the life of the page.
    const second = gate(ctl.task)
    ctl.resolveLast()
    expect(await second).toBe(true)
    expect(ctl.starts).toBe(2)
  })

  it('reopens after the pass REJECTS, not only after it succeeds', async () => {
    const gate = createSingleFlight()
    const ctl = controllable()

    const failing = gate(ctl.task)
    ctl.rejectLast(new Error('monitor unreachable'))
    await expect(failing).rejects.toThrow('monitor unreachable')

    const next = gate(ctl.task)
    ctl.resolveLast()
    expect(await next).toBe(true)
    expect(ctl.starts).toBe(2)
  })

  it('reopens after a task that throws synchronously', async () => {
    const gate = createSingleFlight()
    await expect(gate(() => { throw new Error('boom') })).rejects.toThrow('boom')

    let ran = false
    expect(await gate(async () => { ran = true })).toBe(true)
    expect(ran).toBe(true)
  })

  it('propagates a rejection instead of reporting it as a refusal', async () => {
    const gate = createSingleFlight()
    // If the gate swallowed errors it could return false here, which a caller
    // would read as "skipped, one was already running" -- the opposite of what
    // happened.
    await expect(gate(async () => { throw new Error('classify failed') }))
      .rejects.toThrow('classify failed')
  })

  it('runs a sequence of non-overlapping passes, every one of them', async () => {
    const gate = createSingleFlight()
    let runs = 0
    for (let i = 0; i < 5; i++) {
      expect(await gate(async () => { runs++ })).toBe(true)
    }
    expect(runs).toBe(5)
  })
})
