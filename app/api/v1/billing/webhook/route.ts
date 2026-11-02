import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { pool } from '@/lib/db/client'

interface PaymentResult {
    alreadyProcessed: boolean
    newBalance: number | null
    amountAdded: number
}

async function processSuccessfulPayment(
    reference: string,
    userId: string,
    amountInKobo: number,
    userEmail?: string
): Promise<PaymentResult> {
    const client = await pool.connect()
    let inTransaction = false

    try {
        await client.query('BEGIN')
        inTransaction = true

        const amountToAdd = amountInKobo / 100

        // Idempotent record insert using ON CONFLICT to deterministically prevent race conditions
        const insertTx = await client.query(
            `INSERT INTO payment_transactions (reference, user_id, amount) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (reference) DO NOTHING 
             RETURNING reference`,
            [reference, userId, amountToAdd]
        )

        if (insertTx.rows.length === 0) {
            await client.query('ROLLBACK')
            inTransaction = false
            return { alreadyProcessed: true, newBalance: null, amountAdded: 0 }
        }

        // Atomically update user balance
        let updateResult = await client.query(
            `UPDATE users 
             SET balance = LEAST(balance + CAST($1 AS DECIMAL(16,4)), 999999.9999)
             WHERE id = $2 AND NOT deleted
             RETURNING balance`,
            [amountToAdd, userId]
        )

        // Ensure user exists if payment arrives before initial chat inlet
        if (updateResult.rows.length === 0) {
            const initialBalance = parseFloat(process.env.INIT_BALANCE || '0')
            const finalBalance = Math.min(initialBalance + amountToAdd, 999999.9999)
            const email = userEmail || `${userId}@openwebui.local`

            updateResult = await client.query(
                `INSERT INTO users (id, email, name, role, balance)
                 VALUES ($1, $2, $3, 'user', $4)
                 ON CONFLICT (id) DO UPDATE
                 SET balance = LEAST(users.balance + CAST($5 AS DECIMAL(16,4)), 999999.9999)
                 WHERE NOT users.deleted
                 RETURNING balance`,
                [userId, email, userId, finalBalance, amountToAdd]
            )
        }

        await client.query('COMMIT')
        inTransaction = false

        const newBalance = updateResult.rows[0]?.balance != null ? Number(updateResult.rows[0].balance) : null

        return {
            alreadyProcessed: false,
            newBalance,
            amountAdded: amountToAdd,
        }
    } catch (error) {
        if (inTransaction) {
            try {
                await client.query('ROLLBACK')
            } catch (rollbackError) {
                console.error('Failed to rollback payment transaction:', rollbackError)
            }
        }
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

        const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
            headers: { Authorization: `Bearer ${secretKey}` },
        })
        const verifyData = await verifyRes.json()

        if (!verifyRes.ok || !verifyData.status || verifyData.data?.status !== 'success') {
            return new Response('Payment verification failed or was incomplete', { status: 400 })
        }

        const userId = verifyData.data.metadata?.user_id
        const userEmail = verifyData.data.metadata?.email || verifyData.data.customer?.email
        const amountInKobo = verifyData.data.amount

        if (!userId) {
            return new Response('User ID missing from transaction metadata', { status: 400 })
        }

        const result = await processSuccessfulPayment(reference, userId, amountInKobo, userEmail)
        const openWebUiUrl = process.env.OPENWEBUI_DOMAIN || '/'

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Payment Successful - OpenWebUI Monitor</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
        .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; text-align: center; max-width: 440px; width: 90%; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3); border: 1px solid #334155; }
        .icon { width: 48px; height: 48px; margin: 0 auto 1rem; border-radius: 50%; background: #065f46; color: #34d399; display: flex; align-items: center; justify-content: center; font-size: 24px; }
        h1 { margin: 0 0 0.5rem; font-size: 1.5rem; color: #f8fafc; }
        p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin: 0 0 1.5rem; }
        .btn-group { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; }
        .btn { display: inline-block; padding: 0.65rem 1.25rem; font-size: 0.9rem; font-weight: 500; border-radius: 0.5rem; text-decoration: none; cursor: pointer; transition: background 0.2s; }
        .btn-primary { background: #3b82f6; color: white; border: none; }
        .btn-primary:hover { background: #2563eb; }
        .btn-secondary { background: #334155; color: #e2e8f0; border: none; }
        .btn-secondary:hover { background: #475569; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">✓</div>
        <h1>Payment Successful</h1>
        <p>Your payment has been verified and your balance is updated. You may now return to OpenWebUI to continue your conversation.</p>
        <div class="btn-group">
            <a href="${openWebUiUrl}" class="btn btn-primary">Return to Chat</a>
            <button onclick="window.close()" class="btn btn-secondary">Close Window</button>
        </div>
    </div>
</body>
</html>`

        return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            status: 200,
        })
    } catch (error) {
        console.error('Error handling Paystack redirect:', error)
        return new Response('An error occurred while verifying the payment', { status: 500 })
    }
}

// Paystack server webhook (POST)
export async function POST(req: Request) {
    try {
        const secretKey = process.env.PAYSTACK_SECRET_KEY
        if (!secretKey) {
            return NextResponse.json(
                { success: false, error: 'PAYSTACK_SECRET_KEY is not configured in .env' },
                { status: 500 }
            )
        }

        const signature = req.headers.get('x-paystack-signature')
        if (!signature) {
            return NextResponse.json(
                { success: false, error: 'Missing x-paystack-signature header' },
                { status: 401 }
            )
        }

        const rawBody = await req.text()
        const computedSignature = crypto
            .createHmac('sha512', secretKey)
            .update(rawBody)
            .digest('hex')

        const signatureBuffer = Buffer.from(signature, 'utf8')
        const computedBuffer = Buffer.from(computedSignature, 'utf8')

        if (
            signatureBuffer.length !== computedBuffer.length ||
            !crypto.timingSafeEqual(signatureBuffer, computedBuffer)
        ) {
            return NextResponse.json(
                { success: false, error: 'Invalid webhook signature' },
                { status: 401 }
            )
        }

        const event = JSON.parse(rawBody)

        if (event.event === 'charge.success') {
            const reference = event.data?.reference
            const userId = event.data?.metadata?.user_id
            const userEmail = event.data?.metadata?.email || event.data?.customer?.email
            const amountInKobo = event.data?.amount

            if (reference && userId && amountInKobo > 0) {
                await processSuccessfulPayment(reference, userId, amountInKobo, userEmail)
            }
        }

        return NextResponse.json({ received: true })
    } catch (error) {
        console.error('Webhook processing error:', error)
        const message = error instanceof Error ? error.message : 'Webhook error'
        return NextResponse.json({ success: false, error: message }, { status: 500 })
    }
}
