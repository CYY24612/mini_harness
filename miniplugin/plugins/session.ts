// 提供 `session` 服务：内存版的事件日志 + 投影。无 inject。
//
// 注意 SessionEvent 的定义方式：**只写一次** draft，事件类型从它派生。
// 这就是那个 'usr' 拼写事故的教训 —— 同一个名字写两遍，就一定会漂移。

import type { Ctx } from '../container.ts'

export type SessionEventDraft =
    | { type: 'user'; content: string }
    | { type: 'assistant'; content: string | null; tool_calls?: any[] }
    | { type: 'tool'; tool_call_id: string; content: string }

export type SessionEvent = SessionEventDraft & { seq: number }

export interface Session {
    readonly events: readonly SessionEvent[]
    append(draft: SessionEventDraft): void
    /** 投影：事件 → 发给模型的消息（每次现算） */
    messages(): any[]
}

export default function plugin(ctx: Ctx, config: any): void {
    const system = String(config.system ?? '你是一个本地 coding agent。回答简洁，先看清现状再动手。')

    const events: SessionEvent[] = []
    let seq = 0

    const session: Session = {
        get events() {
            return events
        },

        append(draft) {
            seq += 1
            events.push({ ...draft, seq } as SessionEvent)
        },

        messages() {
            const out: any[] = [{ role: 'system', content: system }]
            for (const event of events) {
                if (event.type === 'user') {
                    out.push({ role: 'user', content: event.content })
                } else if (event.type === 'assistant') {
                    out.push({ role: 'assistant', content: event.content, tool_calls: event.tool_calls })
                } else {
                    out.push({ role: 'tool', tool_call_id: event.tool_call_id, content: event.content })
                }
            }
            return out
        },
    }

    ctx.provide('session', session)
}
