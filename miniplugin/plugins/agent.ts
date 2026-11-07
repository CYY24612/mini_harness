// 提供 `agent` 服务：agent 循环本体。
// inject: ['llm', 'session', 'tools'] —— 三个依赖让容器排出正确顺序。
//
// 这就是 DSH 的 dsh-agent-loop 的等价物。它自己不知道 llm 是怎么实现的、
// session 存在哪、工具有哪几个 —— 全部通过服务名拿到。

import type { Ctx } from '../container.ts'
import type { Llm } from './llm.ts'
import type { Session } from './session.ts'
import type { Approver, Toolbox } from './tools.ts'

export type AgentEvent =
    | { type: 'text'; text: string }
    | { type: 'usage'; prompt: number; completion: number }
    | { type: 'tool-start'; name: string; args: string }
    | { type: 'tool-end'; content: string }

export interface Agent {
    runTurn(emit: (event: AgentEvent) => void, approve: Approver): Promise<void>
}

export default function plugin(ctx: Ctx, config: any): void {
    const llm = ctx.get<Llm>('llm')
    const session = ctx.get<Session>('session')
    const toolbox = ctx.get<Toolbox>('tools')
    const maxSteps = Number(config.maxSteps ?? 8)

    const agent: Agent = {
        async runTurn(emit, approve) {
            for (let step = 1; step <= maxSteps; step += 1) {
                // emit 的类型是 (AgentEvent) => void，能直接传给只认 StreamEvent 的 llm
                // —— 因为 AgentEvent 包含 StreamEvent 的所有成员（结构类型 + 参数逆变）
                const message = await llm.chatStream(session.messages(), toolbox.definitions, emit)

                session.append({
                    type: 'assistant',
                    content: message.content,
                    tool_calls: message.tool_calls,
                })

                if (!message.tool_calls || message.tool_calls.length === 0) return

                for (const call of message.tool_calls) {
                    emit({ type: 'tool-start', name: call.function.name, args: call.function.arguments })

                    let content: string
                    try {
                        const toolArgs = JSON.parse(call.function.arguments)
                        content = await toolbox.run(call.function.name, toolArgs, approve)
                    } catch (err) {
                        content = `Error: ${err instanceof Error ? err.message : String(err)}`
                    }

                    session.append({ type: 'tool', tool_call_id: call.id, content })
                    emit({ type: 'tool-end', content })
                }
            }

            throw new Error(`超过 ${maxSteps} 步上限，本轮强制结束`)
        },
    }

    ctx.provide('agent', agent)
}
