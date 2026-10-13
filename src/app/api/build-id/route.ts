import { NextResponse } from 'next/server'

// Which build is this host actually serving?
//
//   curl -s https://shipo-system.vercel.app/api/build-id
//
// WHY THIS EXISTS
// ---------------
// Every "set the env var and redeploy" loop has the same unanswerable
// question in the middle of it: did the thing I just measured come from
// the new build or the old one? Without an answer, an unchanged result
// means either "the fix did not work" or "the fix is not deployed yet",
// and those want opposite next moves.
//
// I tried to answer it from outside, by hashing the set of
// /_next/static/chunks/<hash> filenames on /partner/login and watching
// for the set to change. That marker CANNOT SEE THIS CLASS OF CHANGE.
// Those names are content hashes of the CLIENT bundle; an env var read
// server-side is not in the client bundle, so a deploy that changes only
// an env var emits byte-identical chunks and an identical fingerprint.
// The marker would have reported "no new build" for a deploy that had
// definitely happened -- a check that returns the same answer whether or
// not the event occurred, which is not a check.
//
// So read the build identity from the runtime itself, where a
// server-side change is visible by construction. Vercel sets these on
// every deployment (VERCEL_GIT_COMMIT_SHA, VERCEL_DEPLOYMENT_ID,
// VERCEL_ENV, VERCEL_REGION); locally they are simply absent and the
// fields come back null, which is itself the correct answer to "which
// deployment is this" when there isn't one.
//
// WHY THIS IS SAFE TO LEAVE PUBLIC
// --------------------------------
// It returns no secret and no config shape -- in particular it does NOT
// report which environment variables are set. The short commit SHA is a
// hash of a private repo and is not a credential; build/deploy ids are
// routinely exposed this way. Deliberately there is no "is RESEND_API_KEY
// present" field here: that question is already answered, to the only
// caller entitled to ask it, by the `provider` name on request-code's 502.
// Adding an unauthenticated env-presence probe would hand the config shape
// to anyone on the internet to save me one curl.

export const dynamic = 'force-dynamic' // never serve a cached answer to "what is deployed right now"

export async function GET() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? null

  return NextResponse.json(
    {
      // Short form is enough to compare against `git log --oneline` and
      // leaks less than the full hash.
      commit: sha ? sha.slice(0, 7) : null,
      // The deployment id changes on EVERY deploy, including one that
      // rebuilds identical source with different env vars -- which is
      // exactly the case the client-chunk fingerprint was blind to.
      deployment: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      // 'production' | 'preview' | 'development'. Worth having: an env var
      // scoped to the wrong environment is only diagnosable if you know
      // which environment answered.
      env: process.env.VERCEL_ENV ?? null,
      region: process.env.VERCEL_REGION ?? null,
      now: new Date().toISOString(),
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
