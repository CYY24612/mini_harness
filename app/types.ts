
export type ToolCall = {
    id: string
    type: "function"
    function: {
        name: string
        arguments: string
    }
}

export type ChatMessage = 
    | { role: 'system'; content: string }
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
    | { role: 'tool'; tool_call_id: string; content: string }

export type ChatCompletion = {
    choices: Array<{
        finish_reason: string
        message: {
            role: string
            content: string | null
            tool_calls?: ToolCall[]
        }
    }>
}

export type ToolDefinition = {
    type: "function",
    function: {
        name: string
        description: string
        parameters: {
            type: "object",
            properties: Record<string, unknown>
            required?: string[]
        }
    }
}