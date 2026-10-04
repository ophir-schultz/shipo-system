import { createClient } from '@supabase/supabase-js'
import { createLazyClient, requireEnv } from './lazy-client'

// Both clients are built on FIRST USE, not at import.
//
// These two createClient() calls used to run at module scope, from
// `process.env.NEXT_PUBLIC_SUPABASE_URL!`. The `!` is a compile-time assertion
// and checks nothing at runtime, so with the variable absent supabase-js threw
// "supabaseUrl is required." the moment this module was imported. `next build`
// imports every page and route to collect page data, and 52 files import this
// module, so the BUILD died rather than any request -- which is why every
// preview deployment on this repo failed (dpl_DQ6gtMxBJSkh5rG6dbPuE1T6Hr9T,
// state ERROR; no env var on this project is scoped to Preview). Reproduced
// locally: with the three variables blanked, the old code failed "Collecting
// page data" at module evaluation of /api/clients/[id]/zone-chart.
//
// The export shape is unchanged: `createLazyClient` returns a Proxy typed as
// the real client, so all 59 `supabaseAdmin.from(...)` call sites and the rest
// are untouched. See src/lib/lazy-client.ts for why the `get` handler binds.
//
// This module is server-only -- no 'use client' file imports it -- which is
// what makes `requireEnv`'s dynamic `env[name]` read safe. Next inlines
// NEXT_PUBLIC_* into client bundles only for LITERAL `process.env.X`
// expressions; a dynamic lookup would come back undefined in the browser.

export const supabase = createLazyClient(() => createClient(
  requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
  requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
))

export const supabaseAdmin = createLazyClient(() => createClient(
  requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
  requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
))
