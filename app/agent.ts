import { chatStream } from './provider.ts'
import type { StreamEvent } from './provider.ts'
import { tools, runTool, type Approver } from './tools.ts'
import type { ApiConfig } from './provider.ts'
import type { ChatMessage } from './types.ts'
import type { Session } from './session.ts'

export type AgentEvent =
    | StreamEvent
    | { type: 'answer-end' }
    | { type: 'tool-start'; name: string; args: string }
    | { type: 'tool-end'; content: string }
    | { type: 'step-limit' }

export async function runTurn(
    config: ApiConfig,
    session: Session,
    emit: (event: AgentEvent) => void,
    approve: Approver,
    maxSteps = 10,
): Promise<void> {
    let steps = 0
    while (true) {
        steps += 1
        if (steps > maxSteps) { emit({ type: 'step-limit' }); break }

        const message = await chatStream (
            config, 
            session.messages(), 
            tools.map(t => t.definition),
            emit
        )
        session.append({ type: 'assistant', content: message.content, tool_calls: message.tool_calls})
        if (!message.tool_calls || message.tool_calls.length === 0)
        {
            emit({ type: 'answer-end' })
            break
        }

        for (const call of message.tool_calls) {
            let content: string
            emit({ type: 'tool-start', name: call.function.name, args: call.function.arguments})

            try {
                const args = JSON.parse(call.function.arguments)
                content = await runTool(call.function.name, args, approve)
            } catch (err) {
                content = `Error: ${err instanceof Error ? err.message : String(err)}`
            }

            session.append({ type: 'tool', tool_call_id: call.id, content: content})
            emit({ type: 'tool-end', content})
            
        }
    }
}