import { createInterface } from 'node:readline/promises'
import type { ChatMessage } from './types.ts'
import type { ApiConfig } from './provider.ts'
import { runTurn } from './agent.ts'
import type { AgentEvent } from './agent.ts'
import { tools } from './tools.ts'
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

        const mark = history.length
        history.push({ role: 'user', content: answer })
        

        try {
            await runTurn(config, history, render)

        } catch (err) {
            console.log('\n请求失败:', err instanceof Error ? err.message : String(err))
            history.length = mark
        }

    }
    r1.close()
}

function render(event: AgentEvent): void {
    switch (event.type) {
        case 'tool-start': console.log(`\n⚙ ${event.name} ${event.args}`); break
        case 'tool-end':   console.log(`  → ${event.content.split('\n')[0].slice(0, 80)}`); break
        case 'answer':     console.log(event.text); break
        case 'step-limit': console.log('\n[达到步数上限，强制结束这一轮对话]'); break
    }
}

await main()