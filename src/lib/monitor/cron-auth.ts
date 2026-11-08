import { createHash, timingSafeEqual } from 'node:crypto'

// A cron GET may write. A staff GET may not, even when it carries a
// query flag or a non-secret header. Only the bearer is compared, and
// an empty or missing secret never matches.

export function cronBearerAuthorized(
  authorization: string | null,
  env: { CRON_SECRET?: string; MONITOR_SECRET?: string },
): boolean {
  const presented = authorization ?? ''
  const secrets = [env.CRON_SECRET, env.MONITOR_SECRET].filter(
    (secret): secret is string => typeof secret === 'string' && secret.length > 0,
  )
  if (secrets.length === 0) return false
  return secrets.some((secret) => sameBearer(presented, secret))
}

function sameBearer(presented: string, secret: string): boolean {
  const actual = createHash('sha256').update(presented).digest()
  const expected = createHash('sha256').update(`Bearer ${secret}`).digest()
  return timingSafeEqual(actual, expected)
}
