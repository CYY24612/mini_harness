import { readFile, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { resolve, relative, isAbsolute, sep, basename, extname } from 'node:path'
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
    | { role: 'system'; content: string }
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
    | { role: 'tool'; tool_call_id: string; content: string }

const history: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() }
]

function buildSystemPrompt(projectDesc: string = "一个本地 coding agent 实验项目"): string {
    const cwd = process.cwd()

    return `你是运行在用户本机上的 coding agent。

工作目录：${cwd}
（所有工具的路径参数都相对于它，"." 表示当前目录）

这个项目：${projectDesc}

工作方式：
- 先看清现状再回答，不要凭猜测
- 回答简洁

边界：
- 只能访问工作目录内的文件
- .env 等敏感文件被禁止访问。被拒绝时不要尝试其他写法绕过。`
}

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

async function main() {
    for (;;)
    {

        const answer = await r1.question('你 > ')
        if (answer === 'break') break;

        const mark = history.length
        history.push({ role: 'user', content: answer })
        

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
                                    const abs = resolveInCwd(args.path)
                                    assertNotSecret(abs)
                                    const fileData = await readFile(abs, 'utf8')
                                    content = fileData
                                } else if (call.function.name === "list_dir")
                                {
                                    const abs = resolveInCwd(args.path)
                                    const entries: Dirent[] = await readdir(abs, { withFileTypes: true });
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
}


function formatDirContent(onlyFiles: string[], onlyDirs: string[]): string {
  const fileText = onlyFiles.length > 0
    ? onlyFiles.map(name => `- ${name}`).join('\n')
    : '（无文件）';

  const dirText = onlyDirs.length > 0
    ? onlyDirs.map(name => `- ${name}`).join('\n')
    : '（无目录）';

  return `文件：\n${fileText}\n\n目录：\n${dirText}`;
}

function resolveInCwd(input: string): string {
    const root = process.cwd()
    const abs = resolve(root, input)
    const rel = relative(root, abs)

    const outside = 
        rel === '..' ||
        rel.startsWith('..' + sep) ||
        isAbsolute(rel)

    if (outside) {
        throw new Error(
            `路径越界 —— "${input}" 不在工作目录内。` +
            `当前工作目录是 ${root}，只能访问这个目录下的内容。`
        )
    }
    return abs
}

// ============ 黑名单定义 ============

// 1. 前缀匹配：文件名以这些字符串开头就禁止
//    例：.env、.env.local、.env.production 都被 .env 前缀命中
const BLOCKED_PREFIXES: string[] = [
    '.env',          // .env / .env.local / .env.prod
    '.aws',          // .aws/credentials 等
    '.ssh',          // .ssh 目录下的文件
    'id_rsa',        // id_rsa / id_rsa.pub
    'id_ed25519',    // id_ed25519 / id_ed25519.pub
    'id_ecdsa',
    'id_dsa',
    '.npmrc',
    '.pypirc',
    '.netrc',
    '.git-credentials',
]

// 2. 固定名匹配：文件名必须完全等于其中之一
const BLOCKED_NAMES: string[] = [
    '.env',              // 这个其实也会被前缀命中，但写在这里更明确
    'credentials',
    'credentials.json',
    'secrets.json',
    'secrets.yaml',
    'secrets.yml',
    'master.key',
    'config.json',       // 按需启用
]

// 3. 后缀匹配：文件扩展名（带点，小写）命中就禁止
const BLOCKED_EXTS: string[] = [
    '.pem',
    '.key',
    '.p12',
    '.pfx',
    '.jks',
    '.keystore',
    '.crt',              // 按需启用
    '.cer',
]

// ============ 检查函数 ============

export function assertNotSecret(abs: string): void {
    const name = basename(abs).toLowerCase()
    const ext  = extname(name).toLowerCase()

    // 1. 前缀匹配
    for (const prefix of BLOCKED_PREFIXES) {
        if (name.startsWith(prefix.toLowerCase())) {
            throw new Error(
                `Error: 禁止访问敏感文件 —— "${name}" 匹配前缀 "${prefix}"。`
            )
        }
    }

    // 2. 固定名匹配
    for (const blocked of BLOCKED_NAMES) {
        if (name === blocked.toLowerCase()) {
            throw new Error(
                `Error: 禁止访问敏感文件 —— "${name}" 在固定名黑名单中。`
            )
        }
    }

    // 3. 后缀匹配
    for (const blockedExt of BLOCKED_EXTS) {
        if (ext === blockedExt.toLowerCase()) {
            throw new Error(
                `Error: 禁止访问敏感文件 —— 后缀 "${ext}" 属于敏感类型。`
            )
        }
    }
}

main()