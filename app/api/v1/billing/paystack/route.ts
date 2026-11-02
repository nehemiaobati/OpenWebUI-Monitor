import { NextResponse } from 'next/server'
import { verifyApiToken } from '@/lib/auth'

interface PaystackInitPayload {
    email: string
    amount: number | string
    userId: string
    callback_url?: string
}

function resolveCallbackUrl(req: Request, explicitUrl?: string): string {
    if (explicitUrl && explicitUrl.startsWith('http')) {
        return explicitUrl
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '')
    if (appUrl) {
        return `${appUrl}/api/v1/billing/webhook`
    }

    const host = req.headers.get('host') || 'localhost:3000'
    const protocol = req.headers.get('x-forwarded-proto') || 'http'
    return `${protocol}://${host}/api/v1/billing/webhook`
}

export async function POST(req: Request) {
    const authError = verifyApiToken(req, 'ANY')
    if (authError) {
        return authError
    }

    try {
        const body = (await req.json()) as Partial<PaystackInitPayload>
        const { email, amount, userId, callback_url } = body

        if (!email || !amount || !userId) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Missing required parameters (email, amount, userId)',
                    error_type: 'INVALID_PARAMETERS',
                },
                { status: 400 }
            )
        }

        const parsedAmount = Number(amount)
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Amount must be a positive number',
                    error_type: 'INVALID_AMOUNT',
                },
                { status: 400 }
            )
        }

        const secretKey = process.env.PAYSTACK_SECRET_KEY
        if (!secretKey) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'PAYSTACK_SECRET_KEY is not configured in .env',
                    error_type: 'CONFIG_ERROR',
                },
                { status: 500 }
            )
        }

        const amountInKobo = Math.round(parsedAmount * 100)
        const finalCallbackUrl = resolveCallbackUrl(req, callback_url)

        const response = await fetch(
            'https://api.paystack.co/transaction/initialize',
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${secretKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    email: String(email).trim(),
                    amount: amountInKobo,
                    callback_url: finalCallbackUrl,
                    metadata: {
                        user_id: String(userId).trim(),
                    },
                }),
            }
        )

        const data = await response.json()

        if (!response.ok || !data.status) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        data.message ||
                        'Failed to initialize Paystack transaction',
                    error_type: 'PAYMENT_GATEWAY_ERROR',
                },
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
        return NextResponse.json(
            {
                success: false,
                error: message,
                error_type: 'INTERNAL_SERVER_ERROR',
            },
            { status: 500 }
        )
    }
}
