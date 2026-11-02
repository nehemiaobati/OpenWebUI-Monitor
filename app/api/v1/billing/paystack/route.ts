import { NextResponse } from 'next/server'

export async function POST(req: Request) {
    // Authenticate with either API_KEY or ACCESS_TOKEN
    const authHeader = req.headers.get('authorization')
    const token = authHeader?.replace('Bearer ', '')
    const isValid =
        token &&
        (token === process.env.API_KEY || token === process.env.ACCESS_TOKEN)

    if (!isValid) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    try {
        const { email, amount, userId, callback_url } = await req.json()

        if (!email || !amount || !userId) {
            return NextResponse.json(
                { success: false, error: 'Missing required parameters (email, amount, userId)' },
                { status: 400 }
            )
        }

        const secretKey = process.env.PAYSTACK_SECRET_KEY
        if (!secretKey) {
            return NextResponse.json(
                { success: false, error: 'PAYSTACK_SECRET_KEY is not configured in .env' },
                { status: 500 }
            )
        }

        const amountInKobo = Math.round(Number(amount) * 100)

        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${secretKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                email,
                amount: amountInKobo,
                callback_url: callback_url || `${process.env.NEXT_PUBLIC_APP_URL || ''}/api/v1/billing/webhook`,
                metadata: {
                    user_id: userId,
                },
            }),
        })

        const data = await response.json()

        if (!response.ok || !data.status) {
            return NextResponse.json(
                { success: false, error: data.message || 'Failed to initialize Paystack transaction' },
                { status: 400 }
            )
        }

        return NextResponse.json({
            success: true,
            data: {
                authorization_url: data.data.authorization_url,
                reference: data.data.reference,
                access_code: data.data.access_code,
            },
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return NextResponse.json({ success: false, error: message }, { status: 500 })
    }
}
