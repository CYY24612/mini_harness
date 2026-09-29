import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
try { process.loadEnvFile('.env') } catch {}

const r1 = createInterface({ input: process.stdin, output: process.stdout})

type ChatCompletion = {
    choices: Array<{
        finish_reason: string
        message: {
            role: string
            content: string | null
            tool_calls?: ToolCall[]
        }
    }>
}

type ToolCall = {
    id: string
    type: "function"
    function: {
        name: string
        arguments: string
    }
}

type ChatMessage = 
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
    | { role: 'tool'; tool_call_id: string; content: string }

const history: ChatMessage[] = []

const isStrem = false

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
    console.log('缺少 OPENAI_API_KEY')
    process.exit(1)
}

const baseUrl = process.env.OPENAI_BASE_URL
const model = process.env.AGENT_MODEL

const tools = [{
                type: "function",
                function: {
                    name: "read_file",
                    description: "读取文件内容",
                    parameters: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "文件路径"}
                        },
                        required: ["path"]
                    }
                }
            }]

for (;;)
{

    const answer = await r1.question('你 > ')
    if (answer === 'break') break;

    history.push({ role: 'user', content: answer })
    
    const mark = history.length

    try {

        const body = isStrem
            ? { model, messages: history, tools, stream: true }
            : { model, messages: history, tools }
        


        if (isStrem) {
            const response = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify(body),
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
            console.log()
            history.push({ role: 'assistant', content: full})
        }
        else {
            let steps = 0
            while(true)
            {
                steps += 1
                if (steps > 10) {
                    console.log('\n[达到步数上限，强制结束这一轮对话]')
                    break
                }
                const response = await fetch(`${baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify(body),
                })
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${await response.text()}`)
                }

                const data = (await response.json()) as ChatCompletion
                const message = data.choices[0].message
                history.push({ role: 'assistant', content: message.content, tool_calls: message.tool_calls})

                if (!message.tool_calls || message.tool_calls.length === 0)
                {
                    console.log(message.content)
                    break
                }
                else {
                    for (const call of message.tool_calls)
                    {
                        const args = JSON.parse(call.function.arguments)
                        if (call.function.name === "read_file")
                        {
                            const fileData = await readFile(args.path, 'utf8')
                            history.push({ role: 'tool', tool_call_id: call.id, content: fileData})
                        }
                    }
                }
            }
        }

    } catch (err) {
        console.log('\n请求失败:', err instanceof Error ? err.message : String(err))
        history.length = mark
        continue
    }
}
r1.close()