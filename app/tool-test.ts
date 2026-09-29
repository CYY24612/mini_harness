import { readFile } from 'node:fs/promises'
export const tool_test = (name: string): string => `hi ${name}`

async function readFileTool(path: string): Promise<string> {
    return await readFile(path, 'utf8')
}

console.log(await readFileTool('package.json'))