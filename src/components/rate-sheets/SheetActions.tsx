'use client'

import { useState } from 'react'

// Copy-link and print, mirroring what a prospect expects to be able to
// do with a document like this: forward it internally, or put it in
// front of someone who wants paper.
//
// The link is read from window.location rather than passed in, so it is
// always the URL actually being viewed and can never drift from it.

export default function SheetActions() {
  const [copied, setCopied] = useState(false)

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access is denied in some embedded browsers. Selecting
      // the address bar still works, so this is not worth an error state.
    }
  }

  return (
    <div className="flex items-center gap-2 print:hidden">
      <button
        type="button"
        onClick={copyLink}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium
                   text-slate-700 hover:bg-slate-50 transition"
      >
        {copied ? 'Link copied' : 'Copy link'}
      </button>
      <button
        type="button"
        onClick={() => window.print()}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium
                   text-slate-700 hover:bg-slate-50 transition"
      >
        Print / PDF
      </button>
    </div>
  )
}
