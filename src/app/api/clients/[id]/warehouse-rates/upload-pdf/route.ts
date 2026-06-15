import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import pdf from 'pdf-parse'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params
  const formData = await req.formData()
  const file = formData.get('file') as File
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

  const buffer = Buffer.from(await file.arrayBuffer())
  const parsed = await pdf(buffer)
  const text = parsed.text

  // Extract rows by looking for lines with a number (price) in them
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const rates: any[] = []

  const serviceMap: Record<string, string> = {
    'pick': 'pick_pack',
    'pack': 'pick_pack',
    'pick & pack': 'pick_pack',
    'pick and pack': 'pick_pack',
    'storage': 'storage',
    'receiving': 'receiving',
    'receive': 'receiving',
    'return': 'returns',
    'returns': 'returns',
    'label': 'labeling',
    'labeling': 'labeling',
    'kit': 'kitting',
    'kitting': 'kitting',
    'special': 'special_task',
    'handling': 'special_task',
  }

  const unitMap: Record<string, string> = {
    'unit': 'per_unit',
    'order': 'per_order',
    'pallet': 'per_pallet',
    'hour': 'per_hour',
    'hr': 'per_hour',
    'lb': 'per_lb',
    'flat': 'flat',
  }

  for (const line of lines) {
    // Look for a dollar amount in the line
    const priceMatch = line.match(/\$?\s*(\d+\.?\d*)/)
    if (!priceMatch) continue

    const rate = parseFloat(priceMatch[1])
    if (!rate || rate <= 0) continue

    const lower = line.toLowerCase()

    // Match service type
    let service_type = ''
    for (const [key, val] of Object.entries(serviceMap)) {
      if (lower.includes(key)) { service_type = val; break }
    }
    if (!service_type) continue

    // Match unit
    let unit = 'per_unit'
    for (const [key, val] of Object.entries(unitMap)) {
      if (lower.includes(key)) { unit = val; break }
    }

    rates.push({ client_id: clientId, service_type, rate, unit })
  }

  return NextResponse.json({ rates, rawText: text })
}
