import { NextResponse } from 'next/server'

export type AuthTokenType = 'ACCESS_TOKEN' | 'API_KEY' | 'ANY'

export function verifyApiToken(
    req: Request,
    type: AuthTokenType = 'ACCESS_TOKEN'
): NextResponse | null {
    const accessToken = process.env.ACCESS_TOKEN
    const apiKey = process.env.API_KEY

    const authHeader = req.headers.get('authorization')
    const token = authHeader?.replace(/^Bearer\s+/i, '').trim()

    if (!token) {
        return NextResponse.json(
            {
                success: false,
                error: 'Missing Authorization header',
                error_type: 'UNAUTHORIZED',
            },
            { status: 401 }
        )
    }

    let isValid = false
    if (type === 'ACCESS_TOKEN') {
        isValid = Boolean(accessToken && token === accessToken)
    } else if (type === 'API_KEY') {
        isValid = Boolean(apiKey && token === apiKey)
    } else if (type === 'ANY') {
        isValid = Boolean(
            (accessToken && token === accessToken) ||
            (apiKey && token === apiKey)
        )
    }

    if (!isValid) {
        return NextResponse.json(
            {
                success: false,
                error: 'Unauthorized',
                error_type: 'UNAUTHORIZED',
            },
            { status: 401 }
        )
    }

    return null
}
