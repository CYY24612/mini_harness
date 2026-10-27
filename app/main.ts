import { createInterface } from 'node:readline/promises'
import type { ChatMessage } from './types.ts'
import type { ApiConfig } from './provider.ts'
import { runTurn } from './agent.ts'
import type { AgentEvent } from './agent.ts'
import { tools, type Approver } from './tools.ts'
import { createSession, loadEvents } from './session.ts'

const sessionId = 'default'
const sessionFile = `./session/${sessionId}.jsonl`

const wantResume = process.argv.includes('--resume')

const system = buildSystemPrompt()
const oldEvents = wantResume ? loadEvents(sessionFile) : []

const session = createSession({ id: sessionId, system, file: sessionFile, events: oldEvents })

console.log(wantResume
    ? `已恢复会话 ${sessionId}（${oldEvents.length} 条事件）`
    : `新会话 ${sessionId}`)
console.log(`日志：${sessionFile}\n`)

try { process.loadEnvFile('.env') } catch {}

const r1 = createInterface({ input: process.stdin, output: process.stdout})

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

const history: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() }
]

const apiKey = process.env.OPENAI_API_KEY
const baseUrl = process.env.OPENAI_BASE_URL
const model = process.env.AGENT_MODEL

if (!apiKey || !baseUrl || !model) {
    console.error('缺少环境变量：OPENAI_API_KEY / OPENAI_BASE_URL / AGENT_MODEL（检查 .env）')
    process.exit(1)
}

const config: ApiConfig = { baseUrl, apiKey, model }

const approve: Approver = async ({ tool, args }) => {
    const answer = await r1.question(
        `\n  ⚠️  即将执行 ${tool} ${JSON.stringify(args)}\n  允许吗？(y/N) `
    )
    return answer.trim().toLowerCase() === 'y'
}

async function main() {
    for (const t of tools) {
        const { name, parameters } = t.definition.function
        for (const req of parameters.required ?? []) {
            if (!(req in (parameters.properties ?? {}))) {
                console.warn(`⚠️ 工具 ${name}：required 里的 "${req}" 没有在 properties 声明`)
            }
        }
    }
    
    for (;;)
    {
        const answer = await r1.question('你 > ')
        if (answer === 'break') break;

        const mark = session.events.length
        session.append({ type: 'user', content: answer })
        
        try {
            await runTurn(config, session, render, approve)

        } catch (err) {
            console.log('\n请求失败:', err instanceof Error ? err.message : String(err))
            session.truncate(mark)
        }

    }
    r1.close()
}

function render(event: AgentEvent): void {
    switch (event.type) {
        case 'text':       process.stdout.write(event.text); break
        case 'thinking':   process.stdout.write('💭 思考中…'); break
        case 'thinking-end':   process.stdout.write('\n'); break
        case 'answer-end': console.log(); break
        case 'tool-start': console.log(`\n⚙ ${event.name} ${event.args}`); break
        case 'tool-end':   console.log(`  → ${event.content.split('\n')[0].slice(0, 80)}`); break
        case 'step-limit': console.log('\n[达到步数上限，强制结束这一轮对话]'); break
        case 'usage':
            console.log(
                `  ⤷ 上下文 ${event.prompt} tokens · 输出 ${event.completion}` +
                (event.reasoning > 0 ? `（其中思考 ${event.reasoning}）` : '')
            )
            break
    }
}

await main()