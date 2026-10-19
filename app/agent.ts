import { chat } from './provider.ts'
import { tools, runTool } from './tools.ts'
import type { ApiConfig } from './provider.ts'
import type { ChatMessage } from './types.ts'

export type AgentEvent =
    | { type: 'tool-start'; name: string; args: string }
    | { type: 'tool-end'; content: string }
    | { type: 'answer'; text: string }
    | { type: 'step-limit' }

export async function runTurn(
    config: ApiConfig,
    history: ChatMessage[],
    emit: (event: AgentEvent) => void,
    maxSteps = 10,
): Promise<void> {
    let steps = 0
    while (true) {
        steps += 1
        if (steps > maxSteps) { emit({ type: 'step-limit' }); break }

        const message = await chat (config, history, tools.map(t => t.definition))
        history.push({ role: 'assistant', content: message.content, tool_calls: message.tool_calls})
        if (!message.tool_calls || message.tool_calls.length === 0)
        {
            emit({ type: 'answer', text: message.content ?? '' })
            break
        }

        for (const call of message.tool_calls) {
            let content: string
            emit({ type: 'tool-start', name: call.function.name, args: call.function.arguments})

            const args = JSON.parse(call.function.arguments)
            try {
                content = await runTool(call.function.name, args)
            } catch (err) {
                content = `Error: ${err instanceof Error ? err.message : String(err)}`
            }

            history.push({ role: 'tool', tool_call_id: call.id, content: content})
            emit({ type: 'tool-end', content})
            
        }
    }
}