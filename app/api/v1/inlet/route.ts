import { NextResponse } from 'next/server'
import { getOrCreateUser } from '@/lib/db/users'
import { query } from '@/lib/db/client'
import { getModelInletCost } from '@/lib/utils/inlet-cost'

export async function POST(req: Request) {
    try {
        const data = await req.json()

        if (!data?.user?.id) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'User information with valid ID is required',
                    error_type: 'INVALID_REQUEST',
                },
                { status: 400 }
            )
        }

        const user = await getOrCreateUser(data.user)
        const modelId = data.body?.model

        // 1. Account status check
        if (user.deleted) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'User account deactivated',
                    error_type: 'ACCOUNT_DEACTIVATED',
                },
                { status: 403 }
            )
        }

        const currentBalance = Number(user.balance)

        // 2. Reject immediately if balance is non-positive
        if (currentBalance <= 0) {
            return NextResponse.json(
                {
                    success: false,
                    balance: currentBalance,
                    error: 'Insufficient balance. Please recharge your account.',
                    error_type: 'INSUFFICIENT_BALANCE',
                },
                { status: 402 }
            )
        }

        const inletCost = getModelInletCost(modelId)

        // 3. Pre-deduct initialization cost if model has an inlet surcharge
        if (inletCost > 0) {
            if (currentBalance < inletCost) {
                return NextResponse.json(
                    {
                        success: false,
                        balance: currentBalance,
                        error: 'Insufficient balance for model initialization.',
                        error_type: 'INSUFFICIENT_BALANCE',
                    },
                    { status: 402 }
                )
            }

            const updated = await query(
                `UPDATE users 
                 SET balance = balance - CAST($1 AS DECIMAL(16,4))
                 WHERE id = $2 AND NOT deleted
                 RETURNING balance`,
                [inletCost, user.id]
            )

            if (updated.rows.length === 0) {
                return NextResponse.json(
                    {
                        success: false,
                        error: 'User not found or account deactivated',
                        error_type: 'USER_NOT_FOUND',
                    },
                    { status: 404 }
                )
            }

            return NextResponse.json({
                success: true,
                balance: Number(updated.rows[0].balance),
                inlet_cost: inletCost,
            })
        }

        return NextResponse.json({
            success: true,
            balance: currentBalance,
        })
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'Inlet processing error'
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
