import { NextResponse } from 'next/server'
import { verifyApiToken } from '@/lib/auth'

export async function POST(req: Request) {
    const authError = verifyApiToken(req)
    if (authError) {
        return authError
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
                { success: false, error: 'Paystack secret key is not configured' },
                { status: 500 }
            )
        }

        const amountInKobo = Math.round(Number(amount) * 100)

        const host = req.headers.get('host') || 'localhost:3000'
        const protocol = req.headers.get('x-forwarded-proto') || 'http'
        const fallbackUrl = `${protocol}://${host}/panel`
        const finalCallbackUrl = callback_url || (process.env.NEXT_PUBLIC_APP_URL ? `${process.env.NEXT_PUBLIC_APP_URL}/panel` : fallbackUrl)

        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${secretKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                email,
                amount: amountInKobo,
                callback_url: finalCallbackUrl,
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
