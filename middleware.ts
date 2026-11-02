import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl
    const apiKey = process.env.API_KEY
    const accessToken = process.env.ACCESS_TOKEN

    // Public API routes
    if (
        pathname.startsWith('/api/init') ||
        pathname.startsWith('/api/config/key') ||
        pathname.startsWith('/api/v1/billing')
    ) {
        return NextResponse.next()
    }

    // Protected API v1 endpoints
    if (pathname.startsWith('/api/v1/')) {
        const requiresAccessToken =
            pathname.startsWith('/api/v1/panel') ||
            pathname.startsWith('/api/v1/config') ||
            pathname.startsWith('/api/v1/users') ||
            pathname.startsWith('/api/v1/models')

        const expectedToken = requiresAccessToken ? accessToken : apiKey

        if (!expectedToken) {
            console.error(
                'Authentication token is not configured on the server'
            )
            return NextResponse.json(
                {
                    success: false,
                    error: 'Server configuration error',
                    error_type: 'CONFIG_ERROR',
                },
                { status: 500 }
            )
        }

        const authHeader = request.headers.get('authorization')
        const providedKey = authHeader?.replace(/^Bearer\s+/i, '').trim()

        if (!providedKey || providedKey !== expectedToken) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Unauthorized',
                    error_type: 'UNAUTHORIZED',
                },
                { status: 401 }
            )
        }

        return NextResponse.next()
    }

    // Dashboard UI pages
    if (!pathname.startsWith('/api/')) {
        if (!accessToken) {
            console.error('ACCESS_TOKEN is not set')
            return NextResponse.json(
                {
                    success: false,
                    error: 'Server configuration error',
                    error_type: 'CONFIG_ERROR',
                },
                { status: 500 }
            )
        }

        if (pathname === '/token') {
            return NextResponse.next()
        }

        const response = NextResponse.next()
        response.headers.set(
            'Cache-Control',
            'no-store, no-cache, must-revalidate, proxy-revalidate'
        )
        response.headers.set('Pragma', 'no-cache')
        response.headers.set('Expires', '0')
        return response
    }

    return NextResponse.next()
}

export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
