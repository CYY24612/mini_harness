// 提供 `main` 服务：交互式 REPL —— 这就是一个"产品"。
// inject: ['agent', 'session']
//
// 它只提供一个 run()，真正的执行由 launcher（main.ts）触发。
// 这样"装配"和"运行"是分开的两步 —— 你才能用 --dry 只看装配。

import { createInterface } from 'node:readline/promises'
import type { Ctx } from '../container.ts'
import type { Agent, AgentEvent } from './agent.ts'
import type { Session } from './session.ts'

export default function plugin(ctx: Ctx): void {
    const agent = ctx.get<Agent>('agent')
    const session = ctx.get<Session>('session')

    const render = (event: AgentEvent): void => {
        switch (event.type) {
            case 'text':
                process.stdout.write(event.text)
                break
            case 'usage':
                console.log(`\n  ⤷ 上下文 ${event.prompt} · 输出 ${event.completion}`)
                break
            case 'tool-start':
                console.log(`\n⚙ ${event.name} ${event.args}`)
                break
            case 'tool-end':
                console.log(`  → ${event.content.split('\n')[0]}`)
                break
        }
    }

    const approve = async (request: { tool: string; args: any }): Promise<boolean> => {
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        try {
            const answer = await rl.question(
                `\n  ⚠️  ${request.tool} ${JSON.stringify(request.args)}\n  允许吗？(y/N) `,
            )
            return answer.trim().toLowerCase() === 'y'
        } finally {
            rl.close()
        }
    }

    ctx.provide('main', {
        async run() {
            const rl = createInterface({ input: process.stdin, output: process.stdout })
            try {
                for (;;) {
                    const line = await rl.question('\nyou > ')
                    const text = line.trim()
                    if (text === 'exit') break
                    if (text === '') continue

                    session.append({ type: 'user', content: text })
                    try {
                        await agent.runTurn(render, approve)
                    } catch (err) {
                        console.log(`\n出错: ${err instanceof Error ? err.message : String(err)}`)
                    }
                }
            } finally {
                rl.close()
            }
        },
    })
}
