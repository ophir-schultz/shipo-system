// Read-only. Does the API 2.0 credential also authenticate against the LEGACY
// API as a SecureKey? A GET, nothing written. Prints status codes only —
// never a credential value.
const LEGACY = 'https://app.zenventory.com/services/rest/customerorders'
const REST = 'https://app.zenventory.com/rest/customer-orders?perPage=20'

const k = process.env.ZENVENTORY_API_KEY ?? ''
const s = process.env.ZENVENTORY_API_SECRET ?? ''
console.log(`api key present: ${k ? 'yes' : 'NO'} · api secret present: ${s ? 'yes' : 'NO'}\n`)

async function tryLegacy(label, value) {
  if (!value) return console.log(`${label.padEnd(34)} (skipped, empty)`)
  const res = await fetch(LEGACY, { headers: { SecureKey: value, Accept: 'application/json' } })
  const body = (await res.text()).slice(0, 80).replace(/\s+/g, ' ')
  console.log(`${label.padEnd(34)} HTTP ${res.status}  ${body}`)
}

console.log('— legacy API, SecureKey header —')
await tryLegacy('SecureKey = API_KEY', k)
await tryLegacy('SecureKey = API_SECRET', s)
await tryLegacy('SecureKey = "key:secret"', k && s ? `${k}:${s}` : '')

console.log('\n— REST 2.0, Basic auth (control) —')
if (k && s) {
  const res = await fetch(REST, {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${k}:${s}`).toString('base64'),
      Accept: 'application/json',
    },
  })
  const body = (await res.text()).slice(0, 120).replace(/\s+/g, ' ')
  console.log(`Basic key:secret                   HTTP ${res.status}  ${body}`)
}
