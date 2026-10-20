import type { Tool } from './tools.ts'
import type { ChatCompletion, ChatMessage, ToolCall, ToolDefinition } from './types.ts'

export type ApiConfig = {
    baseUrl: string
    apiKey: string
    model: string
}

export type StreamEvent = 
    | { type: 'text'; text: string }
    | { type: 'thinking' }
    | { type: 'thinking-end' }

export type AssistantMessage = ChatCompletion['choices'][0]['message']

export async function chatStream(
    config: ApiConfig,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onEvent: (event: StreamEvent) => void,
): Promise<AssistantMessage> {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            model: config.model,
            messages,
            tools,
            stream: true,
        }),
    })

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    }

    if (!response.body) {
        throw new Error(`响应没有 body`)
    }

    const textParts: string[] = []
    const builders = new Map<number, { id: string; name: string; args: string }>()

    const decoder = new TextDecoder()
    let buffer = ''
    let inTinking = false

    outer: for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        
        while (buffer.indexOf('\n\n') !== -1)
        {
            const p = buffer.indexOf('\n\n')
            const event = buffer.slice(0, p)
            buffer = buffer.slice(p + 2)
            
            const payload = event.slice(5).trim()
            if (payload === '[DONE]') break outer
            
            let parsed: any
            try {
                parsed = JSON.parse(payload)
            } catch {
                continue
            }
            
            const delta = parsed.choices?.[0]?.delta
            if (!delta) continue

            if (delta.reasoning_content && !inTinking) {
                inTinking = true
                onEvent({ type: 'thinking' })
            }
            if (delta.content) {
                if (inTinking) {
                    inTinking = false
                    onEvent({ type: 'thinking-end' })
                }
                onEvent({ type: 'text', text: delta.content })
                textParts.push(delta.content)
            }

            for (const tc of delta.tool_calls ?? []) {
                const index: number = tc.index ?? 0

                let b = builders.get(index)
                if (!b) {
                    b = { id: '', name: '', args: '' }
                    builders.set(index, b)
                }

                if (tc.id) b.id = tc.id
                if (tc.function?.name) b.name = tc.function.name
                if (tc.function?.arguments) b.args += tc.function.arguments
            }
        }
        
    }
    
    const toolCalls: ToolCall[] = [...builders.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, b]): ToolCall => ({
            id: b.id || `call_${index}`,
            type: 'function',
            function: {
                name: b.name,
                arguments: b.args || '{}',
            },
        }))

    return {
        role: 'assistant',
        content: textParts.join('') || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined
    }
}