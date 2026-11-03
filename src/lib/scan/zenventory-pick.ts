// Turning a queued scan into a Zenventory pick, and recording what happened
// to each serial afterwards.
//
// The write is the legacy pick, not an order edit and not a price edit:
//   PUT /services/rest/customerorders/{id}/items/pick
// with SecureKey. Public API 2.0 can find an order by number
// (GET /rest/customer-orders) and can read serials, and it has no pick
// write. The body below is the documented pick line. It has no price
// field, and customerprice read off the line is never copied in.
//
// Deduction is against that customer order. There is no inventory
// adjustment. A scan with no order is refused. Nothing is picked until
// every serialized line on the order has its full quantity scanned, and
// then each of those lines is one pick. A line already showing a picked
// quantity is not picked again.
//
// After a 2xx pick, the order is read back. API 2.0
// GET /customer-orders/{id}?includePickedItemMetadata=true is the read
// that can include the picked serials. The legacy pick GET is the
// fallback. The queue is marked done only when that read-back confirms
// the line.
//
// Nayax is not called. It receives serials from Zenventory through the
// API connection that already exists.

export const SCAN_INCOMPLETE = 'scan incomplete'

export const NAYAX_VIA_ZENVENTORY =
  'Nayax receives serials from Zenventory through its existing API connection. This system does not send serials to Nayax.'

export interface HttpResult {
  status: number
  body: unknown
}

export interface ZenventoryTransport {
  getV2(path: string, params: Record<string, string>, creds: { apiKey: string; apiSecret: string }): Promise<HttpResult>
  getLegacy(path: string, params: Record<string, string>, secureKey: string): Promise<HttpResult>
  putLegacy(path: string, body: unknown, secureKey: string): Promise<HttpResult>
}

export interface ClientZenventoryCredentials {
  apiKey: string | null
  apiSecret: string | null
  secureKey: string | null
}

export interface PushSerialRef {
  id: string
  serial: string
}

export interface OrderJob {
  id: string
  clientId: string
  orderRef: string
  sku: string
  status: string
  serials: string[]
  serialRows?: PushSerialRef[]
}

export interface DeliverOrderInput {
  jobs: OrderJob[]
  credentials: ClientZenventoryCredentials
  transport: ZenventoryTransport
  now: string
  /** Tracking already stored on our shipments rows for this order. Not sent to Zenventory. */
  shipmentTracking?: string[]
}

export interface SerialDeliveryUpdate {
  scannedSerialId: string
  serial: string
  zenventoryStatus: string | null
  zenventorySentAt: string | null
  zenventoryResponse: string | null
  /** Blank when neither Zenventory nor our shipment row had a label number yet. */
  trackingNumber: string
}

export interface DeliveryLogEntry {
  scannedSerialId: string | null
  serial: string
  channel: 'zenventory'
  status: string
  responseStatus: number | null
  responseBody: string | null
}

export interface PushOutcome {
  action: 'skipped' | 'waiting' | 'sent' | 'failed'
  /** False means the caller must not update the queue or the serial rows. */
  mutate: boolean
  queueStatus: 'done' | 'failed' | 'pending' | null
  attemptsIncrement: boolean
  requestPayload: unknown
  responseStatus: number | null
  responseBody: string | null
  error: string | null
  serials: SerialDeliveryUpdate[]
  log: DeliveryLogEntry[]
}

export interface PickBodyLine {
  customerorderitemid: number
  locationid: number | null
  lotnumber: string
  expirationdate: null
  serials: string[]
  quantity: number
}

const PRICE_KEY = /price/i

/** Every object key under `value` whose name looks like a price. Values are not searched. */
export function priceKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) priceKeys(item, found)
    return found
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (PRICE_KEY.test(key)) found.push(key)
      priceKeys(child, found)
    }
  }
  return found
}

export function responseText(body: unknown): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null)
  return text.slice(0, 2000)
}

function blank(value: string | null | undefined): boolean {
  return value == null || value.trim() === ''
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function arraysIn(body: unknown): unknown[][] {
  if (Array.isArray(body)) return [body]
  const record = asRecord(body)
  if (!record) return []
  const lists: unknown[][] = []
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) lists.push(value)
  }
  return lists
}

interface ResolvedOrder {
  id: string
}

export function ordersIn(body: unknown): Array<{ id: string; number: string }> {
  const out: Array<{ id: string; number: string }> = []
  for (const list of arraysIn(body)) {
    for (const item of list) {
      const record = asRecord(item)
      if (!record) continue
      const number = firstString(record, ['orderNumber', 'order_number', 'ordernumber'])
      const id = firstString(record, ['id', 'customerOrderId', 'customerorderid'])
      if (number && id) out.push({ id, number })
    }
  }
  return out
}

function matchOrder(orders: Array<{ id: string; number: string }>, orderRef: string): ResolvedOrder | 'many' | null {
  const want = orderRef.trim()
  const exact = orders.filter((order) => order.number === want)
  if (exact.length === 1) return { id: exact[0].id }
  if (exact.length > 1) return 'many'
  const folded = orders.filter((order) => order.number.toLowerCase() === want.toLowerCase())
  if (folded.length === 1) return { id: folded[0].id }
  if (folded.length > 1) return 'many'
  return null
}

export interface ParsedPickLine {
  customerorderitemid: number
  sku: string
  locationid: number | null
  serialized: boolean
  allocatedquantity: number | null
  pickedquantity: number
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

export function pickLinesIn(body: unknown): ParsedPickLine[] {
  const lists = arraysIn(body)
  const record = asRecord(body)
  if (record && 'customerorderitemid' in record) lists.push([record])
  const lines: ParsedPickLine[] = []
  for (const list of lists) {
    for (const item of list) {
      const row = asRecord(item)
      if (!row) continue
      const id = numberOrNull(row.customerorderitemid)
      if (id == null) continue
      const itemmaster = asRecord(row.itemmaster)
      const sku = firstString(row, ['sku']) ?? (itemmaster ? firstString(itemmaster, ['sku']) : null)
      if (!sku) continue
      const location = asRecord(row.location)
      const locationid = numberOrNull(row.locationid) ?? (location ? numberOrNull(location.id) : null)
      const picked = numberOrNull(row.pickedquantity) ?? 0
      lines.push({
        customerorderitemid: id,
        sku,
        locationid,
        serialized: row.serialized !== false,
        allocatedquantity: numberOrNull(row.allocatedquantity),
        pickedquantity: picked,
      })
    }
  }
  return lines
}

export function pickBody(line: ParsedPickLine, serials: string[]): PickBodyLine[] {
  return [{
    customerorderitemid: line.customerorderitemid,
    locationid: line.locationid,
    lotnumber: '',
    expirationdate: null,
    serials,
    quantity: serials.length,
  }]
}


function serialRefs(job: OrderJob): PushSerialRef[] {
  if (job.serialRows && job.serialRows.length > 0) return job.serialRows
  return job.serials.map((serial) => ({ id: '', serial }))
}

function uniqueSerials(serials: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const serial of serials) {
    const trimmed = serial.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function updates(
  refs: PushSerialRef[],
  zenventory: { status: string; sentAt: string | null; response: string },
  trackingNumber = '',
): SerialDeliveryUpdate[] {
  return refs.map((ref) => ({
    scannedSerialId: ref.id,
    serial: ref.serial,
    zenventoryStatus: zenventory.status,
    zenventorySentAt: zenventory.sentAt,
    zenventoryResponse: zenventory.response,
    trackingNumber,
  }))
}

const TRACKING_KEY = /^(trackingnumbers?)$/i

/** Label numbers found on a Zenventory order or shipment payload. Serials are not tracking. */
export function trackingNumbersIn(body: unknown): string[] {
  const found: string[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    const record = asRecord(value)
    if (!record) return
    for (const [key, child] of Object.entries(record)) {
      const folded = key.toLowerCase().replace(/_/g, '')
      if (TRACKING_KEY.test(folded)) {
        if (typeof child === 'string' && child.trim()) found.push(child.trim())
        else if (Array.isArray(child)) {
          for (const item of child) {
            if (typeof item === 'string' && item.trim()) found.push(item.trim())
            else {
              const row = asRecord(item)
              const number = row ? firstString(row, ['trackingNumber', 'tracking_number', 'number']) : null
              if (number) found.push(number)
            }
          }
        }
        continue
      }
      walk(child)
    }
  }
  walk(body)
  return uniqueSerials(found)
}

export function joinTracking(numbers: string[]): string {
  return uniqueSerials(numbers.filter((number) => number.trim() !== '')).join('\n')
}

function logs(
  refs: PushSerialRef[],
  status: string,
  responseStatus: number | null,
  responseBody: string,
): DeliveryLogEntry[] {
  return refs.map((ref) => ({
    scannedSerialId: ref.id || null,
    serial: ref.serial,
    channel: 'zenventory',
    status,
    responseStatus,
    responseBody,
  }))
}

function outcomeFor(
  job: OrderJob,
  patch: Partial<PushOutcome> & Pick<PushOutcome, 'action' | 'mutate' | 'queueStatus' | 'error'>,
): PushOutcome {
  const refs = serialRefs(job)
  const status = patch.serials?.[0]?.zenventoryStatus
    ?? (patch.error === SCAN_INCOMPLETE ? SCAN_INCOMPLETE : 'failed')
  const response = patch.responseBody ?? patch.error ?? ''
  return {
    action: patch.action,
    mutate: patch.mutate,
    queueStatus: patch.queueStatus,
    attemptsIncrement: patch.attemptsIncrement ?? false,
    requestPayload: patch.requestPayload ?? null,
    responseStatus: patch.responseStatus ?? null,
    responseBody: patch.responseBody ?? null,
    error: patch.error,
    serials: patch.serials ?? (patch.mutate && patch.action !== 'skipped'
      ? updates(refs, { status, sentAt: null, response })
      : []),
    log: patch.log ?? [],
  }
}

/** The only write this module performs: the legacy pick on a customer order. */
export function customerOrderPickPath(orderId: string): string {
  if (!/^[0-9]+$/.test(orderId)) {
    throw new Error(`Zenventory order id "${orderId}" is not a numeric id`)
  }
  return `/customerorders/${orderId}/items/pick`
}

async function resolveOrder(
  transport: ZenventoryTransport,
  credentials: ClientZenventoryCredentials,
  orderRef: string,
): Promise<{ order: ResolvedOrder | null; error: string | null; tracking: string[] }> {
  const hasV2 = !blank(credentials.apiKey) && !blank(credentials.apiSecret)
  // A 2.0 key that answers 401 is a known case: the legacy SecureKey still
  // lists the order. A failed 2.0 lookup falls through to that key.
  if (hasV2) {
    try {
      const listed = await transport.getV2('/customer-orders', {
        orderNumber: orderRef,
        orderNumberConditional: 'matches',
        perPage: '100',
        page: '1',
      }, { apiKey: credentials.apiKey!.trim(), apiSecret: credentials.apiSecret!.trim() })
      if (listed.status >= 200 && listed.status < 300) {
        const matched = matchOrder(ordersIn(listed.body), orderRef)
        if (matched === 'many') return { order: null, error: `More than one Zenventory order matches ${orderRef}`, tracking: [] }
        if (matched) return { order: matched, error: null, tracking: trackingNumbersIn(listed.body) }
      }
    } catch (err) {
      if (blank(credentials.secureKey)) {
        return { order: null, error: err instanceof Error ? err.message : String(err), tracking: [] }
      }
    }
  }
  if (blank(credentials.secureKey)) {
    return { order: null, error: `No Zenventory order matched ${orderRef}`, tracking: [] }
  }
  const listed = await transport.getLegacy('/customerorders', {}, credentials.secureKey!.trim())
  if (listed.status < 200 || listed.status >= 300) {
    return { order: null, error: `Legacy order list returned HTTP ${listed.status}`, tracking: [] }
  }
  const matched = matchOrder(ordersIn(listed.body), orderRef)
  if (matched === 'many') return { order: null, error: `More than one Zenventory order matches ${orderRef}`, tracking: [] }
  if (!matched) return { order: null, error: `No Zenventory order matched ${orderRef}`, tracking: [] }
  return { order: matched, error: null, tracking: trackingNumbersIn(listed.body) }
}

function orderItems(body: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  const take = (value: unknown) => {
    if (!Array.isArray(value)) return
    for (const item of value) {
      const record = asRecord(item)
      if (record) found.push(record)
    }
  }
  take(body)
  const record = asRecord(body)
  if (!record) return found
  take(record.items)
  for (const key of ['customerOrders', 'customerorders', 'orders']) {
    const list = record[key]
    if (!Array.isArray(list)) continue
    for (const order of list) take(asRecord(order)?.items)
  }
  return found
}

function itemSku(item: Record<string, unknown>): string | null {
  const direct = firstString(item, ['sku'])
  if (direct) return direct
  const master = asRecord(item.itemmaster) ?? asRecord(item.item)
  return master ? firstString(master, ['sku']) : null
}

function itemPicked(item: Record<string, unknown>): number | null {
  return numberOrNull(item.pickedQuantity) ?? numberOrNull(item.pickedquantity)
}

function collectSerialText(value: unknown, into: string[]) {
  if (typeof value === 'string') return
  if (Array.isArray(value)) {
    for (const item of value) collectSerialText(item, into)
    return
  }
  const record = asRecord(value)
  if (!record) return
  for (const [key, child] of Object.entries(record)) {
    if (key.toLowerCase() === 'serial' || key.toLowerCase() === 'serialnumber') {
      if (typeof child === 'string' && child.trim()) into.push(child.trim())
      continue
    }
    collectSerialText(child, into)
  }
}

export interface ReadBack {
  serials: string[] | null
  pickedQuantity: number | null
}

/** Serials and picked quantity for one SKU on a customer-order read-back. */
export function readBackForSku(body: unknown, sku: string): ReadBack {
  const want = sku.trim().toLowerCase()
  const items = orderItems(body).filter((item) => (itemSku(item) ?? '').trim().toLowerCase() === want)
  if (items.length === 0) return { serials: null, pickedQuantity: null }
  const serials: string[] = []
  let sawList = false
  let picked: number | null = null
  for (const item of items) {
    const qty = itemPicked(item)
    if (qty != null) picked = (picked ?? 0) + qty
    const fields = item.additionalFields ?? item.additionalfields ?? item.serials ?? item.pickedSerialNumbers
    if (fields != null) {
      sawList = true
      collectSerialText(fields, serials)
    }
  }
  return { serials: sawList ? serials : null, pickedQuantity: picked }
}

export function confirmReadBack(body: unknown, sku: string, sent: string[]): { ok: boolean; detail: string } {
  const read = readBackForSku(body, sku)
  if (read.serials) {
    const have = new Set(read.serials.map((serial) => serial.toLowerCase()))
    const missing = sent.filter((serial) => !have.has(serial.toLowerCase()))
    if (missing.length === 0) return { ok: true, detail: 'Read-back lists these serials on the customer order.' }
    return { ok: false, detail: `Read-back is missing ${missing.join(', ')}.` }
  }
  if (read.pickedQuantity != null && read.pickedQuantity >= sent.length) {
    return {
      ok: true,
      detail: `Read-back picked quantity is ${read.pickedQuantity}. The order payload did not include the serial list.`,
    }
  }
  return { ok: false, detail: 'Read-back did not show these serials on the customer order.' }
}

/**
 * One customer order. Picks each serialized line only after every
 * serialized line on that order is fully scanned. Does not touch the
 * database and does not call any inventory-adjustment endpoint.
 */
export async function deliverOrder(input: DeliverOrderInput): Promise<PushOutcome[]> {
  const seenTracking = [...(input.shipmentTracking ?? [])]
  const byId = new Map<string, PushOutcome>()
  const put = (job: OrderJob, patch: Partial<PushOutcome> & Pick<PushOutcome, 'action' | 'mutate' | 'queueStatus' | 'error'>) => {
    byId.set(job.id, outcomeFor(job, patch))
  }
  // Tracking is recorded, not waited on. A label often does not exist yet
  // when the cartons are scanned, and holding the pick would leave the
  // units in inventory. The pick body itself never carries a tracking number.
  const finish = () => {
    const tracking = joinTracking(seenTracking)
    return input.jobs.map((job) => {
      const outcome = byId.get(job.id) ?? outcomeFor(job, {
        action: 'failed',
        mutate: true,
        queueStatus: 'failed',
        error: 'The order was not processed.',
      })
      if (!tracking) return outcome
      return {
        ...outcome,
        serials: outcome.serials.map((serial) => ({
          ...serial,
          trackingNumber: serial.trackingNumber || tracking,
        })),
      }
    })
  }

  for (const job of input.jobs) {
    if (job.status === 'done') {
      put(job, { action: 'skipped', mutate: false, queueStatus: null, error: null, serials: [] })
    }
  }
  const active = input.jobs.filter((job) => job.status !== 'done')
  for (const job of active.filter((row) => blank(row.orderRef))) {
    const response = 'This scan is not linked to an order, so nothing was deducted.'
    put(job, {
      action: 'failed',
      mutate: true,
      queueStatus: 'failed',
      error: response,
      responseBody: response,
      serials: updates(serialRefs(job), { status: 'failed', sentAt: null, response }),
      log: logs(serialRefs(job), 'failed', null, response),
    })
  }
  const linked = active.filter((job) => !blank(job.orderRef))
  if (linked.length === 0) return finish()

  const orderRef = linked[0].orderRef.trim()
  if (linked.some((job) => job.orderRef.trim() !== orderRef || job.clientId !== linked[0].clientId)) {
    for (const job of linked) {
      put(job, {
        action: 'failed',
        mutate: true,
        queueStatus: 'failed',
        error: 'These scans are not one customer order, so nothing was deducted.',
      })
    }
    return finish()
  }
  if (blank(input.credentials.secureKey)) {
    for (const job of linked) {
      put(job, {
        action: 'failed',
        mutate: true,
        queueStatus: 'failed',
        attemptsIncrement: true,
        error: 'Legacy SecureKey is not stored for this client, so the pick was not sent',
      })
    }
    return finish()
  }

  let order: ResolvedOrder
  try {
    const resolved = await resolveOrder(input.transport, input.credentials, orderRef)
    seenTracking.push(...resolved.tracking)
    if (resolved.error || !resolved.order) {
      for (const job of linked) {
        put(job, {
          action: 'failed',
          mutate: true,
          queueStatus: 'failed',
          attemptsIncrement: true,
          error: resolved.error ?? 'No Zenventory order matched',
        })
      }
      return finish()
    }
    order = resolved.order
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    for (const job of linked) put(job, { action: 'failed', mutate: true, queueStatus: 'failed', attemptsIncrement: true, error })
    return finish()
  }

  let pickPath: string
  try {
    pickPath = customerOrderPickPath(order.id)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    for (const job of linked) put(job, { action: 'failed', mutate: true, queueStatus: 'failed', error })
    return finish()
  }

  let lines: ParsedPickLine[]
  try {
    const listed = await input.transport.getLegacy(pickPath, {}, input.credentials.secureKey!.trim())
    if (listed.status < 200 || listed.status >= 300) {
      for (const job of linked) {
        put(job, {
          action: 'failed',
          mutate: true,
          queueStatus: 'failed',
          attemptsIncrement: true,
          responseStatus: listed.status,
          responseBody: responseText(listed.body),
          error: `Pick line lookup returned HTTP ${listed.status}`,
        })
      }
      return finish()
    }
    lines = pickLinesIn(listed.body)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    for (const job of linked) put(job, { action: 'failed', mutate: true, queueStatus: 'failed', attemptsIncrement: true, error })
    return finish()
  }

  const serialized = lines.filter((line) => line.serialized && (line.allocatedquantity ?? 0) > 0)
  const bySku = new Map<string, ParsedPickLine[]>()
  for (const line of serialized) {
    const key = line.sku.trim().toLowerCase()
    bySku.set(key, [...(bySku.get(key) ?? []), line])
  }
  if ([...bySku.values()].some((group) => group.length > 1)) {
    for (const job of linked) {
      put(job, {
        action: 'failed',
        mutate: true,
        queueStatus: 'failed',
        error: 'A SKU is on more than one pick line, so no pick was sent.',
      })
    }
    return finish()
  }

  const jobsBySku = new Map<string, OrderJob[]>()
  for (const job of linked) {
    const key = job.sku.trim().toLowerCase()
    jobsBySku.set(key, [...(jobsBySku.get(key) ?? []), job])
  }
  const incomplete = serialized.some((line) => {
    if (line.pickedquantity >= (line.allocatedquantity ?? 0)) return false
    const scanned = uniqueSerials((jobsBySku.get(line.sku.trim().toLowerCase()) ?? []).flatMap((job) => job.serials))
    return scanned.length !== line.allocatedquantity
  })
  const partial = serialized.some((line) => line.pickedquantity > 0 && line.pickedquantity < (line.allocatedquantity ?? 0))
  if (partial || incomplete) {
    const error = partial
      ? 'A serialized line is already partly picked on this customer order, so nothing was sent.'
      : SCAN_INCOMPLETE
    for (const job of linked) {
      put(job, { action: 'waiting', mutate: true, queueStatus: 'pending', error, responseBody: error })
    }
    return finish()
  }

  const accepted = new Map<string, { body: PickBodyLine[]; status: number; text: string }>()
  for (const job of linked) {
    const line = bySku.get(job.sku.trim().toLowerCase())?.[0]
    if (!line) {
      put(job, {
        action: 'failed',
        mutate: true,
        queueStatus: 'failed',
        error: `SKU ${job.sku} is not a serialized line on customer order ${orderRef}, so nothing was deducted.`,
      })
      continue
    }
    if (line.pickedquantity > 0) {
      const response = `pickedquantity is ${line.pickedquantity}; no second pick was sent`
      put(job, {
        action: 'failed',
        mutate: true,
        queueStatus: 'failed',
        error: response,
        responseBody: response,
        serials: updates(serialRefs(job), { status: 'skipped', sentAt: null, response }),
        log: logs(serialRefs(job), 'skipped', null, response),
      })
      continue
    }
    if (line.locationid == null) {
      put(job, {
        action: 'failed',
        mutate: true,
        queueStatus: 'failed',
        error: `SKU ${job.sku} has no location on the pick line`,
      })
      continue
    }
    const serials = uniqueSerials(job.serials)
    const body = pickBody(line, serials)
    if (priceKeys(body).length > 0) {
      put(job, {
        action: 'failed',
        mutate: true,
        queueStatus: 'failed',
        requestPayload: body,
        error: 'Pick body contained a price field and was not sent',
      })
      continue
    }
    try {
      const picked = await input.transport.putLegacy(pickPath, body, input.credentials.secureKey!.trim())
      const text = responseText(picked.body)
      if (picked.status < 200 || picked.status >= 300) {
        put(job, {
          action: 'failed',
          mutate: true,
          queueStatus: 'failed',
          attemptsIncrement: true,
          requestPayload: body,
          responseStatus: picked.status,
          responseBody: text,
          error: `Pick returned HTTP ${picked.status}`,
        })
        continue
      }
      accepted.set(job.id, { body, status: picked.status, text })
    } catch (err) {
      put(job, {
        action: 'failed',
        mutate: true,
        queueStatus: 'failed',
        attemptsIncrement: true,
        requestPayload: body,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  let readBody: unknown = null
  let readError = 'Order read-back did not return a body.'
  if (accepted.size > 0) {
    try {
      const hasV2 = !blank(input.credentials.apiKey) && !blank(input.credentials.apiSecret)
      let read: HttpResult | null = null
      if (hasV2) {
        read = await input.transport.getV2(`/customer-orders/${order.id}`, {
          includePickedItemMetadata: 'true',
        }, { apiKey: input.credentials.apiKey!.trim(), apiSecret: input.credentials.apiSecret!.trim() })
        if (read.status < 200 || read.status >= 300) read = null
      }
      if (!read) read = await input.transport.getLegacy(pickPath, {}, input.credentials.secureKey!.trim())
      if (read.status < 200 || read.status >= 300) readError = `Order read-back returned HTTP ${read.status}`
      else {
        readBody = read.body
        seenTracking.push(...trackingNumbersIn(read.body))
      }
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err)
    }
  }

  for (const job of linked) {
    const picked = accepted.get(job.id)
    if (!picked) continue
    const serials = uniqueSerials(job.serials)
    const confirmed = readBody
      ? confirmReadBack(readBody, job.sku, serials)
      : { ok: false, detail: readError }
    const response = `${picked.text} ${confirmed.detail}`.trim()
    if (confirmed.ok) {
      put(job, {
        action: 'sent',
        mutate: true,
        queueStatus: 'done',
        requestPayload: picked.body,
        responseStatus: picked.status,
        responseBody: response,
        error: null,
        serials: updates(serialRefs(job), { status: 'sent', sentAt: input.now, response }),
        log: logs(serialRefs(job), 'sent', picked.status, response),
      })
    } else {
      put(job, {
        action: 'failed',
        mutate: true,
        queueStatus: 'failed',
        requestPayload: picked.body,
        responseStatus: picked.status,
        responseBody: response,
        error: confirmed.detail,
        serials: updates(serialRefs(job), { status: 'unconfirmed', sentAt: input.now, response }),
        log: logs(serialRefs(job), 'failed', picked.status, response),
      })
    }
  }
  return finish()
}
