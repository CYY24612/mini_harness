import { readFile, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
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

type ToolDefinition = {
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
const tools: ToolDefinition[] = [{
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
                },
                {
                type: "function",
                function: {
                    name: "list_dir",
                    description: "列出目录里内容",
                    parameters: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "目录路径"}
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
                        let content: string
                        console.log(`\n⚙ ${call.function.name} ${call.function.arguments}`)
                        try {
                            const args = JSON.parse(call.function.arguments)
                            if (call.function.name === "read_file")
                            {
                                const fileData = await readFile(args.path, 'utf8')
                                content = fileData
                            } else if (call.function.name === "list_dir")
                            {
                                const entries: Dirent[] = await readdir(args.path, { withFileTypes: true });
                                const onlyFiles = entries.filter(entry => entry.isFile()).map(entry => entry.name);
                                const onlyDirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
                                content = formatDirContent(onlyFiles, onlyDirs)
                            } else {
                                content = `Error: 没有名为 "${call.function.name}" 的工具。可用工具：read_file、list_dir。`
                            }
                        } catch (err) {
                            content = `Error: ${err instanceof Error ? err.message : String(err)}`
                        }
                        history.push({ role: 'tool', tool_call_id: call.id, content: content})
                        console.log(`  → ${content.split('\n')[0].slice(0, 80)}`)
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

function formatDirContent(onlyFiles: string[], onlyDirs: string[]): string {
  const fileText = onlyFiles.length > 0
    ? onlyFiles.map(name => `- ${name}`).join('\n')
    : '（无文件）';

  const dirText = onlyDirs.length > 0
    ? onlyDirs.map(name => `- ${name}`).join('\n')
    : '（无目录）';

  return `文件：\n${fileText}\n\n目录：\n${dirText}`;
}