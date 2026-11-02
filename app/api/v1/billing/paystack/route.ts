import { NextResponse } from 'next/server'

export async function POST(req: Request) {
    const authHeader = req.headers.get('authorization')
    const token = authHeader?.replace(/^Bearer\s+/i, '')
    const apiKey = process.env.API_KEY
    const accessToken = process.env.ACCESS_TOKEN

    if (!apiKey && !accessToken) {
        return NextResponse.json(
            { success: false, error: 'Server authentication configuration error' },
            { status: 500 }
        )
    }

    const isValid = token && (token === apiKey || token === accessToken)
    if (!isValid) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    try {
        const { email, amount, userId, callback_url } = await req.json()

        if (!email || !amount || !userId) {
            return NextResponse.json(
                { success: false, error: 'Missing required parameters (email, amount, userId)' },
                { status: 400 }
            )
        }

        const numericAmount = Number(amount)
        if (isNaN(numericAmount) || numericAmount <= 0) {
            return NextResponse.json(
                { success: false, error: 'Amount must be a positive number' },
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

        const amountInKobo = Math.round(numericAmount * 100)
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '')
        const resolvedCallback = callback_url || (appUrl ? `${appUrl}/api/v1/billing/webhook` : undefined)

        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${secretKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                email,
                amount: amountInKobo,
                ...(resolvedCallback ? { callback_url: resolvedCallback } : {}),
                metadata: {
                    user_id: userId,
                    email,
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
        const message = error instanceof Error ? error.message : 'Unknown billing error'
        return NextResponse.json({ success: false, error: message }, { status: 500 })
    }
}
