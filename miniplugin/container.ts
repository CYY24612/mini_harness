export interface Ctx {
    provide(name: string, value: unknown): void
    get<T = unknown>(name: string): T
    has(name: string): boolean
}

export type Plugin = (ctx: Ctx) => void

export function compose(plugins: Plugin[]): Ctx {
    const services = new Map<string, unknown>()

    const ctx : Ctx = {
        provide(name, value) {
            if (services.has(name)) throw new Error(`${name}插件已经存在`)
            services.set(name, value)
        },
        get<T>(name: string): T {
            if (!services.has(name)) throw new Error(`未找到${name}插件`)
            return services.get(name) as T
        },
        has(name) {
            return services.has(name)
        }
    }

    for (let i = 0; i < plugins.length; i++)
    {
        plugins[i](ctx)
    }

    return ctx
}