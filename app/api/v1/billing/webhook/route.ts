import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { query } from '@/lib/db/client'

export async function POST(req: Request) {
    try {
        const signature = req.headers.get('x-paystack-signature')
        const rawBody = await req.text()

        const secretKey = process.env.PAYSTACK_SECRET_KEY || ''
        if (signature && secretKey) {
            const hash = crypto
                .createHmac('sha512', secretKey)
                .update(rawBody)
                .digest('hex')

            if (hash !== signature) {
                return NextResponse.json(
                    { success: false, error: 'Invalid webhook signature' },
                    { status: 401 }
                )
            }
        }

        const event = JSON.parse(rawBody)

        if (event.event === 'charge.success') {
            const paymentData = event.data
            const userId = paymentData.metadata?.user_id
            const amountInKobo = paymentData.amount
            const amountToAdd = amountInKobo / 100

            if (userId && amountToAdd > 0) {
                await query(
                    `UPDATE users 
                     SET balance = LEAST(balance + CAST($1 AS DECIMAL(16,4)), 999999.9999)
                     WHERE id = $2 AND NOT deleted`,
                    [amountToAdd, userId]
                )
            }
        }

        return NextResponse.json({ received: true })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Webhook processing error'
        return NextResponse.json({ success: false, error: message }, { status: 500 })
    }
}
