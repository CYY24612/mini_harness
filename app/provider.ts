import type { ChatCompletion, ChatMessage, ToolDefinition } from './types.ts'

export type ApiConfig = {
    baseUrl: string
    apiKey: string
    model: string
}

export type AssistantMessage = ChatCompletion['choices'][0]['message']

export async function chat(
    config: ApiConfig,
    messages: ChatMessage[],
    tools: ToolDefinition[],
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
        }),
    })

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    }

    const data = (await response.json()) as ChatCompletion
    return data.choices[0].message
}

export async function chatStream(
    config: ApiConfig,
    messages: ChatMessage[],
    onDelta: (text: string) => void,     // ← 注意这个参数
): Promise<string> {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            model: config.model,
            messages,
        }),
    })

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    }

    let buffer = '' 
    let full = ''
    let inThinking = false
    const decoder = new TextDecoder()
    if (!response.body) throw new Error('响应没有 body')
    for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        
        while (buffer.indexOf('\n\n') !== -1)
        {
            const p = buffer.indexOf('\n\n')
            const event = buffer.slice(0, p)
            buffer = buffer.slice(p + 2)
            
            const payload = event.slice(5).trim()
            if (payload === '[DONE]') break
            
            const parsed = JSON.parse(payload)
            // const think = parsed.choices?.[0]?.delta?.reasoning_content
            // if (think) {
            //     if (!inThinking) { process.stdout.write('\n💭 '); inThinking = true }
            //     process.stdout.write(think)
            // }
            const piece = parsed.choices?.[0]?.delta?.content
            if (piece) {
                // if (inThinking) { process.stdout.write('\n\n'); inThinking = false }
                process.stdout.write(piece)
                full += piece
            }
        }
        
    }
    return full
}