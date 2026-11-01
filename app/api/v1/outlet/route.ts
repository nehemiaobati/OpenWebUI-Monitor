import { NextResponse } from 'next/server'
import { encode } from 'gpt-tokenizer/model/gpt-4'
import { pool } from '@/lib/db/client'
import { getModelInletCost } from '@/lib/utils/inlet-cost'

interface ModelPrice {
    id: string
    name: string
    input_price: number
    output_price: number
    per_msg_price: number
}

function calculateCost(
    inputTokens: number,
    outputTokens: number,
    modelPrice: ModelPrice
): number {
    if (outputTokens === 0) return 0
    if (modelPrice.per_msg_price >= 0) return Number(modelPrice.per_msg_price)

    const inputCost = (inputTokens / 1_000_000) * modelPrice.input_price
    const outputCost = (outputTokens / 1_000_000) * modelPrice.output_price
    return inputCost + outputCost
}

export async function POST(req: Request) {
    const client = await pool.connect()

    try {
        const data = await req.json()
        const modelId: string = data.body?.model
        const userId: string = data.user?.id
        const userName: string = data.user?.name || 'Unknown User'

        if (!userId || !modelId) {
            return NextResponse.json(
                { success: false, error: 'Missing required user or model ID' },
                { status: 400 }
            )
        }

        // 1. Fetch Model Pricing (Read before starting transaction to minimize lock time)
        const priceRes = await client.query(
            `SELECT id, name, input_price, output_price, per_msg_price 
             FROM model_prices WHERE id = $1`,
            [modelId]
        )

        const defaultPrice = parseFloat(process.env.DEFAULT_MODEL_INPUT_PRICE || '60')
        const modelPrice: ModelPrice = priceRes.rows[0] || {
            id: modelId,
            name: modelId,
            input_price: defaultPrice,
            output_price: parseFloat(process.env.DEFAULT_MODEL_OUTPUT_PRICE || '60'),
            per_msg_price: -1,
        }

        // 2. Token Calculation
        const messages = data.body.messages || []
        const lastMessage = messages[messages.length - 1] || { content: '' }

        let inputTokens: number
        let outputTokens: number

        if (lastMessage.usage?.prompt_tokens && lastMessage.usage?.completion_tokens) {
            inputTokens = lastMessage.usage.prompt_tokens
            outputTokens = lastMessage.usage.completion_tokens
        } else {
            outputTokens = encode(lastMessage.content || '').length
            const totalTokens = messages.reduce(
                (sum: number, msg: { content: string }) => sum + encode(msg.content || '').length,
                0
            )
            inputTokens = Math.max(0, totalTokens - outputTokens)
        }

        const totalCost = calculateCost(inputTokens, outputTokens, modelPrice)
        const inletCost = getModelInletCost(modelId)
        const actualCost = Math.max(0, totalCost - inletCost)

        // 3. Atomic Database Operations on the Single Client Connection
        await client.query('BEGIN')

        const userUpdateRes = await client.query(
            `UPDATE users 
             SET balance = LEAST(balance - CAST($1 AS DECIMAL(16,4)), 999999.9999)
             WHERE id = $2 AND NOT deleted
             RETURNING balance`,
            [actualCost, userId]
        )

        if (userUpdateRes.rows.length === 0) {
            throw new Error('User not found or account is deactivated')
        }

        const newBalance = Number(userUpdateRes.rows[0].balance)

        await client.query(
            `INSERT INTO user_usage_records (
                user_id, nickname, model_name, 
                input_tokens, output_tokens, 
                cost, balance_after
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [userId, userName, modelId, inputTokens, outputTokens, totalCost, newBalance]
        )

        await client.query('COMMIT')

        return NextResponse.json({
            success: true,
            inputTokens,
            outputTokens,
            totalCost,
            newBalance,
        })
    } catch (error) {
        await client.query('ROLLBACK')
        const message = error instanceof Error ? error.message : 'Processing error'
        return NextResponse.json({ success: false, error: message }, { status: 500 })
    } finally {
        client.release()
    }
}
