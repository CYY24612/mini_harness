# 一个手写的极简 Coding Agent

> 约 890 行 TypeScript，从零实现的最小 coding agent。
> **零运行时依赖，无构建步骤** —— Node 24 原生执行 `.ts`。

这个项目的目标不是"又一个调 SDK 的 demo"，而是把 agent 的每一层拆开、自己写一遍：
上下文怎么组织、工具怎么派发、流式怎么解析、沙箱怎么划边界、危险操作怎么审批。

---

## 它长什么样

```
你 > 在 hello.ts 里把 add 改成 subtract

⚙ read_file {"path": "hello.ts"}
  → import { greet } from './greet.ts'
💭 思考中…
⚙ str_replace {"path": "hello.ts", "old_string": "return a + b;", "new_string": "return a - b;"}

  ⚠️  即将执行 str_replace {"path":"D:\\...\\app\\hello.ts","old_string":"return a + b;","new_string":"return a - b;"}
  允许吗？(y/N) y
  → 已修改 hello.ts：替换 1 处。文件从 8 行变成 8 行。

已改完。现在 `subtract(1, 2)` 会输出 `-1`。
```

那一轮里发生的事：模型自己决定读哪个文件、用什么锚点、改什么内容；
你只需要在真正写盘前点一下 `y`。

---

## 能力

**五个工具**

| 工具 | 审批 | 说明 |
|---|:---:|---|
| `read_file` | — | 读文件 |
| `list_dir` | — | 列目录（文件/目录分组） |
| `write_file` | ✅ | 整体覆盖写入 |
| `str_replace` | ✅ | 精确局部替换，**要求匹配唯一** |
| `run_shell` | ✅ | 跑命令（`tsc` / 测试 / 构建），返回退出码 + stdout + stderr |

**harness 层**

- **流式输出**：文本逐字显示；`tool_calls` 按 `index` 归并（参数是分片来的）
- **思考提示**：模型真正推理时才显示 `💭`（不是每轮无脑闪一下）
- **沙箱**：所有路径 `resolve` 后校验必须在工作目录内
- **敏感文件黑名单**：`.env` / `*.pem` / `*.key` / `id_rsa` 等，前缀 + 固定名 + 后缀三档匹配
- **审批**：写操作前暂停，显示**解析后的真实绝对路径**（不是模型声称的路径）
- **会话持久化**：append-only 事件日志落 JSONL，`--resume` 恢复
- **token 计量**：每轮显示 `⤷ 上下文 N tokens · 输出 M（其中思考 K）`
- **命令执行**：超时可配、输出首尾保留中段截断、子进程环境变量剔除密钥
- **重试**：文件被占用（`EBUSY`/`EPERM`）时线性退避重试
- **步数上限**：防死循环烧钱

---

## 架构

```
app/
├─ main.ts       128 行   REPL · 装配 · 渲染 · --resume
├─ agent.ts       56 行   while 循环 · 工具编排 · 步数上限
├─ provider.ts   155 行   HTTP · SSE 解析 · tool_calls 累积 · usage
├─ tools.ts      415 行   5 个工具 · 沙箱 · 审批 · 派发
├─ session.ts     95 行   事件日志 · 投影 · JSONL 落盘
└─ types.ts       39 行   纯类型

                888 行   合计
```

**依赖方向单一向下，无环：**

```
main.ts ──→ agent.ts ──→ provider.ts
   │            ├──────→ tools.ts
   │            └──────→ session.ts
   └───────────────────→ (装配以上全部)

types.ts  ← 被所有层引用，不依赖任何东西
```

判断分层是否做对了，有个简单的检验：**`main.ts` 里出现 `fetch`、`readFile`、`JSON.parse` 吗？**
应该一个都没有 —— 它只负责接线。

---

## 快速开始

```powershell
cd app
npm install                 # 只为类型提示，运行时不需要

# 配置
Copy-Item .env.example .env      # 或手动创建，见下
```

`.env`（任选一家 OpenAI 兼容厂商，改 `OPENAI_BASE_URL` 即可切换）：

```
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.deepseek.com/v1
AGENT_MODEL=deepseek-chat
```

```powershell
node main.ts              # 新会话
node main.ts --resume     # 恢复上次会话
npm run typecheck         # 类型检查（tsc --noEmit）

# 退出
你 > break
```

> **不需要 tsx、不需要编译。** Node 22.6+ 原生支持 TypeScript 类型擦除。

---

## 六个值得说的设计决定

### 1. 日志是唯一真相，请求是投影

上下文**不是**一个 `messages` 数组，而是 append-only 的事件日志 + 一个纯函数投影：

```ts
session.append({ type: 'user', content: '帮我读 package.json' })
session.messages()   // → 现算出该发给模型的 ChatMessage[]
```

好处：会话可恢复、可回放、可调试；压缩旧历史只需要在投影时跳过事件，**不用改历史本身**。
坏处：每次请求都要重算一遍（对这个规模完全无所谓）。

### 2. 流式只改「怎么拿到 message」，不改「message 长什么样」

`chatStream()` 返回的类型和同步调用完全一样。所以把非流式切到流式，**`agent.ts` 只改了一行**，下游的工具派发、审批、事件推送全都不用动。

### 3. 沙箱是「通道」，不是「每个工具的义务」

早期每个工具的 `run` 里都要自己写 `resolveInCwd()` + `assertNotSecret()`。现在工具只声明：

```ts
pathArg: string | null        // 必填，强迫你显式决定碰不碰文件
requiresApproval: boolean     // 同上
```

守卫统一在 `runTool()` 这个唯一入口执行。**忘记检查在类型层面就写不出来** —— 不是靠"记得"。

### 4. 危险操作前会停一下，而且显示的是**真实目标**

审批提示里的路径是 `resolveInCwd()` **之后**的绝对路径。模型可以说 `path: "a.txt"`，
但它改不了 `resolve` 的结果 —— 想写 `C:\Windows\...` 的话，你在提示里会看到那个完整路径。

### 5. 用类型守住不变式

调用模型的那段代码长这样：

```ts
let content: string
try {
    const args = JSON.parse(call.function.arguments)    // 也放在 try 里
    content = await runTool(call.function.name, args, approve)
} catch (err) {
    content = `Error: ${...}`
}

session.append({ type: 'tool', tool_call_id: call.id, content })   // 无条件 append
```

`content` 是 `string`（不是 `string | undefined`），所以**每条路径都必须赋值**。
一旦漏了，编译不过。于是"每个 tool_call 都有配对结果"这条协议要求就**不可能被忘记**——
而它是 OpenAI / Anthropic 都会在下一轮用 400 拒绝你的硬约束。

> `JSON.parse` 曾经在 `try` **外面** —— 模型吐出半截 JSON 时会抛到最外层，
> 触发整轮回滚，连已经成功的工具结果一起丢掉。挪进 `try` 之后它只是一条错误消息。

### 6. 有一个工具无法沙箱化 —— 所以它的安全模型是"人"

`read_file` / `write_file` / `str_replace` 都受 `resolveInCwd` + `assertNotSecret` 保护，
那是**代码层面的真防护**。

`run_shell` 没有。任意命令的行为无法静态判定 ——
`cd .. && del /s /q *`、`type ..\..\.env`、`curl xxx | sh`，没有一条规则能覆盖。

所以这个工具的唯一防线是 **`requiresApproval` + 让人看懂命令**：

- `pathArg: null` —— 没有路径可以给沙箱校验
- 审批提示用 `JSON.stringify(args)` 原样展示 —— JSON 转义精确到字节，不会被同形字或空白骗过去
- 子进程的环境变量剔除 `KEY` / `TOKEN` / `SECRET` / `PASSWORD` —— 防止 `echo %OPENAI_API_KEY%` 绕过文件黑名单
- 超时和输出截断只是**止损**，不是防护

**这是整个项目里唯一一处「安全性不由代码保证」的地方。**
诚实地写出来，比假装它和别的工具一样安全要好。

---

## 已知限制

- 只实现 OpenAI 兼容协议（`/chat/completions`），没有 Anthropic Messages / Responses API
- `str_replace` 没有 diff 预览（审批时看到的是原始参数）
- 上下文不压缩：工具读进来的大文件会一直留在历史里
- 单会话（固定 `default`），没有多会话管理
- **`run_shell` 在 Windows 上对 GBK 输出做了针对性解码**（`TextDecoder('gbk')` 兜底）。
  这是中文 Windows 的补丁，不是通用方案 —— Node 没有读 OEM 代码页的接口，换 locale 可能需要调整
- `run_shell` 的 `timeout` 在 Windows 上只杀 `cmd.exe`，不保证杀掉它的子进程
- 没有 `edit` 之外的结构化编辑（重命名、批量替换等）

---

## 这个项目教给我的四件事

写的过程中踩的坑，比功能本身更有价值：

**① 边界无处不在**

同一个主题出现了五次：SSE 事件被 TCP 切断、UTF-8 汉字被切在字节中间、
`tool_calls` 参数被切成碎片、CRLF vs LF、以及文件句柄被安全软件抢走。

**结论：永远不要把「格式」和「时序」当成理所当然。**

**② 「写好了」和「接上了」是两件事**

这个项目里出现过五次"代码写了但没有一条真实路径会执行它"：
安全检查函数忘了调用、守卫入口没接上、回调参数没用、整个流式函数成了死代码。

其中最危险的一次：`assertNotSecret()` 写好了、正确、review 能过，但**从来没被调用** ——
于是 `.env` 被读了出来，API key 出现在终端回滚缓冲里。

**结论：未被执行的代码不可信。每加一个函数，必须有一条能走到它的真实调用。**

**③ 类型能表达的，就让编译器去守**

字段名写错（`role: 'usr'`、`prameters`、`funtion`）编译器不管 —— 直到你给它一个类型。
`ToolDefinition` 一加上，两个拼写错误立刻变成编译错误。

**但也有类型表达不了的东西**：`required` 里的字段是否真在 `properties` 里声明，
这种约束只能靠运行时自检或测试。

**④ 类型对了 ≠ 语义对了**

```ts
.sort((a, b) => a[0] = b[0])    // 赋值，不是减法
```

两个都是 `number`，tsc 一声不吭，而前者既排不了序、还会就地污染数据。

**结论：编译通过只是第一关。运行验证、grep 检查、看日志 —— 每一层都在抓不同类型的问题。**

---

## License

MIT
