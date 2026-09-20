// Lists ShipStation carriers + their 2/3-day services.
// SAFETY: credentials are read from env only and are NEVER logged.
import fs from 'fs';
import path from 'path';
import os from 'os';

const envPath = path.join(os.homedir(), 'shipo-system', '.env.local');
const raw = fs.readFileSync(envPath, 'utf8');
const env = {};
for (const line of raw.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const KEY = env.SHIPSTATION_API_KEY;
const SEC = env.SHIPSTATION_API_SECRET;
if (!KEY || !SEC) {
  console.log('MISSING creds. Shipstation-ish var names present:',
    Object.keys(env).filter((k) => k.includes('SHIP')).join(','));
  process.exit(1);
}
const auth = 'Basic ' + Buffer.from(`${KEY}:${SEC}`).toString('base64');

const r = await fetch('https://ssapi.shipstation.com/carriers', {
  headers: { Authorization: auth },
});
console.log('HTTP', r.status);
if (r.status !== 200) {
  console.log((await r.text()).slice(0, 300));
  process.exit(1);
}
const carriers = await r.json();
// All four of Ophir's own UPS accounts come back with code 'ups' and name 'UPS'.
// The only fields that tell them apart are nickname / accountNumber / providerId,
// so print those. Account numbers are masked to the last 4 — enough to identify
// the account, not enough to be worth leaking.
const mask = (v) => (v ? `...${String(v).slice(-4)}` : '(none)');
for (const c of carriers) {
  console.log(`\ncarrier: ${c.code} | ${c.name} | primary=${c.primary} | balance=${c.balance}`);
  console.log(`    nickname="${c.nickname || '(none)'}" acct=${mask(c.accountNumber)} providerId=${c.shippingProviderId}`);
  const sr = await fetch(
    `https://ssapi.shipstation.com/carriers/listservices?carrierCode=${c.code}`,
    { headers: { Authorization: auth } }
  );
  if (sr.status === 200) {
    const svcs = await sr.json();
    for (const s of svcs) {
      if (/2nd|second|3 ?day|three|air/i.test(s.name)) {
        console.log(`    ${s.code} :: ${s.name}`);
      }
    }
  }
  await new Promise((z) => setTimeout(z, 1600));
}
