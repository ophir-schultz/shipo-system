// Which URL the server Supabase clients use.
//
// Production and development set SUPABASE_URL. Preview sets
// NEXT_PUBLIC_SUPABASE_URL and the service-role key, and does not set
// SUPABASE_URL. Reading only one of those names makes the other
// environment look unconfigured. The server takes the first one that is
// actually set.
//
// There is no localhost default. A missing URL is a missing URL.
// This function never reads the service-role key. The browser client
// does not import this file: it keeps the public URL literal so the
// service-role key cannot be pulled into a client bundle.

type Env = Record<string, string | undefined>

function filled(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** The server URL, or null when neither name is set. Values are not logged. */
export function readSupabaseServerUrl(env: Env): string | null {
  const url = [env.SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_URL].find(filled)
  return url ? url.trim() : null
}

/**
 * The server URL, or a throw that names both variables.
 *
 * `env` is a parameter so tests can pass the preview shape without
 * touching process.env.
 */
export function supabaseServerUrl(env: Env = process.env): string {
  const url = readSupabaseServerUrl(env)
  if (!url) {
    throw new Error(
      'Missing required environment variable SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL. '
      + 'The Supabase client cannot be built without one of them. No localhost default is used.',
    )
  }
  return url
}
