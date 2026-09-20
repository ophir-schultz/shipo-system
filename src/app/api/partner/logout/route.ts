import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { supabaseAdmin } from '@/lib/supabase'
import { sha256Hex, SESSION_COOKIE } from '@/lib/partner-auth'

// Sign out of the partner portal.
//
// The session row is revoked server-side as well as cleared from the
// browser, so a copied cookie stops working too.

export const dynamic = 'force-dynamic'

export async function POST() {
  const jar = await cookies()
  const raw = jar.get(SESSION_COOKIE)?.value

  if (raw) {
    const tokenHash = await sha256Hex(raw)
    await supabaseAdmin
      .from('partner_sessions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('token_hash', tokenHash)
      .is('revoked_at', null)
  }

  jar.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })

  return NextResponse.json({ success: true })
}
