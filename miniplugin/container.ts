/**
 * 最小插件容器 —— Cordis 的 45 行骨架。
 *
 * 只有三件事：
 *   1. 服务注册表（插件之间只通过 ctx 通信，不互相 import）
 *   2. inject 声明依赖 + "谁能启动就启动"的重复扫描
 *   3. fail-loud（装不起来就报清楚，不要半残启动）
 *
 * 对应 DSH 的：
 *   - @deepseek-ai/cordis            本体
 *   - dsh-base/cordis.patch.yml      装配文件
 *   - dsh-app-boot 的 "fail-loud Loader guards"
 */

export interface Ctx {
    has(name: string): boolean
    get<T = unknown>(name: string): T
    provide(name: string, value: unknown): void
    names(): string[]
}

/** 装配文件里的一行。对应 cordis.patch.yml 的一个列表项。 */
export interface Row {
    id: string
    name: string
    config?: Record<string, unknown>
    disabled?: boolean
    /** 我依赖哪些服务。容器据此决定启动顺序。 */
    inject?: string[]
}

export type Plugin = (ctx: Ctx, config: any) => void | Promise<void>

export interface ComposeOptions {
    /** 由 launcher 预先注册的服务（对应 DSH 的 dsh-cmdline） */
    seed?: Record<string, unknown>
    log?: (line: string) => void
}

export async function compose(
    rows: Row[],
    load: (name: string) => Promise<Plugin>,
    options: ComposeOptions = {},
): Promise<Ctx> {
    const services = new Map<string, unknown>(Object.entries(options.seed ?? {}))
    const log = options.log ?? (() => {})

    const ctx: Ctx = {
        has: (name) => services.has(name),
        get<T>(name: string): T {
            if (!services.has(name)) throw new Error(`服务不存在: ${name}（检查装配文件里的 inject）`)
            return services.get(name) as T
        },
        provide(name, value) {
            if (services.has(name)) throw new Error(`服务重复注册: ${name}`)
            services.set(name, value)
        },
        names: () => [...services.keys()],
    }

    const pending = rows.filter((row) => !row.disabled)

    // ★ 核心：反复扫描，谁能启动就启动。
    //   顺序由"依赖是否就绪"决定，不由装配文件里的行序决定。
    //   （DSH 原文：'Row order carries no load semantics
    //     (activation is service-availability driven)'）
    let progressed = true
    while (pending.length > 0 && progressed) {
        progressed = false

        for (let i = 0; i < pending.length; i += 1) {
            const row = pending[i]
            const need = row.inject ?? []
            if (!need.every((name) => services.has(name))) continue

            const plugin = await load(row.name)
            await plugin(ctx, row.config ?? {})

            pending.splice(i, 1)
            i -= 1
            progressed = true
            log(`  ✓ ${row.id}${need.length > 0 ? `   ← ${need.join(', ')}` : ''}`)
        }
    }

    // ★ fail-loud：装不起来就报清楚谁缺什么。
    if (pending.length > 0) {
        const detail = pending.map((row) => {
            const missing = (row.inject ?? []).filter((name) => !services.has(name))
            return `  ${row.id} 缺少: ${missing.length > 0 ? missing.join(', ') : '(无缺失，疑似循环依赖)'}`
        })
        throw new Error(`装配失败，${pending.length} 个插件无法启动：\n${detail.join('\n')}`)
    }

    return ctx
}
