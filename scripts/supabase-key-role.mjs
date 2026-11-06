// What authority a Supabase API key has, without printing the key.
//
// Legacy keys are JWTs. The role is the `role` claim in the middle
// segment. The new secret key (sb_secret_) and publishable key
// (sb_publishable_) are not JWTs. A secret key bypasses RLS the way
// service_role did. A publishable key is the anon key.

export function supabaseKeyRole(key) {
  if (typeof key !== 'string') return 'absent'
  const trimmed = key.trim()
  if (trimmed === '') return 'absent'
  if (trimmed.startsWith('sb_secret_')) return 'service_role'
  if (trimmed.startsWith('sb_publishable_')) return 'anon'
  const segment = trimmed.split('.')[1]
  if (!segment) return 'unparseable'
  try {
    const claim = JSON.parse(Buffer.from(segment, 'base64url').toString())
    return typeof claim.role === 'string' && claim.role !== '' ? claim.role : 'absent'
  } catch {
    return 'unparseable'
  }
}
