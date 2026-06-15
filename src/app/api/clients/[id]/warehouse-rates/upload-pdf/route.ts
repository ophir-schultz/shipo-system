import { NextResponse } from 'next/server'

export async function POST() {
  return NextResponse.json({ error: 'PDF upload not available in this version.' }, { status: 501 })
}
