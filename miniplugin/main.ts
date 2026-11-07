// miniplugin 的 launcher —— 它自己不含任何 agent 逻辑，只做三件事：
//   1. 读 profile（装配文件）
//   2. 装配
//   3. 调用 main 服务
//
// 对应 DSH 的 `dsh` CLI：'profile launch, plugin management, and configuration inspection'

import { readFile } from 'node:fs/promises'
import { compose, type Plugin, type Row } from './container.ts'

// launcher 负责加载环境变量（插件不该关心 .env 在哪）
try {
    process.loadEnvFile('.env')
} catch {}
try {
    process.loadEnvFile('../app/.env')
} catch {}

const args = process.argv.slice(2)
const profileName = args[0] ?? 'repl'
const dryRun = args.includes('--dry')
const prompt = args.slice(1).filter((a) => a !== '--dry').join(' ')

const rows = JSON.parse(
    await readFile(new URL(`./profiles/${profileName}.json`, import.meta.url), 'utf8'),
) as Row[]

async function loadPlugin(name: string): Promise<Plugin> {
    const url = new URL(`./plugins/${name}.ts`, import.meta.url).href
    const mod = await import(url)
    return mod.default as Plugin
}

console.log(`\nprofile: ${profileName}${dryRun ? '   (dry run)' : ''}`)
console.log('装配过程：')

const ctx = await compose(rows, loadPlugin, {
    // launcher 提供的服务也能被插件 inject（对应 DSH 的 dsh-cmdline）
    seed: { cmdline: { profile: profileName, prompt } },
    log: (line) => console.log(line),
})

console.log(`\n已注册服务: ${ctx.names().join(', ')}`)

if (dryRun) {
    process.exit(0)
}

const main = ctx.get<{ run(): Promise<void> }>('main')
await main.run()
