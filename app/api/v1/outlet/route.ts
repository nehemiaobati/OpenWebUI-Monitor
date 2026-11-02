import { NextResponse } from 'next/server'
import { encode } from 'gpt-tokenizer/model/gpt-4'
import { pool } from '@/lib/db/client'
import { getModelInletCost } from '@/lib/utils/inlet-cost'

interface ModelPricing {
    id: string
    name: string
    input_price: number
    output_price: number
    per_msg_price: number
}

interface MessagePayload {
    content?: string
    usage?: {
        prompt_tokens?: number
        completion_tokens?: number
    }
}

function calculateModelCost(
    inputTokens: number,
    outputTokens: number,
    pricing: ModelPricing
): number {
    if (outputTokens === 0) return 0
    if (pricing.per_msg_price >= 0) return Number(pricing.per_msg_price)

    const inputCost = (inputTokens / 1_000_000) * pricing.input_price
    const outputCost = (outputTokens / 1_000_000) * pricing.output_price
    return inputCost + outputCost
}

function resolveTokens(messages: MessagePayload[]): {
    inputTokens: number
    outputTokens: number
} {
    const lastMessage = messages[messages.length - 1] || { content: '' }

    if (
        typeof lastMessage.usage?.prompt_tokens === 'number' &&
        typeof lastMessage.usage?.completion_tokens === 'number'
    ) {
        return {
            inputTokens: lastMessage.usage.prompt_tokens,
            outputTokens: lastMessage.usage.completion_tokens,
        }
    }

    const outputTokens = encode(lastMessage.content || '').length
    const totalTokens = messages.reduce(
        (sum, msg) => sum + encode(msg.content || '').length,
        0
    )
    const inputTokens = Math.max(0, totalTokens - outputTokens)

    return { inputTokens, outputTokens }
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
                {
                    success: false,
                    error: 'Missing required user or model identifier',
                    error_type: 'INVALID_PARAMETERS',
                },
                { status: 400 }
            )
        }

        // 1. Fetch Model Pricing
        const priceRes = await client.query(
            `SELECT id, name, input_price, output_price, per_msg_price 
             FROM model_prices WHERE id = $1`,
            [modelId]
        )

        const defaultInputPrice = parseFloat(
            process.env.DEFAULT_MODEL_INPUT_PRICE || '60'
        )
        const defaultOutputPrice = parseFloat(
            process.env.DEFAULT_MODEL_OUTPUT_PRICE || '60'
        )

        const pricing: ModelPricing = priceRes.rows[0]
            ? {
                  id: priceRes.rows[0].id,
                  name: priceRes.rows[0].name || priceRes.rows[0].model_name,
                  input_price: Number(priceRes.rows[0].input_price),
                  output_price: Number(priceRes.rows[0].output_price),
                  per_msg_price: Number(priceRes.rows[0].per_msg_price),
              }
            : {
                  id: modelId,
                  name: modelId,
                  input_price: defaultInputPrice,
                  output_price: defaultOutputPrice,
                  per_msg_price: -1,
              }

        // 2. Token and Cost Calculations
        const messages: MessagePayload[] = data.body?.messages || []
        const { inputTokens, outputTokens } = resolveTokens(messages)

        const totalCost = calculateModelCost(inputTokens, outputTokens, pricing)
        const inletCost = getModelInletCost(modelId)
        const actualCost = Math.max(0, totalCost - inletCost)

        // 3. Atomic Database Operations within Transaction
        await client.query('BEGIN')

        const userUpdateRes = await client.query(
            `UPDATE users 
             SET balance = LEAST(balance - CAST($1 AS DECIMAL(16,4)), 999999.9999)
             WHERE id = $2 AND NOT deleted
             RETURNING balance`,
            [actualCost, userId]
        )

        if (userUpdateRes.rows.length === 0) {
            await client.query('ROLLBACK')
            return NextResponse.json(
                {
                    success: false,
                    error: 'User not found or account is deactivated',
                    error_type: 'USER_NOT_FOUND',
                },
                { status: 404 }
            )
        }

        const newBalance = Number(userUpdateRes.rows[0].balance)

        await client.query(
            `INSERT INTO user_usage_records (
                user_id, nickname, model_name, 
                input_tokens, output_tokens, 
                cost, balance_after
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                userId,
                userName,
                modelId,
                inputTokens,
                outputTokens,
                totalCost,
                newBalance,
            ]
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
        const message =
            error instanceof Error ? error.message : 'Processing error'
        return NextResponse.json(
            {
                success: false,
                error: message,
                error_type: 'INTERNAL_SERVER_ERROR',
            },
            { status: 500 }
        )
    } finally {
        client.release()
    }
}
