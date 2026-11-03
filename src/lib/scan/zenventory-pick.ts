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
// A job that is already done is not looked up again. A line whose
// pickedquantity is already above zero is not picked again: whether that
// PUT appends or replaces has not been observed, and a second call can
// draw the same units down twice. A line is sent only when the scanned
// serial count equals the allocated quantity, so a half-scanned carton
// does not close the job.
//
// Nayax has no serial receiver in this system. Unless NAYAX_SERIAL_WEBHOOK_URL
// is set, the Nayax step records not_configured and does not call out.

export const NAYAX_SERIAL_WEBHOOK_URL = 'NAYAX_SERIAL_WEBHOOK_URL'

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

export interface DeliverJobInput {
  job: {
    id: string
    clientId: string
    orderRef: string
    sku: string
    status: string
    serials: string[]
    serialRows?: PushSerialRef[]
  }
  credentials: ClientZenventoryCredentials
  transport: ZenventoryTransport
  nayaxUrl: string | null
  nayaxPost: (url: string, body: unknown) => Promise<HttpResult>
  now: string
}

export interface SerialDeliveryUpdate {
  scannedSerialId: string
  serial: string
  zenventoryStatus: string | null
  zenventorySentAt: string | null
  zenventoryResponse: string | null
  nayaxStatus: string | null
  nayaxSentAt: string | null
  nayaxResponse: string | null
}

export interface DeliveryLogEntry {
  scannedSerialId: string | null
  serial: string
  channel: 'zenventory' | 'nayax'
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

function matchSku(lines: ParsedPickLine[], sku: string): ParsedPickLine[] {
  const want = sku.trim()
  const exact = lines.filter((line) => line.sku === want)
  if (exact.length > 0) return exact
  return lines.filter((line) => line.sku.toLowerCase() === want.toLowerCase())
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

function serialRefs(job: DeliverJobInput['job']): PushSerialRef[] {
  if (job.serialRows && job.serialRows.length > 0) return job.serialRows
  return job.serials.map((serial) => ({ id: '', serial }))
}

function updates(
  refs: PushSerialRef[],
  zenventory: { status: string; sentAt: string | null; response: string },
  nayax: { status: string; sentAt: string | null; response: string } | null,
): SerialDeliveryUpdate[] {
  return refs.map((ref) => ({
    scannedSerialId: ref.id,
    serial: ref.serial,
    zenventoryStatus: zenventory.status,
    zenventorySentAt: zenventory.sentAt,
    zenventoryResponse: zenventory.response,
    nayaxStatus: nayax?.status ?? null,
    nayaxSentAt: nayax?.sentAt ?? null,
    nayaxResponse: nayax?.response ?? null,
  }))
}

function logs(
  refs: PushSerialRef[],
  channel: 'zenventory' | 'nayax',
  status: string,
  responseStatus: number | null,
  responseBody: string,
): DeliveryLogEntry[] {
  return refs.map((ref) => ({
    scannedSerialId: ref.id || null,
    serial: ref.serial,
    channel,
    status,
    responseStatus,
    responseBody,
  }))
}

function failed(
  refs: PushSerialRef[],
  error: string,
  extras?: Partial<PushOutcome>,
): PushOutcome {
  return {
    action: 'failed',
    mutate: true,
    queueStatus: 'failed',
    attemptsIncrement: true,
    requestPayload: extras?.requestPayload ?? null,
    responseStatus: extras?.responseStatus ?? null,
    responseBody: extras?.responseBody ?? null,
    error,
    serials: extras?.serials ?? updates(refs, { status: 'failed', sentAt: null, response: error }, null),
    log: extras?.log ?? logs(refs, 'zenventory', 'failed', extras?.responseStatus ?? null, error),
  }
}

function usableUrl(url: string | null): string | null {
  if (blank(url)) return null
  const trimmed = url!.trim()
  if (!/^https?:\/\//i.test(trimmed)) return null
  return trimmed
}

async function resolveOrder(
  input: DeliverJobInput,
): Promise<{ order: ResolvedOrder | null; error: string | null }> {
  const { credentials, transport, job } = input
  const hasV2 = !blank(credentials.apiKey) && !blank(credentials.apiSecret)
  // A 2.0 key that answers 401 is a known Nayax case: the legacy SecureKey
  // still lists the order. A failed 2.0 lookup falls through to that key
  // instead of stopping the pick.
  if (hasV2) {
    try {
      const listed = await transport.getV2('/customer-orders', {
        orderNumber: job.orderRef,
        orderNumberConditional: 'matches',
        perPage: '100',
        page: '1',
      }, { apiKey: credentials.apiKey!.trim(), apiSecret: credentials.apiSecret!.trim() })
      if (listed.status >= 200 && listed.status < 300) {
        const matched = matchOrder(ordersIn(listed.body), job.orderRef)
        if (matched === 'many') return { order: null, error: `More than one Zenventory order matches ${job.orderRef}` }
        if (matched) return { order: matched, error: null }
      }
    } catch (err) {
      if (blank(credentials.secureKey)) {
        return { order: null, error: err instanceof Error ? err.message : String(err) }
      }
    }
  }
  if (blank(credentials.secureKey)) {
    return { order: null, error: `No Zenventory order matched ${job.orderRef}` }
  }
  const listed = await transport.getLegacy('/customerorders', {}, credentials.secureKey!.trim())
  if (listed.status < 200 || listed.status >= 300) {
    return { order: null, error: `Legacy order list returned HTTP ${listed.status}` }
  }
  const matched = matchOrder(ordersIn(listed.body), job.orderRef)
  if (matched === 'many') return { order: null, error: `More than one Zenventory order matches ${job.orderRef}` }
  if (!matched) return { order: null, error: `No Zenventory order matched ${job.orderRef}` }
  return { order: matched, error: null }
}

async function notifyNayax(
  input: DeliverJobInput,
  refs: PushSerialRef[],
): Promise<{ nayax: { status: string; sentAt: string | null; response: string }; log: DeliveryLogEntry[] }> {
  const url = usableUrl(input.nayaxUrl)
  if (!url) {
    const response = 'Nayax serial delivery is not configured'
    return {
      nayax: { status: 'not_configured', sentAt: null, response },
      log: logs(refs, 'nayax', 'not_configured', null, response),
    }
  }
  const body = {
    clientId: input.job.clientId,
    orderRef: input.job.orderRef,
    sku: input.job.sku,
    serials: input.job.serials,
  }
  try {
    const sent = await input.nayaxPost(url, body)
    const text = responseText(sent.body)
    if (sent.status >= 200 && sent.status < 300) {
      return {
        nayax: { status: 'sent', sentAt: input.now, response: text },
        log: logs(refs, 'nayax', 'sent', sent.status, text),
      }
    }
    return {
      nayax: { status: 'failed', sentAt: input.now, response: text },
      log: logs(refs, 'nayax', 'failed', sent.status, text),
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    return {
      nayax: { status: 'failed', sentAt: input.now, response: text },
      log: logs(refs, 'nayax', 'failed', null, text),
    }
  }
}

/**
 * One job. Does not touch the database. The caller persists `outcome`
 * only when `mutate` is true, and only marks the queue done after the
 * HTTP pick itself returned 2xx.
 */
export async function deliverJob(input: DeliverJobInput): Promise<PushOutcome> {
  const refs = serialRefs(input.job)
  if (input.job.status === 'done') {
    return {
      action: 'skipped',
      mutate: false,
      queueStatus: null,
      attemptsIncrement: false,
      requestPayload: null,
      responseStatus: null,
      responseBody: null,
      error: null,
      serials: [],
      log: [],
    }
  }
  if (input.job.serials.length === 0) {
    return {
      action: 'waiting',
      mutate: true,
      queueStatus: 'pending',
      attemptsIncrement: false,
      requestPayload: null,
      responseStatus: null,
      responseBody: null,
      error: 'No serials are stored for this line yet',
      serials: [],
      log: [],
    }
  }

  if (blank(input.credentials.secureKey)) {
    return failed(refs, 'Legacy SecureKey is not stored for this client, so the pick was not sent')
  }

  let order: ResolvedOrder
  try {
    const resolved = await resolveOrder(input)
    if (resolved.error || !resolved.order) return failed(refs, resolved.error ?? 'No Zenventory order matched')
    order = resolved.order
  } catch (err) {
    return failed(refs, err instanceof Error ? err.message : String(err))
  }
  if (!/^[0-9]+$/.test(order.id)) {
    return failed(refs, `Zenventory order id "${order.id}" is not a numeric id, so the pick was not sent`)
  }

  let lines: ParsedPickLine[]
  try {
    const listed = await input.transport.getLegacy(
      `/customerorders/${order.id}/items/pick`,
      {},
      input.credentials.secureKey!.trim(),
    )
    if (listed.status < 200 || listed.status >= 300) {
      return failed(refs, `Pick line lookup returned HTTP ${listed.status}`, {
        responseStatus: listed.status,
        responseBody: responseText(listed.body),
      })
    }
    lines = matchSku(pickLinesIn(listed.body), input.job.sku)
  } catch (err) {
    return failed(refs, err instanceof Error ? err.message : String(err))
  }

  if (lines.length === 0) {
    return failed(refs, `No pick line for SKU ${input.job.sku} on order ${input.job.orderRef}`)
  }
  if (lines.length > 1) {
    return failed(refs, `SKU ${input.job.sku} is on ${lines.length} pick lines; no pick was sent`)
  }
  const line = lines[0]
  if (line.pickedquantity > 0) {
    const response = `pickedquantity is ${line.pickedquantity}; no second pick was sent`
    return {
      action: 'failed',
      mutate: true,
      queueStatus: 'failed',
      attemptsIncrement: false,
      requestPayload: null,
      responseStatus: null,
      responseBody: response,
      error: response,
      serials: updates(refs, { status: 'skipped', sentAt: null, response }, null),
      log: logs(refs, 'zenventory', 'skipped', null, response),
    }
  }
  if (!line.serialized) {
    return failed(refs, `SKU ${input.job.sku} is not serialized on the pick line`)
  }
  if (line.locationid == null) {
    return failed(refs, `SKU ${input.job.sku} has no location on the pick line`)
  }
  if (line.allocatedquantity == null) {
    return failed(refs, `SKU ${input.job.sku} has no allocated quantity, so the pick was not sent`)
  }
  if (input.job.serials.length !== line.allocatedquantity) {
    return {
      action: 'waiting',
      mutate: true,
      queueStatus: 'pending',
      attemptsIncrement: false,
      requestPayload: null,
      responseStatus: null,
      responseBody: null,
      error: `Waiting for the full line: ${input.job.serials.length} of ${line.allocatedquantity} serials are scanned`,
      serials: [],
      log: [],
    }
  }

  const body = pickBody(line, input.job.serials)
  if (priceKeys(body).length > 0) {
    return failed(refs, 'Pick body contained a price field and was not sent', { requestPayload: body })
  }

  let picked: HttpResult
  try {
    picked = await input.transport.putLegacy(
      `/customerorders/${order.id}/items/pick`,
      body,
      input.credentials.secureKey!.trim(),
    )
  } catch (err) {
    return failed(refs, err instanceof Error ? err.message : String(err), { requestPayload: body })
  }
  const text = responseText(picked.body)
  if (picked.status < 200 || picked.status >= 300) {
    return failed(refs, `Pick returned HTTP ${picked.status}`, {
      requestPayload: body,
      responseStatus: picked.status,
      responseBody: text,
    })
  }

  const nayax = await notifyNayax(input, refs)
  return {
    action: 'sent',
    mutate: true,
    queueStatus: 'done',
    attemptsIncrement: false,
    requestPayload: body,
    responseStatus: picked.status,
    responseBody: text,
    error: nayax.nayax.status === 'failed' ? `Nayax delivery failed: ${nayax.nayax.response}` : null,
    serials: updates(
      refs,
      { status: 'sent', sentAt: input.now, response: text },
      nayax.nayax,
    ),
    log: [
      ...logs(refs, 'zenventory', 'sent', picked.status, text),
      ...nayax.log,
    ],
  }
}
