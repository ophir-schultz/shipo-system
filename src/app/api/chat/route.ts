import { NextResponse } from 'next/server'
import { SYSTEM_PROMPT, LEAD_INBOX, CONTACT } from '@/lib/chat/knowledge'
import { sendEmail } from '@/lib/email'

// The public website chat agent.
//
// This is the ONLY route in the app that is meant to be called by an
// anonymous stranger from another origin, so every limit here is load
// bearing rather than defensive habit:
//
//   * CORS is an allow-list of Shipo's own origins. Not `*`. A wildcard
//     would let any site on the internet point their chat widget at
//     Ophir's API key.
//   * MAX_TURNS caps a single conversation. Without it the history grows
//     every turn and so does the bill for each subsequent turn.
//   * MAX_CHARS caps one message, and the widget enforces the same cap,
//     but the widget is attacker-controlled so the check has to live here.
//   * The rate limiter is per-IP, in memory. Be honest about what that
//     is worth: on a serverless host each instance has its own Map, so a
//     determined attacker spread across warm instances gets a multiple of
//     the limit. It stops casual hammering and nothing more. The actual
//     backstop is the monthly spend cap set in the Anthropic console —
//     set that, it is the only limit that cannot be evaded.
//
// The visitor's own text is never trusted as instruction. It arrives as
// `user` turns and the system prompt tells the model to ignore anything
// in them that tries to change its rules.

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MODEL = process.env.CHAT_MODEL || 'claude-haiku-4-5-20251001'
const MAX_TURNS = 24
const MAX_CHARS = 1000
const MAX_OUTPUT_TOKENS = 400

// Per-IP limiter.
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 12
const hits = new Map<string, number[]>()

const ALLOWED_ORIGINS = new Set([
  'https://shipousa.com',
  'https://www.shipousa.com',
  ...(process.env.CHAT_EXTRA_ORIGIN ? [process.env.CHAT_EXTRA_ORIGIN] : []),
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : []),
])

function corsHeaders(origin: string | null): Record<string, string> {
  // Echo the origin only when it is on the list. An origin we don't
  // recognise gets no CORS header at all, and the browser blocks the
  // response — which is the desired outcome.
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) })
}

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  recent.push(now)
  hits.set(ip, recent)
  // Cheap sweep so the Map can't grow without bound on a long-lived instance.
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k)
  }
  return recent.length > MAX_PER_WINDOW
}

// Deliberately conservative: it should miss a weird address rather than
// pull a false one out of ordinary prose.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/

interface Turn {
  role: 'user' | 'assistant'
  content: string
}

export async function POST(req: Request) {
  const origin = req.headers.get('origin')
  const cors = corsHeaders(origin)

  // A cross-origin POST from an origin we don't allow is rejected here
  // as well as by the browser, so a non-browser caller gains nothing.
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 403 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('[chat] ANTHROPIC_API_KEY is not set')
    return NextResponse.json(
      { error: `The assistant is offline right now. Email ${CONTACT.email} and we'll answer today.` },
      { status: 503, headers: cors },
    )
  }

  const ip = clientIp(req)
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: 'That was a lot of messages very quickly. Give it a minute.' },
      { status: 429, headers: cors },
    )
  }

  const body = (await req.json().catch(() => null)) as { messages?: unknown; page?: unknown } | null
  const raw = Array.isArray(body?.messages) ? body.messages : null
  if (!raw || raw.length === 0) {
    return NextResponse.json({ error: 'No message.' }, { status: 400, headers: cors })
  }
  if (raw.length > MAX_TURNS) {
    return NextResponse.json(
      {
        error: `This chat has gone on a while. Email ${CONTACT.email} or call ${CONTACT.phone} and a person will pick it up.`,
      },
      { status: 400, headers: cors },
    )
  }

  const messages: Turn[] = []
  for (const m of raw as Array<{ role?: unknown; content?: unknown }>) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user'
    const content = typeof m?.content === 'string' ? m.content.slice(0, MAX_CHARS).trim() : ''
    if (content) messages.push({ role, content })
  }
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    return NextResponse.json({ error: 'No message.' }, { status: 400, headers: cors })
  }

  const latest = messages[messages.length - 1].content

  let reply: string
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        // cache_control on the system block: the prompt is ~1,500 tokens
        // and identical on every request, so after the first call each
        // turn reads it at 10% of the input price instead of full price.
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[chat] Anthropic ${res.status}: ${detail.slice(0, 500)}`)
      return NextResponse.json(
        { error: `Something went wrong on our side. Email ${CONTACT.email} and we'll answer today.` },
        { status: 502, headers: cors },
      )
    }

    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> }
    reply = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim()
  } catch (err) {
    console.error('[chat] request failed', err)
    return NextResponse.json(
      { error: `Something went wrong on our side. Email ${CONTACT.email} and we'll answer today.` },
      { status: 502, headers: cors },
    )
  }

  if (!reply) {
    reply = `I'm not sure how to answer that one. Email ${CONTACT.email} and a person will come back to you today.`
  }

  // Lead capture. Fire and forget — a mail failure must never turn into
  // a broken-looking chat for the visitor, so it is not awaited and its
  // outcome does not affect the response.
  const email = latest.match(EMAIL_RE)?.[0]
  if (email) {
    const page = typeof body?.page === 'string' ? body.page.slice(0, 300) : 'unknown'
    const transcript = messages
      .map((m) => `${m.role === 'user' ? 'Visitor' : 'Assistant'}: ${m.content}`)
      .join('\n\n')
    void sendEmail({
      to: LEAD_INBOX,
      subject: `Website chat lead — ${email}`,
      text:
        `A visitor left their email in the website chat.\n\n` +
        `Email: ${email}\n` +
        `Page: ${page}\n\n` +
        `--- Conversation ---\n\n${transcript}\n`,
      html:
        `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;color:#111">` +
        `<p style="margin:0 0 16px">A visitor left their email in the website chat.</p>` +
        `<p style="margin:0 0 4px"><strong>Email:</strong> ${escapeHtml(email)}</p>` +
        `<p style="margin:0 0 20px"><strong>Page:</strong> ${escapeHtml(page)}</p>` +
        `<hr style="border:none;border-top:1px solid #e5e5e5;margin:0 0 16px">` +
        `<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;color:#333;margin:0">${escapeHtml(transcript)}</pre>` +
        `</div>`,
    }).then((r) => {
      if (!r.sent) console.error(`[chat] lead email failed (${r.provider}): ${r.error ?? ''}`)
    })
  }

  return NextResponse.json({ reply, capturedEmail: Boolean(email) }, { headers: cors })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
