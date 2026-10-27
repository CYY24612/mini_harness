import { parse } from 'path'
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
    | { type: 'usage'; prompt: number; completion: number; reasoning: number }

export type AssistantMessage = ChatCompletion['choices'][0]['message']

function nextBoundary(buf: string): { index: number; length: number } | null {
    const lf = buf.indexOf('\n\n')
    const crlf = buf.indexOf('\r\n\r\n')
    if (lf === -1 && crlf === -1) return null
    if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 }
    return { index: lf, length: 2 }
}

function extractData(block: string): string | null {
    const parts: string[] = []
    for (const rawLine of block.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (line === '') continue
        if (line.startsWith(':')) continue          // 注释 / 心跳
        if (!line.startsWith('data:')) continue     // event: / id: / retry: 忽略
        const value = line.slice(5)
        parts.push(value.startsWith(' ') ? value.slice(1) : value)
    }
    return parts.length > 0 ? parts.join('\n') : null
}

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
    let inThinking = false

    outer: for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        
        while (true)
        {
            const boundary = nextBoundary(buffer)
            if (!boundary) break
            
            const block = buffer.slice(0, boundary.index)
            buffer = buffer.slice(boundary.index + boundary.length)
            
            const payload = extractData(block)
            if (payload === null) continue
            if (payload === '[DONE]') break outer
            
            let parsed: any
            try {
                parsed = JSON.parse(payload)
            } catch {
                throw new Error(`SSE 载荷不是合法 JSON: ${payload.slice(0, 200)}`)
            }
            
            if (parsed.usage) {
                onEvent({
                    type: 'usage',
                    prompt: parsed.usage.prompt_tokens ?? 0,
                    completion: parsed.usage.completion_tokens ?? 0,
                    reasoning: parsed.usage.completion_tokens_details?.reasoning_tokens ?? 0,
                })
            }
            
            const delta = parsed.choices?.[0]?.delta
            if (!delta) continue

            if (delta.reasoning_content && !inThinking) {
                inThinking = true
                onEvent({ type: 'thinking' })
            }
            if (delta.content) {
                if (inThinking) {
                    inThinking = false
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