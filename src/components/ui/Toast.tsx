'use client'

import { useEffect, useState } from 'react'

export type ToastType = 'error' | 'success' | 'warning' | 'info'

export interface ToastMessage {
  id: string
  type: ToastType
  title: string
  message?: string
}

// Global toast state — simple pub/sub
type Listener = (toasts: ToastMessage[]) => void
let listeners: Listener[] = []
let toasts: ToastMessage[] = []

function notify() {
  listeners.forEach(l => l([...toasts]))
}

export function toast(type: ToastType, title: string, message?: string) {
  const id = Math.random().toString(36).slice(2)
  toasts = [...toasts, { id, type, title, message }]
  notify()
  setTimeout(() => {
    toasts = toasts.filter(t => t.id !== id)
    notify()
  }, type === 'error' ? 8000 : 4000)
}

export const showError = (title: string, message?: string) => toast('error', title, message)
export const showSuccess = (title: string, message?: string) => toast('success', title, message)
export const showWarning = (title: string, message?: string) => toast('warning', title, message)

const ICONS: Record<ToastType, string> = {
  error: '✕',
  success: '✓',
  warning: '⚠',
  info: 'ℹ',
}

const STYLES: Record<ToastType, string> = {
  error: 'border-red-700/60 bg-red-950/90',
  success: 'border-green-700/60 bg-green-950/90',
  warning: 'border-yellow-700/60 bg-yellow-950/90',
  info: 'border-blue-700/60 bg-blue-950/90',
}

const ICON_STYLES: Record<ToastType, string> = {
  error: 'bg-red-700 text-white',
  success: 'bg-green-700 text-white',
  warning: 'bg-yellow-600 text-white',
  info: 'text-white',
}

export default function ToastContainer() {
  const [messages, setMessages] = useState<ToastMessage[]>([])

  useEffect(() => {
    listeners.push(setMessages)
    return () => { listeners = listeners.filter(l => l !== setMessages) }
  }, [])

  if (!messages.length) return null

  return (
    <div className="fixed bottom-5 right-5 z-[9999] flex flex-col gap-2 max-w-sm w-full">
      {messages.map(t => (
        <div
          key={t.id}
          className={`flex items-start gap-3 px-4 py-3 rounded-xl border backdrop-blur-sm shadow-xl ${STYLES[t.type]}`}
          style={{ animation: 'slideIn 0.2s ease' }}
        >
          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5 ${ICON_STYLES[t.type]}`}>
            {ICONS[t.type]}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-white text-sm font-medium">{t.title}</p>
            {t.message && <p className="text-gray-300 text-xs mt-0.5 break-words">{t.message}</p>}
          </div>
          <button
            onClick={() => { toasts = toasts.filter(x => x.id !== t.id); notify() }}
            className="text-gray-400 hover:text-white text-xs flex-shrink-0 mt-0.5"
          >✕</button>
        </div>
      ))}
      <style>{`@keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`}</style>
    </div>
  )
}
