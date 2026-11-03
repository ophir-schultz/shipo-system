import { missingDocusignSetup } from '@/lib/docusign-client'

/**
 * Missing DocuSign configuration. Names only — this component never reads
 * a value out to the page. `audience="staff"` lists the variable names.
 * `audience="partner"` says the form is not configured and does not list
 * the ops variables.
 */
export default function DocusignNotice({ audience }: { audience: 'staff' | 'partner' }) {
  const missing = missingDocusignSetup(process.env)
  if (missing.length === 0) return null

  if (audience === 'partner') {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">DocuSign is not configured</p>
        <p className="mt-1 text-xs">
          The W-9 form cannot be opened from here yet. Your statement is unchanged. Email Support@shipousa.com if you need the form sent another way.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-semibold">DocuSign is not configured</p>
      <p className="mt-1 text-xs">
        Agreement webhook, W-9 signing, and envelope status stay off until these variables are set. Names only:
      </p>
      <ul className="mt-2 list-disc pl-5 font-mono text-xs">
        {missing.map((name) => <li key={name}>{name}</li>)}
      </ul>
    </div>
  )
}
