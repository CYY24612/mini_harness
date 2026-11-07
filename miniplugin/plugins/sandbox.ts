// 提供 `sandbox` 服务：路径围栏 + 敏感文件黑名单。无 inject。
//
// 对比 DSH：它把同一件事拆成了 dsh-sandbox / -local / -policy / -windows-acl 四个包，
// 其中 -local 是**操作系统级**围栏（Windows ACL restricted token）。
// 这里只是字符串校验 —— 能挡住路径参数，挡不住命令内部的行为。

import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Ctx } from '../container.ts'

const BLOCKED_NAMES = new Set(['id_rsa', 'id_ed25519', '.npmrc', '.netrc'])
const BLOCKED_EXTS = new Set(['.pem', '.key', '.p12', '.pfx'])

export interface Sandbox {
    /** 把相对路径解析成绝对路径，并保证它在工作目录内 */
    resolveInCwd(path: string): string
    /** 拒绝敏感文件 */
    assertAllowed(absPath: string): void
}

export default function plugin(ctx: Ctx): void {
    const root = process.cwd()

    const sandbox: Sandbox = {
        resolveInCwd(path) {
            const absPath = isAbsolute(path) ? resolve(path) : resolve(root, path)
            const rel = relative(root, absPath)
            if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
                throw new Error(`路径越界：${path} 不在工作目录（${root}）内`)
            }
            return absPath
        },

        assertAllowed(absPath) {
            const base = absPath.slice(absPath.lastIndexOf(sep) + 1)
            if (base.startsWith('.env')) throw new Error(`禁止访问敏感文件：${base}`)
            if (BLOCKED_NAMES.has(base)) throw new Error(`禁止访问敏感文件：${base}`)
            const dot = base.lastIndexOf('.')
            if (dot >= 0 && BLOCKED_EXTS.has(base.slice(dot))) {
                throw new Error(`禁止访问敏感文件：${base}`)
            }
        },
    }

    ctx.provide('sandbox', sandbox)
}
