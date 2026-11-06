import { docusignReadiness } from '@/lib/docusign-client'
import {
  AGREEMENT_NOT_SENT_FROM_DASHBOARD,
  CONNECT_CAN_RECEIVE,
  CONNECT_IS_OFF,
} from '@/lib/partner-agreement-match'

/**
 * What DocuSign can and cannot do from this app.
 *
 * Names only. This component never reads a variable's value onto the page.
 * Staff always see that agreement sending is not a dashboard action, even
 * when the API variables are present, because this app has no send route.
 * Partners see a sentence only when the in-portal W-9 cannot open, and
 * they are not shown the ops variable names.
 */
export default function DocusignNotice({ audience }: { audience: 'staff' | 'partner' }) {
  const ready = docusignReadiness(process.env)

  if (audience === 'partner') {
    if (ready.apiMissing.length === 0 && ready.w9Missing.length === 0) return null
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">The tax form cannot be opened from here yet</p>
        <p className="mt-1 text-xs">
          Your statement is unchanged. Email Support@shipousa.com if you need the form sent another way.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-semibold">Agreements are not sent from this dashboard</p>
      <p className="mt-1 text-xs">{AGREEMENT_NOT_SENT_FROM_DASHBOARD}</p>
      <p className="mt-2 text-xs">{ready.connectConfigured ? CONNECT_CAN_RECEIVE : CONNECT_IS_OFF}</p>
      {ready.apiMissing.length > 0 && (
        <>
          <p className="mt-2 text-xs">
            Creating an envelope or opening the in-portal W-9 also needs these variables. Names only:
          </p>
          <ul className="mt-1 list-disc pl-5 font-mono text-xs">
            {ready.apiMissing.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </>
      )}
      {ready.w9Missing.length > 0 && (
        <>
          <p className="mt-2 text-xs">The W-9 copy to the accountant also needs these names:</p>
          <ul className="mt-1 list-disc pl-5 font-mono text-xs">
            {ready.w9Missing.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
