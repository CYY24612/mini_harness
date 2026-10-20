import type { ToolDefinition } from './types.ts'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { resolve, relative, isAbsolute, sep, basename, extname, dirname } from 'node:path'

export type Approver = (request: { tool: string; args: any }) => Promise<boolean>

export type Tool = {
    definition: ToolDefinition                      // 给模型看的
    pathArg: string | null
    requiresApproval: boolean
    run: (args: any) => Promise<string>             // 本地执行的
}

export const tools: Tool[] = [
    {
        definition: {
            type: "function",
            function: {
                name: "read_file",
                description: "读取文件内容",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "文件路径"}
                    },
                    required: ["path"]
                }
            }
        },
        pathArg: 'path',
        requiresApproval: false,
        run: async (args) => {
            return await withRetry(() => readFile(args.path, 'utf8')) 
        }      
    },
    {
        definition: {
            type: "function",
            function: {
                name: "list_dir",
                description: "列出目录里内容",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "目录路径"}
                    },
                    required: ["path"]
                }
            }
        },
        pathArg: 'path',
        requiresApproval: false,
        run: async (args) => {
            const entries: Dirent[] = await readdir(args.path, { withFileTypes: true });
            const onlyFiles = entries.filter(entry => entry.isFile()).map(entry => entry.name);
            const onlyDirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
            return formatDirContent(onlyFiles, onlyDirs)
        }
    },
    {
        definition: {
            type: "function",
            function: {
                name: "write_file",
                description: "把内容整体覆盖进文件，修改前最好read_file一下",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "文件路径"},
                        content: { type: "string", description: "要写入的文件内容"}
                    },
                    required: ["path", "content"]
                }
            }
        },
        pathArg: 'path',
        requiresApproval: true,
        run: async (args) => {
            await mkdir(dirname(args.path), { recursive: true} )
            await withRetry(() => writeFile(args.path, args.content, 'utf-8'))
            return `已写入 ${args.path}（${args.content.split('\n').length} 行，${args.content.length} 字符）`
        }
    },
    {
        definition: {
            type: "function",
            function: {
                name: "str_replace",
                description: "在文件里做精确的局部替换：把 old_string 换成 new_string。old_string 必须和文件内容完全一致（包括空格、缩进、换行），并且必须在文件中只出现一次 —— 出现多次会失败，这时需要带上更多上下文让它唯一。修改已有文件前应该先 read_file 确认原文。",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "要修改的文件路径" },
                        old_string: { type: "string", description: "要被替换的原文，必须和文件里的完全一致（含空格、缩进），且在全文中唯一出现" },
                        new_string: { type: "string", description: "替换后的新文本" },
                    },
                    required: ["path", "old_string", "new_string"]
                }
                
            }
        },
        pathArg: 'path',
        requiresApproval: true,
        run: async (args) => {
            if (typeof args.old_string !== 'string' || args.old_string === '') {
                throw new Error('old_string 不能为空，否则无法定位要改哪里。')
            }
            if (typeof args.new_string !== 'string') {
                throw new Error('new_string 必须是字符串（要删除文本时传空字符串 ""）。')
            }

            const content = await withRetry(() => readFile(args.path, 'utf8'))

            const eol = content.includes('\r\n') ? '\r\n' : '\n'

            const toEol = (s: string) => s.replace(/\r?\n/g, eol)
            const oldText = toEol(args.old_string)
            const newText = toEol(args.new_string)

            const count = content.split(oldText).length - 1

            if (count === 0) {
                throw new Error(
                    `在 ${args.path} 里找不到这段文本。` +
                    `常见原因：缩进或空格不一致、或者文件已经被改过。` +
                    `请重新 read_file 确认当前内容后再试。`
                )
            }

            if (count > 1) {
                throw new Error(
                    `这段文本在 ${args.path} 里出现了 ${count} 次，无法确定要改哪一处。` +
                    `请把 old_string 写得更长一些（带上前后几行），确保它只出现一次。`
                )
            }

            const updated = content.replace(oldText, () => newText)
            await withRetry(() => writeFile(args.path, updated, 'utf8'))

            return `已修改 ${args.path}：替换 1 处。` +
                   `文件从 ${content.split('\n').length} 行变成 ${updated.split('\n').length} 行。`
        }
    }
]

export async function runTool(
    name: string, 
    args: any,
    approve: Approver,
): Promise<string> {
    const tool = findTool(name)
    if (!tool) {
        throw new Error(
            `没有名为 "${name}" 的工具。可用工具` + 
            tools.map(t => t.definition.function.name).join('、') + '。'
        )
    }

    if (tool.pathArg) {
        const abs = resolveInCwd(args[tool.pathArg])
        assertNotSecret(abs)
        args[tool.pathArg] = abs
    }

    if (tool.requiresApproval) {
        const ok = await approve({ tool: name, args })
        if (!ok) {
            return `用户拒绝了这个操作。不要重试，改为向用户说明你想做什么、为什么需要它。`
        }
    }

    return await tool.run(args)
}

function findTool(name: string): Tool | undefined {
    return tools.find(t => t.definition.function.name === name)
}

export function formatDirContent(onlyFiles: string[], onlyDirs: string[]): string {
  const fileText = onlyFiles.length > 0
    ? onlyFiles.map(name => `- ${name}`).join('\n')
    : '（无文件）';

  const dirText = onlyDirs.length > 0
    ? onlyDirs.map(name => `- ${name}`).join('\n')
    : '（无目录）';

  return `文件：\n${fileText}\n\n目录：\n${dirText}`;
}

export function resolveInCwd(input: string): string {
    const root = process.cwd()
    const abs = resolve(root, input)
    const rel = relative(root, abs)

    const outside = 
        rel === '..' ||
        rel.startsWith('..' + sep) ||
        isAbsolute(rel)

    if (outside) {
        throw new Error(
            `路径越界 —— "${input}" 不在工作目录内。` +
            `当前工作目录是 ${root}，只能访问这个目录下的内容。`
        )
    }
    return abs
}

// ============ 黑名单定义 ============

// 1. 前缀匹配：文件名以这些字符串开头就禁止
//    例：.env、.env.local、.env.production 都被 .env 前缀命中
const BLOCKED_PREFIXES: string[] = [
    '.env',          // .env / .env.local / .env.prod
    '.aws',          // .aws/credentials 等
    '.ssh',          // .ssh 目录下的文件
    'id_rsa',        // id_rsa / id_rsa.pub
    'id_ed25519',    // id_ed25519 / id_ed25519.pub
    'id_ecdsa',
    'id_dsa',
    '.npmrc',
    '.pypirc',
    '.netrc',
    '.git-credentials',
]

// 2. 固定名匹配：文件名必须完全等于其中之一
const BLOCKED_NAMES: string[] = [
    '.env',              // 这个其实也会被前缀命中，但写在这里更明确
    'credentials',
    'credentials.json',
    'secrets.json',
    'secrets.yaml',
    'secrets.yml',
    'master.key',
    'config.json',       // 按需启用
]

// 3. 后缀匹配：文件扩展名（带点，小写）命中就禁止
const BLOCKED_EXTS: string[] = [
    '.pem',
    '.key',
    '.p12',
    '.pfx',
    '.jks',
    '.keystore',
    '.crt',              // 按需启用
    '.cer',
]

// ============ 检查函数 ============

export function assertNotSecret(abs: string): void {
    const name = basename(abs).toLowerCase()
    const ext  = extname(name).toLowerCase()

    // 1. 前缀匹配
    for (const prefix of BLOCKED_PREFIXES) {
        if (name.startsWith(prefix.toLowerCase())) {
            throw new Error(
                `禁止访问敏感文件 —— "${name}" 匹配前缀 "${prefix}"。`
            )
        }
    }

    // 2. 固定名匹配
    for (const blocked of BLOCKED_NAMES) {
        if (name === blocked.toLowerCase()) {
            throw new Error(
                `禁止访问敏感文件 —— "${name}" 在固定名黑名单中。`
            )
        }
    }

    // 3. 后缀匹配
    for (const blockedExt of BLOCKED_EXTS) {
        if (ext === blockedExt.toLowerCase()) {
            throw new Error(
                `禁止访问敏感文件 —— 后缀 "${ext}" 属于敏感类型。`
            )
        }
    }
}

async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
    for (let i = 0; i < tries; i++) {
        try {
            return await fn()
        } catch (err) {
            const code = (err as { code?: string }).code
            const retriable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
            if (!retriable || i === tries -1) throw err

            await new Promise(r => setTimeout(r, 100 * (i + 1)))
        }
    }
    throw new Error('withRetry: unreachable')
}