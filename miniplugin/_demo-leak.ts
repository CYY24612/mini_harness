import { readFile } from 'node:fs/promises'
import { compose, type Plugin, type Row } from './container.ts'

// launcher ??????????
try { process.loadEnvFile('.env') } catch {}
try { process.loadEnvFile('../app/.env') } catch {}

async function attempt(profile: string): Promise<void> {
    console.log(`--- profile: ${profile} ---`)
    const rows = JSON.parse(
        await readFile(new URL(`./profiles/${profile}.json`, import.meta.url), 'utf8'),
    ) as Row[]

    const load = async (name: string): Promise<Plugin> =>
        (await import(new URL(`./plugins/${name}.ts`, import.meta.url).href)).default

    let started = 0
    try {
        await compose(rows, load, {
            log: (line) => { started += 1; console.log(line) },
        })
        console.log('  assembled OK')
    } catch (err) {
        const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
        console.log(`  assembly FAILED after ${started} plugin(s) started: ${msg}`)
        console.log(`  >>> those ${started} plugin(s) were never torn down`)
    }

    const live = process.getActiveResourcesInfo().filter((r) => r !== 'TTYWrap')
    console.log(`  live resources: [${live.join(', ')}]`)
    console.log('')
}

await attempt('_clash')
await attempt('_clash-leaky')
process.exit(0)
