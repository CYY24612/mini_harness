// 提供 `llm` 服务：一个流式 chat 客户端。无 inject。

import type { Ctx } from '../container.ts'

export type ToolCall = {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
}

export type Message =
    | { role: 'system' | 'user'; content: string }
    | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
    | { role: 'tool'; tool_call_id: string; content: string }

export type StreamEvent =
    | { type: 'text'; text: string }
    | { type: 'usage'; prompt: number; completion: number }

export interface AssistantMessage {
    role: 'assistant'
    content: string | null
    tool_calls?: ToolCall[]
}

export interface Llm {
    chatStream(
        messages: Message[],
        tools: unknown[],
        onEvent: (event: StreamEvent) => void,
    ): Promise<AssistantMessage>
}

const findBoundary = (buf: string): { at: number; len: number } | null => {
    const lf = buf.indexOf('\n\n')
    const crlf = buf.indexOf('\r\n\r\n')
    if (lf === -1 && crlf === -1) return null
    if (crlf !== -1 && (lf === -1 || crlf < lf)) return { at: crlf, len: 4 }
    return { at: lf, len: 2 }
}

const extractData = (block: string): string | null => {
    const parts: string[] = []
    for (const rawLine of block.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (!line.startsWith('data:')) continue
        const value = line.slice(5)
        parts.push(value.startsWith(' ') ? value.slice(1) : value)
    }
    return parts.length > 0 ? parts.join('\n') : null
}

export default function plugin(ctx: Ctx, config: any): void {
    const baseUrl = String(config.baseUrl ?? process.env.OPENAI_BASE_URL ?? '')
    const apiKey = String(process.env.OPENAI_API_KEY ?? '')
    const model = String(config.model ?? process.env.AGENT_MODEL ?? '')

    if (!baseUrl || !apiKey || !model) {
        throw new Error('llm 插件缺少配置：需要 OPENAI_API_KEY，以及 baseUrl / model（或环境变量）')
    }

    const llm: Llm = {
        async chatStream(messages, tools, onEvent) {
            const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({ model, messages, tools, stream: true }),
            })

            if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
            if (!response.body) throw new Error('响应没有 body')

            const textParts: string[] = []
            const builders = new Map<number, { id: string; name: string; args: string }>()

            const finish = (): AssistantMessage => {
                const toolCalls: ToolCall[] = [...builders.entries()]
                    .sort((a, b) => a[0] - b[0])
                    .map(([index, b]) => ({
                        id: b.id || `call_${index}`,
                        type: 'function' as const,
                        function: { name: b.name, arguments: b.args || '{}' },
                    }))
                return {
                    role: 'assistant',
                    content: textParts.join('') || null,
                    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                }
            }

            const decoder = new TextDecoder()
            let buffer = ''

            for await (const chunk of response.body) {
                buffer += decoder.decode(chunk, { stream: true })

                for (;;) {
                    const boundary = findBoundary(buffer)
                    if (!boundary) break

                    const block = buffer.slice(0, boundary.at)
                    buffer = buffer.slice(boundary.at + boundary.len)

                    const payload = extractData(block)
                    if (payload === null) continue
                    if (payload === '[DONE]') return finish()

                    let parsed: any
                    try {
                        parsed = JSON.parse(payload)
                    } catch {
                        continue
                    }

                    if (parsed.usage) {
                        onEvent({
                            type: 'usage',
                            prompt: parsed.usage.prompt_tokens ?? 0,
                            completion: parsed.usage.completion_tokens ?? 0,
                        })
                    }

                    const delta = parsed.choices?.[0]?.delta
                    if (!delta) continue

                    if (delta.content) {
                        textParts.push(delta.content)
                        onEvent({ type: 'text', text: delta.content })
                    }

                    for (const tc of delta.tool_calls ?? []) {
                        const index: number = tc.index ?? 0
                        let builder = builders.get(index)
                        if (!builder) {
                            builder = { id: '', name: '', args: '' }
                            builders.set(index, builder)
                        }
                        if (tc.id) builder.id = tc.id
                        if (tc.function?.name) builder.name = tc.function.name
                        if (tc.function?.arguments) builder.args += tc.function.arguments
                    }
                }
            }

            return finish()
        },
    }

    ctx.provide('llm', llm)
}
