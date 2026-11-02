import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { pool } from '@/lib/db/client'

interface PaymentResult {
    alreadyProcessed: boolean
    newBalance?: number | null
    amountAdded?: number
}

async function processSuccessfulPayment(
    reference: string,
    userId: string,
    amountInKobo: number
): Promise<PaymentResult> {
    const client = await pool.connect()
    try {
        await client.query('BEGIN')

        // Atomic idempotent insertion; returns row only if newly inserted
        const insertResult = await client.query(
            `INSERT INTO payment_transactions (reference, user_id, amount)
             VALUES ($1, $2, $3)
             ON CONFLICT (reference) DO NOTHING
             RETURNING reference`,
            [reference, userId, amountInKobo / 100]
        )

        if (insertResult.rows.length === 0) {
            await client.query('ROLLBACK')
            return { alreadyProcessed: true }
        }

        const amountToAdd = amountInKobo / 100

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
            newBalance: updateResult.rows[0]?.balance
                ? Number(updateResult.rows[0].balance)
                : null,
            amountAdded: amountToAdd,
        }
    } catch (error) {
        await client.query('ROLLBACK')
        throw error
    } finally {
        client.release()
    }
}

function verifyPaystackSignature(
    signature: string | null,
    rawBody: string,
    secretKey: string
): boolean {
    if (!signature || !secretKey) {
        return false
    }

    const expectedHash = crypto
        .createHmac('sha512', secretKey)
        .update(rawBody)
        .digest('hex')

    const expectedBuf = Buffer.from(expectedHash, 'hex')
    const receivedBuf = Buffer.from(signature, 'hex')

    if (expectedBuf.length !== receivedBuf.length) {
        return false
    }

    return crypto.timingSafeEqual(expectedBuf, receivedBuf)
}

// Browser redirect callback (GET)
export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url)
        const reference =
            searchParams.get('reference') || searchParams.get('trxref')

        if (!reference) {
            return new Response('Missing transaction reference', {
                status: 400,
            })
        }

        const secretKey = process.env.PAYSTACK_SECRET_KEY
        if (!secretKey) {
            return new Response('Paystack secret key is not configured', {
                status: 500,
            })
        }

        const verifyRes = await fetch(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: { Authorization: `Bearer ${secretKey}` },
            }
        )
        const verifyData = await verifyRes.json()

        if (
            !verifyRes.ok ||
            !verifyData.status ||
            verifyData.data?.status !== 'success'
        ) {
            return new Response('Payment verification failed', { status: 400 })
        }

        const userId = verifyData.data.metadata?.user_id
        const amountInKobo = verifyData.data.amount

        if (!userId) {
            return new Response('User ID missing from transaction metadata', {
                status: 400,
            })
        }

        await processSuccessfulPayment(reference, userId, amountInKobo)

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Payment Successful</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f8fafc; color: #0f172a; }
        .card { background: white; padding: 2.5rem; border-radius: 1rem; text-align: center; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); max-width: 420px; }
        h1 { color: #16a34a; margin-bottom: 0.75rem; font-size: 1.5rem; }
        p { color: #64748b; line-height: 1.5; margin: 0 0 1.5rem; }
        .btn { display: inline-block; padding: 0.625rem 1.75rem; background: #0f172a; color: white; border-radius: 0.5rem; text-decoration: none; font-weight: 500; }
        .btn:hover { background: #1e293b; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Payment Successful</h1>
        <p>Your balance has been credited. You can return to OpenWebUI to continue chatting.</p>
        <a href="javascript:window.close();" class="btn">Close Tab</a>
    </div>
</body>
</html>`

        return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            status: 200,
        })
    } catch (error) {
        console.error('Payment callback error:', error)
        return new Response('Payment callback processing error', {
            status: 500,
        })
    }
}

// Paystack server webhook (POST)
export async function POST(req: Request) {
    try {
        const secretKey = process.env.PAYSTACK_SECRET_KEY
        if (!secretKey) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Paystack secret key is not configured',
                },
                { status: 500 }
            )
        }

        const signature = req.headers.get('x-paystack-signature')
        const rawBody = await req.text()

        const isSignatureValid = verifyPaystackSignature(
            signature,
            rawBody,
            secretKey
        )
        if (!isSignatureValid) {
            return NextResponse.json(
                { success: false, error: 'Invalid webhook signature' },
                { status: 401 }
            )
        }

        const event = JSON.parse(rawBody)

        if (event.event === 'charge.success') {
            const reference = event.data?.reference
            const userId = event.data?.metadata?.user_id
            const amountInKobo = event.data?.amount

            if (reference && userId && amountInKobo > 0) {
                await processSuccessfulPayment(reference, userId, amountInKobo)
            }
        }

        return NextResponse.json({ received: true })
    } catch (error) {
        console.error('Paystack webhook error:', error)
        const message = error instanceof Error ? error.message : 'Webhook error'
        return NextResponse.json(
            { success: false, error: message },
            { status: 500 }
        )
    }
}
