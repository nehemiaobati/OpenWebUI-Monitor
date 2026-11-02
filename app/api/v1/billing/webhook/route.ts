import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { pool } from '@/lib/db/client'

async function processSuccessfulPayment(reference: string, userId: string, amountInKobo: number) {
    const client = await pool.connect()
    try {
        await client.query('BEGIN')

        await client.query(`
            CREATE TABLE IF NOT EXISTS payment_transactions (
                reference VARCHAR(255) PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                amount DECIMAL(16,4) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            )
        `)

        const existing = await client.query(
            'SELECT reference FROM payment_transactions WHERE reference = $1',
            [reference]
        )

        if (existing.rows.length > 0) {
            await client.query('ROLLBACK')
            return { alreadyProcessed: true }
        }

        const amountToAdd = amountInKobo / 100

        await client.query(
            'INSERT INTO payment_transactions (reference, user_id, amount) VALUES ($1, $2, $3)',
            [reference, userId, amountToAdd]
        )

        const updateResult = await client.query(
            `UPDATE users 
             SET balance = LEAST(balance + CAST($1 AS DECIMAL(16,4)), 999999.9999)
             WHERE id = $2 AND NOT deleted
             RETURNING balance`,
            [amountToAdd, userId]
        )

        await client.query('COMMIT')
        return {
            alreadyProcessed: false,
            newBalance: updateResult.rows[0]?.balance ?? null,
            amountAdded: amountToAdd,
        }
    } catch (error) {
        await client.query('ROLLBACK')
        throw error
    } finally {
        client.release()
    }
}

// Browser redirect callback (GET)
export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url)
        const reference = searchParams.get('reference') || searchParams.get('trxref')

        if (!reference) {
            return new Response('Missing transaction reference', { status: 400 })
        }

        const secretKey = process.env.PAYSTACK_SECRET_KEY
        if (!secretKey) {
            return new Response('Paystack secret key not configured', { status: 500 })
        }

        const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: { Authorization: `Bearer ${secretKey}` },
        })
        const verifyData = await verifyRes.json()

        if (!verifyRes.ok || !verifyData.status || verifyData.data.status !== 'success') {
            return new Response('Payment verification failed', { status: 400 })
        }

        const userId = verifyData.data.metadata?.user_id
        const amountInKobo = verifyData.data.amount

        if (!userId) {
            return new Response('User ID missing from transaction metadata', { status: 400 })
        }

        await processSuccessfulPayment(reference, userId, amountInKobo)

        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8"><title>Payment Successful</title>
            <style>
                body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f8fafc; }
                .card { background: white; padding: 2rem; border-radius: 1rem; text-align: center; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
                h1 { color: #16a34a; }
                .btn { display: inline-block; margin-top: 1rem; padding: 0.5rem 1.5rem; background: #0f172a; color: white; border-radius: 0.5rem; text-decoration: none; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>✓ Payment Successful</h1>
                <p>Your balance has been updated. You can return to OpenWebUI to continue chatting.</p>
                <a href="javascript:window.close();" class="btn">Close Tab</a>
            </div>
        </body>
        </html>
        `

        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 200 })
    } catch (error) {
        return new Response('Callback error', { status: 500 })
    }
}

// Paystack server webhook (POST)
export async function POST(req: Request) {
    try {
        const signature = req.headers.get('x-paystack-signature')
        const rawBody = await req.text()
        const secretKey = process.env.PAYSTACK_SECRET_KEY || ''

        if (signature && secretKey) {
            const hash = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex')
            if (hash !== signature) {
                return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 })
            }
        }

        const event = JSON.parse(rawBody)

        if (event.event === 'charge.success') {
            const reference = event.data.reference
            const userId = event.data.metadata?.user_id
            const amountInKobo = event.data.amount

            if (reference && userId && amountInKobo > 0) {
                await processSuccessfulPayment(reference, userId, amountInKobo)
            }
        }

        return NextResponse.json({ received: true })
    } catch (error) {
        return NextResponse.json({ success: false, error: 'Webhook error' }, { status: 500 })
    }
}
