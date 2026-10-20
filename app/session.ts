import { appendFileSync, existsSync, mkdirSync, readFileSync, truncate, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatMessage, ToolCall } from "./types.ts";

export type SessionEvent = 
    | { seq: number; at: string; type: 'user'; content: string }
    | { seq: number; at: string; type: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
    | { seq: number; at: string; type: 'tool'; tool_call_id: string; content: string }

export type SessionEventDraft = 
    | { type: 'user'; content: string }
    | { type: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
    | { type: 'tool'; tool_call_id: string; content: string }

export interface Session {
    readonly id: string
    readonly events: readonly SessionEvent[]
    append(draft: SessionEventDraft): void
    messages(): ChatMessage[]
    truncate(length: number): void
}

export interface SessionOptions {
    id: string
    system: string
    file?: string
    events?: SessionEvent[]
}

export function createSession(options: SessionOptions) : Session {
    const events: SessionEvent[] = options.events ? [...options.events] : []
    let counter = events.reduce((max, e) => Math.max(max, e.seq), 0)

    if (options.file) {
        mkdirSync(dirname(options.file), { recursive: true })
    }

    const rewrite = () => {
        if (!options.file) return
        const text = events.map(e => JSON.stringify(e)).join('\n')
        writeFileSync(options.file, text + (events.length > 0 ? '\n' : ''), 'utf8')
    }

    return {
        id: options.id,
        
        get events() {
            return events
        },

        append(draft) {
            counter += 1
            const event = { ...draft, seq: counter, at: new Date().toISOString() } as SessionEvent
            events.push(event)

            if (options.file) {
                appendFileSync(options.file, JSON.stringify(event) + '\n', 'utf8')
            }
        },

        messages() {
            const out: ChatMessage[] = [{ role: 'system', content: options.system }]
            for (const e of events) {
                if (e.type === 'user') {
                    out.push({ role: 'user', content: e.content })
                } else if (e.type === 'assistant') {
                    out.push({ role: 'assistant', content: e.content, tool_calls: e.tool_calls })
                } else {
                    out.push({ role: 'tool', tool_call_id: e.tool_call_id, content: e.content})
                }
            }
            return out
        },

        truncate(length) {
            events.length = length
            rewrite()
        },
    }
}

export function loadEvents(file: string): SessionEvent[] {
    if (!existsSync(file)) return []
    const raw = readFileSync(file, 'utf8')
    const out: SessionEvent[] = []
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
            out.push(JSON.parse(line) as SessionEvent)
        } catch {

        }
    }
    return out
}