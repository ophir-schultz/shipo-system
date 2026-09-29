// Read-only: resolve ShipStation warehouseId 683005 to a real origin address.
const key = process.env.SHIPSTATION_API_KEY
const secret = process.env.SHIPSTATION_API_SECRET
const auth = 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64')

const res = await fetch('https://ssapi.shipstation.com/warehouses', {
  headers: { Authorization: auth },
})
console.log('HTTP', res.status)
const data = await res.json()
for (const w of Array.isArray(data) ? data : [data]) {
  const o = w.originAddress ?? {}
  console.log({
    warehouseId: w.warehouseId,
    warehouseName: w.warehouseName,
    isDefault: w.isDefault,
    city: o.city,
    state: o.state,
    postalCode: o.postalCode,
    country: o.country,
  })
}
