import axios from 'axios'

const BASE_URL = 'https://app.zenventory.com/api'

const client = axios.create({
  baseURL: BASE_URL,
  auth: {
    username: process.env.ZENVENTORY_API_KEY!,
    password: process.env.ZENVENTORY_API_SECRET!,
  },
  headers: { 'Content-Type': 'application/json' },
})

export async function getCustomerOrders(params?: {
  page?: number
  perPage?: number
  modifiedFrom?: string
  modifiedTo?: string
}) {
  const response = await client.get('/customer-orders', {
    params: {
      page: params?.page ?? 1,
      perPage: params?.perPage ?? 100,
      modifiedFrom: params?.modifiedFrom,
      modifiedTo: params?.modifiedTo,
    }
  })
  return response.data
}

export async function getCustomerOrder(id: number) {
  const response = await client.get(`/customer-orders/${id}`)
  return response.data
}
