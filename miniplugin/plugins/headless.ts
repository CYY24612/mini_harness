// 提供 `main` 服务：一次性执行 —— 这是**第二个产品**。
// inject: ['agent', 'session', 'cmdline']
//
// 注意：它和 repl 提供**同一个服务名** `main`。
// 所以装配文件里两个不能同时启用 —— 那会触发容器的"服务重复注册"保护。

import type { Ctx } from '../container.ts'
import type { Agent, AgentEvent } from './agent.ts'
import type { Session } from './session.ts'

export default function plugin(ctx: Ctx): void {
    const agent = ctx.get<Agent>('agent')
    const session = ctx.get<Session>('session')
    const cmdline = ctx.get<{ prompt: string }>('cmdline')

    // ★ 校验放在 run() 里，不放在装配期。
    //   放在装配期会让 `--dry` 失效（没有 prompt 就无法装配），
    //   而"先装配看看"是合法需求。
    //   这也是 DSH 的分工：插件装配时只注册服务，真正的工作在命令被调用时才发生。

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

    // ⚠️ 演示用：headless 自动批准一切。
    //    现实里这样做是灾难 —— 这正是 DSH 要有"权限预设 + 进程级沙箱"的原因：
    //    无人值守时，审批不能是唯一防线。
    const autoApprove = async (): Promise<boolean> => true

    ctx.provide('main', {
        async run() {
            if (!cmdline.prompt) {
                throw new Error('headless 需要一个 prompt：node main.ts headless "你的问题"')
            }
            session.append({ type: 'user', content: cmdline.prompt })
            await agent.runTurn(render, autoApprove)
            console.log()
        },
    })
}
