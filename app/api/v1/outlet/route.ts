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

interface ChatMessage {
    role?: string
    content?: string
    usage?: {
        prompt_tokens?: number
        completion_tokens?: number
    }
}

function resolveTokenUsage(messages: ChatMessage[]): {
    inputTokens: number
    outputTokens: number
} {
    if (!messages.length) {
        return { inputTokens: 0, outputTokens: 0 }
    }

    const lastMessage = messages[messages.length - 1]
    if (
        typeof lastMessage.usage?.prompt_tokens === 'number' &&
        typeof lastMessage.usage?.completion_tokens === 'number'
    ) {
        return {
            inputTokens: Math.max(0, lastMessage.usage.prompt_tokens),
            outputTokens: Math.max(0, lastMessage.usage.completion_tokens),
        }
    }

    const lastContent = lastMessage.content || ''
    const outputTokens = encode(lastContent).length
    const totalTokens = messages.reduce(
        (sum, msg) => sum + encode(msg.content || '').length,
        0
    )
    const inputTokens = Math.max(0, totalTokens - outputTokens)

    return { inputTokens, outputTokens }
}

async function resolveModelPricing(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    modelId: string
): Promise<ModelPrice> {
    const priceRes = await client.query(
        `SELECT id, name, input_price, output_price, per_msg_price 
         FROM model_prices WHERE id = $1`,
        [modelId]
    )

    if (priceRes.rows.length > 0) {
        const row = priceRes.rows[0]
        return {
            id: row.id,
            name: row.name,
            input_price: Number(row.input_price),
            output_price: Number(row.output_price),
            per_msg_price: Number(row.per_msg_price),
        }
    }

    const defaultInputPrice = parseFloat(process.env.DEFAULT_MODEL_INPUT_PRICE || '60')
    const defaultOutputPrice = parseFloat(process.env.DEFAULT_MODEL_OUTPUT_PRICE || '60')
    const defaultPerMsgPrice = parseFloat(process.env.DEFAULT_MODEL_PER_MSG_PRICE || '-1')

    return {
        id: modelId,
        name: modelId,
        input_price: isNaN(defaultInputPrice) ? 60 : defaultInputPrice,
        output_price: isNaN(defaultOutputPrice) ? 60 : defaultOutputPrice,
        per_msg_price: isNaN(defaultPerMsgPrice) ? -1 : defaultPerMsgPrice,
    }
}

function calculateCost(
    inputTokens: number,
    outputTokens: number,
    pricing: ModelPrice
): number {
    if (outputTokens === 0) return 0
    if (pricing.per_msg_price >= 0) return pricing.per_msg_price

    const inputCost = (inputTokens / 1_000_000) * pricing.input_price
    const outputCost = (outputTokens / 1_000_000) * pricing.output_price
    return inputCost + outputCost
}

export async function POST(req: Request) {
    const client = await pool.connect()
    let inTransaction = false

    try {
        const data = await req.json()
        const modelId: string = data.body?.model
        const userId: string = data.user?.id
        const userName: string = data.user?.name || data.user?.email || 'Unknown User'

        if (!userId || !modelId) {
            return NextResponse.json(
                { success: false, error: 'Missing required user or model ID' },
                { status: 400 }
            )
        }

        const modelPricing = await resolveModelPricing(client, modelId)
        const messages: ChatMessage[] = data.body?.messages || []
        const { inputTokens, outputTokens } = resolveTokenUsage(messages)

        const totalCost = calculateCost(inputTokens, outputTokens, modelPricing)
        const inletCost = getModelInletCost(modelId)
        const actualCost = Math.max(0, totalCost - inletCost)

        await client.query('BEGIN')
        inTransaction = true

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
            [
                userId,
                userName,
                modelId,
                inputTokens,
                outputTokens,
                Number(totalCost.toFixed(4)),
                Number(newBalance.toFixed(4)),
            ]
        )

        await client.query('COMMIT')
        inTransaction = false

        return NextResponse.json({
            success: true,
            inputTokens,
            outputTokens,
            totalCost,
            newBalance,
        })
    } catch (error) {
        if (inTransaction) {
            try {
                await client.query('ROLLBACK')
            } catch (rollbackError) {
                console.error('Failed to rollback transaction:', rollbackError)
            }
        }
        const message = error instanceof Error ? error.message : 'Processing error'
        return NextResponse.json({ success: false, error: message }, { status: 500 })
    } finally {
        client.release()
    }
}
