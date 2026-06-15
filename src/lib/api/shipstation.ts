import axios from 'axios'

const BASE_URL = 'https://ssapi.shipstation.com'

const client = axios.create({
  baseURL: BASE_URL,
  auth: {
    username: process.env.SHIPSTATION_API_KEY!,
    password: process.env.SHIPSTATION_API_SECRET!,
  },
  headers: { 'Content-Type': 'application/json' },
})

export async function getShipments(params?: {
  shipDateStart?: string
  shipDateEnd?: string
  page?: number
  pageSize?: number
  carrierCode?: string
}) {
  const response = await client.get('/shipments', { params })
  return response.data
}

export async function getOrders(params?: {
  orderDateStart?: string
  orderDateEnd?: string
  orderStatus?: string
  page?: number
  pageSize?: number
}) {
  const response = await client.get('/orders', { params })
  return response.data
}

export async function getOrder(orderId: string) {
  const response = await client.get(`/orders/${orderId}`)
  return response.data
}
