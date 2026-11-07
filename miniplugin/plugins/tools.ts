// 提供 `tools` 服务：一组工具 + 单一派发入口。
// inject: ['sandbox'] —— ★ 这个声明让容器保证 sandbox 先就绪。
//
// 注意：插件内部用 `ctx.get('sandbox')` 拿到服务，而不是 `import ... from './sandbox.ts'`。
// 这是"一切皆插件"的关键：插件之间**不直接依赖**，只依赖服务名。

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import type { Ctx } from '../container.ts'
import type { Sandbox } from './sandbox.ts'

export interface ToolDefinition {
    type: 'function'
    function: { name: string; description: string; parameters: any }
}

export interface Tool {
    definition: ToolDefinition
    /** 哪个参数是路径（null = 这个工具不碰文件） */
    pathArg: string | null
    requiresApproval: boolean
    run(args: any): Promise<string>
}

export type Approver = (request: { tool: string; args: any }) => Promise<boolean>

export interface Toolbox {
    definitions: ToolDefinition[]
    run(name: string, args: any, approve: Approver): Promise<string>
}

const IS_WIN = process.platform === 'win32'

export default function plugin(ctx: Ctx): void {
    const sandbox = ctx.get<Sandbox>('sandbox')

    const tools: Tool[] = [
        {
            definition: {
                type: 'function',
                function: {
                    name: 'read_file',
                    description: '读取工作目录内的文本文件。',
                    parameters: {
                        type: 'object',
                        properties: { path: { type: 'string', description: '文件路径' } },
                        required: ['path'],
                    },
                },
            },
            pathArg: 'path',
            requiresApproval: false,
            run: async (args) => await readFile(args.path, 'utf8'),
        },

        {
            definition: {
                type: 'function',
                function: {
                    name: 'write_file',
                    description: '整体覆盖写入文件。',
                    parameters: {
                        type: 'object',
                        properties: { path: { type: 'string' }, content: { type: 'string' } },
                        required: ['path', 'content'],
                    },
                },
            },
            pathArg: 'path',
            requiresApproval: true,
            run: async (args) => {
                await writeFile(args.path, String(args.content ?? ''), 'utf8')
                return `已写入 ${args.path}`
            },
        },

        {
            definition: {
                type: 'function',
                function: {
                    name: 'run_shell',
                    description: IS_WIN
                        ? '执行一条命令（cmd.exe 语法）。用于跑类型检查、测试。不要执行不会自行结束的命令。'
                        : '执行一条命令（/bin/sh 语法）。用于跑类型检查、测试。',
                    parameters: {
                        type: 'object',
                        properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } },
                        required: ['command'],
                    },
                },
            },
            pathArg: null,
            requiresApproval: true,
            run: async (args) => {
                const command = String(args.command ?? '').trim()
                if (!command) throw new Error('command 不能为空')
                const timeout = Math.min(Number(args.timeout_ms) || 60_000, 300_000)

                return await new Promise<string>((done, fail) => {
                    execFile(
                        IS_WIN ? 'cmd.exe' : '/bin/sh',
                        [IS_WIN ? '/c' : '-c', command],
                        {
                            cwd: process.cwd(),
                            timeout,
                            maxBuffer: 10 * 1024 * 1024,
                            windowsHide: true,
                            // ★ 少了这一行，含双引号的命令会静默失败（findstr / node -e 都会中招）
                            windowsVerbatimArguments: true,
                        },
                        (err, stdout, stderr) => {
                            const e = err as (Error & { code?: number | string }) | null
                            if (e && typeof e.code === 'string') {
                                fail(new Error(`无法执行命令：${e.message}`))
                                return
                            }
                            const exit = e ? String(e.code ?? 1) : '0'
                            const parts = [`退出码: ${exit}`]
                            const out = String(stdout ?? '').trim()
                            const errOut = String(stderr ?? '').trim()
                            if (out) parts.push(`--- stdout ---\n${out}`)
                            if (errOut) parts.push(`--- stderr ---\n${errOut}`)
                            done(parts.join('\n'))
                        },
                    )
                })
            },
        },
    ]

    /** 单一派发入口：路径解析 → 敏感检查 → 审批 → 执行 */
    const run = async (name: string, args: any, approve: Approver): Promise<string> => {
        const tool = tools.find((t) => t.definition.function.name === name)
        if (!tool) throw new Error(`没有名为 "${name}" 的工具`)

        if (tool.pathArg) {
            const raw = args[tool.pathArg]
            if (typeof raw !== 'string') throw new Error(`参数 ${tool.pathArg} 必须是字符串`)
            const absPath = sandbox.resolveInCwd(raw)
            sandbox.assertAllowed(absPath)
            args[tool.pathArg] = absPath
        }

        if (tool.requiresApproval) {
            const ok = await approve({ tool: name, args })
            if (!ok) throw new Error('用户拒绝了这个操作。不要重试，改为向用户说明意图、原因和替代方案。')
        }

        return await tool.run(args)
    }

    const toolbox: Toolbox = {
        definitions: tools.map((t) => t.definition),
        run,
    }

    ctx.provide('tools', toolbox)
}
