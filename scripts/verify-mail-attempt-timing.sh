#!/bin/bash
# Did the production function actually CALL Resend, or is no provider set?
#
#   bash scripts/verify-mail-attempt-timing.sh
#
# WHY THIS EXISTS
# ---------------
# /api/partner/request-code returns 502 both when RESEND_API_KEY is absent
# ('none' -- sendEmail returns an object literal, no network) and when Resend
# refuses the send ('resend' -- a full HTTPS round trip to api.resend.com).
# The provider name is the discriminator and it goes to console.error only.
#
# Vercel runtime logs are unreadable from here: get_runtime_logs 403,
# get_runtime_errors 403, list_deployments 403, get_project 404, and
# list_projects for the team returns ZERO projects while list_teams resolves
# the team fine -- so the credential is live and its PROJECT SCOPE is gone.
# The `vercel logs` CLI fallback is blocked by the permission classifier.
#
# So measure the one externally visible consequence of a network call: time.
#
# THE PAIRED COMPARISON
# ---------------------
# Reading the route, a non-partner address does a strict SUBSET of the work:
#
#   B (unknown address): rate-limit count + partner lookup            -> 200 OK
#   A (the fixture):     the same, + retire-codes update + insert
#                        + sendEmail                                  -> 502
#
# So A-B isolates two Supabase writes plus whatever sendEmail did. Both run on
# the same deployment, same region, same database, in the same minute, so the
# network path from here and the Supabase latency are common to both and
# subtract out. That is the point of pairing rather than timing A alone.
#
#   provider 'none'   -> sendEmail adds ~0ms. A-B is two writes: tens of ms.
#   provider 'resend' -> adds DNS + TLS + POST to an external host. Hundreds.
#
# This is EVIDENCE, NOT PROOF, and the script says so in its verdict. A
# cold start or a slow write can forge one sample, which is why it takes
# several and compares MEDIANS, and why it warms the function first.
#
# THE RATE LIMIT IS THE BINDING CONSTRAINT
# ----------------------------------------
# MAX_CODES_PER_WINDOW = 5 per email per RATE_WINDOW_MINUTES = 15, counted on
# partner_login_codes rows, and the insert happens BEFORE sendEmail -- so every
# A sample spends one. One was already spent by the first manual 502 today, so
# A_SAMPLES stays at 4 and the script ABORTS on a 429 rather than averaging in
# a request that never reached sendEmail (a 429 returns before the insert and
# before the send, so it is fast, and silently averaging it in would drag the A
# median toward the 'none' answer -- the failure mode would flatter the wrong
# conclusion).
#
# B costs nothing: an unknown address returns before any insert, so no row and
# no rate-limit spend. Hence many more B samples than A.
#
# The rows this creates expire in CODE_TTL_MINUTES = 10 and are declared
# `on delete cascade` from referral_partners (supabase/partner_login.sql:23),
# so the fixture's UNDO removes them. Nothing here needs its own cleanup.

set -u

URL="https://shipo-system.vercel.app/api/partner/request-code"
FIXTURE='ophir+portaltest@shipousa.com'
A_SAMPLES=4   # see the rate-limit note above; do not raise without re-reading it
B_SAMPLES=8

# %{time_total} is the whole client-side request, which includes this laptop's
# round trip to the edge. That term is common to A and B and cancels in the
# difference; it is the reason the verdict is stated on A-B and never on A.
fetch() { # $1 = email -> "<http_code> <seconds>"
  curl -sS -o /dev/null -X POST "$URL" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\"}" \
    -w '%{http_code} %{time_total}' 2>/dev/null
}

median() { # stdin: numbers -> median
  sort -n | awk '{a[NR]=$1} END {if(NR==0){print "0"} else if(NR%2){print a[(NR+1)/2]} else {printf "%.4f\n",(a[NR/2]+a[NR/2+1])/2}}'
}

echo "endpoint $URL"
echo

# A cold function's first invocation pays module init and can be a second or
# more. Unwarmed, whichever of A or B went first would carry that cost and the
# difference would measure invocation order instead of sendEmail.
echo -n "warming up (3 calls, discarded)"
for _ in 1 2 3; do fetch "warmup-$RANDOM@example.invalid" >/dev/null; echo -n .; done
echo; echo

echo "B = unknown address: returns before any insert or send (expect 200)"
: > /tmp/b_times
for i in $(seq "$B_SAMPLES"); do
  # A DIFFERENT address each time. One address repeated would accumulate
  # partner_login_codes rows under it... it would not, actually -- no partner,
  # no insert -- but it would also make every call's rate-limit COUNT query
  # read the same key, and the point of B is to price the common path, not one
  # cached key.
  read -r code secs <<<"$(fetch "nobody-$RANDOM-$i@example.invalid")"
  printf '  %-4s %ss\n' "$code" "$secs"
  [ "$code" = "200" ] && echo "$secs" >> /tmp/b_times
done
echo

echo "A = the fixture: reaches sendEmail (expect 502)"
: > /tmp/a_times
aborted=
for i in $(seq "$A_SAMPLES"); do
  read -r code secs <<<"$(fetch "$FIXTURE")"
  printf '  %-4s %ss\n' "$code" "$secs"
  if [ "$code" = "429" ]; then
    echo "  !! RATE LIMITED. A 429 returns before the insert and before the send,"
    echo "  !! so it is not a sample of the send path. Stopping rather than"
    echo "  !! averaging it in. Wait 15 minutes for the window to roll."
    aborted=1
    break
  fi
  [ "$code" = "502" ] && echo "$secs" >> /tmp/a_times
  # The route retires outstanding codes then inserts; back-to-back calls can
  # race that update. Space them.
  sleep 1
done
echo

# A 200 from A would mean the mail went out and everything below is moot.
if grep -q . /tmp/a_times; then :; else
  echo "No 502 samples collected -- nothing to compare. If A returned 200, the"
  echo "mail path is WORKING and the 502 is history."
  exit 1
fi

bmed=$(median < /tmp/b_times)
amed=$(median < /tmp/a_times)
delta=$(awk -v a="$amed" -v b="$bmed" 'BEGIN{printf "%.0f", (a-b)*1000}')
echo "median B (no send)   ${bmed}s   n=$(wc -l < /tmp/b_times | tr -d ' ')"
echo "median A (with send) ${amed}s   n=$(wc -l < /tmp/a_times | tr -d ' ')"
echo "A - B                ${delta}ms  <- two Supabase writes + sendEmail"
echo

# The bands are deliberately generous and deliberately leave a gap in the
# middle that returns NO verdict. A threshold with no undecided region reports
# a conclusion for every input including the ones it cannot read, which is the
# defect this whole exercise is about.
if [ "$delta" -lt 120 ]; then
  echo "READS AS provider='none': the extra work is too cheap to contain an"
  echo "outbound HTTPS request. RESEND_API_KEY is most likely NOT SET on this"
  echo "environment -- the fix is in Vercel, not at Resend."
elif [ "$delta" -gt 220 ]; then
  echo "READS AS provider='resend': something made a network call. The key IS"
  echo "set and Resend REFUSED the send -- bad key, or shipousa.com no longer"
  echo "reads Verified. The fix is at the provider."
else
  echo "NO VERDICT. ${delta}ms sits between the bands -- two slow writes and a"
  echo "fast refused request are not separable at this resolution. Do not guess"
  echo "from it; read the provider name instead (the 502 body carries it as of"
  echo "ddf65f0, once that deploys) or the Vercel logs."
fi
[ -n "$aborted" ] && echo && echo "(A was cut short by the rate limit; the A median rests on fewer samples.)"
