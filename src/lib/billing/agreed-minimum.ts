import { supabaseAdmin } from '@/lib/supabase'
import { readAllPages } from '@/lib/db/page'
import { agreedMinimumFromSheets, type AgreedMinimum } from '@/lib/billing/monthly-minimum'

interface SheetRow {
  company_name: string | null
  monthly_minimum: number | string | null
}

/** Rate sheets for this client name. A failed read does not become "no custom minimum". */
export async function loadAgreedMinimum(clientName: string): Promise<AgreedMinimum> {
  const res = await readAllPages<SheetRow>((from, to) =>
    supabaseAdmin
      .from('rate_sheets')
      .select('company_name, monthly_minimum')
      .order('id')
      .range(from, to))
  if (res.error) {
    return {
      status: 'unreadable',
      dollars: null,
      reason: `Rate sheets could not be read, so a monthly minimum was not applied. ${res.error.message}`,
    }
  }
  return agreedMinimumFromSheets(
    clientName,
    (res.data ?? []).map((row) => ({
      companyName: row.company_name ?? '',
      monthlyMinimum: Number(row.monthly_minimum),
    })).filter((row) => row.companyName !== '' && Number.isFinite(row.monthlyMinimum)),
  )
}
