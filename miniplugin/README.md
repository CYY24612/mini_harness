# miniplugin —— 45 行的插件容器

一个**可跑的**最小 plugin framework，用来说明 DSH 的「一切皆插件」到底指什么。

**不复制 `app/`，不改 `app/`。** 这个目录是一次独立的实验。

---

## 一句话

> **`app/` 是一个程序 + 6 个模块。**
> **`miniplugin/` 是一个空壳 + 一份装配文件 + 7 个插件。**

`main.ts` 里**没有任何 agent 逻辑**，它只做三件事：读 profile → 装配 → 调用 `main` 服务。
这和 DSH 的 `dsh` CLI 的分工完全一致（官方描述：*"profile launch, plugin management, and configuration inspection"*）。

---

## 怎么跑

```powershell
cd D:\CYY\myProject\agent-harness-lab\miniplugin

# 只看装配，不调 API（不需要 key）
node main.ts repl --dry

# 交互式（读完 app/.env 里的 key）
node main.ts repl

# 一次性：同一个 agent，不同产品
node main.ts headless "帮我读一下 package.json，说说这个项目是干什么的"

# 类型检查
node ..\app\node_modules\typescript\bin\tsc -p .
```

`.env` 自动从 `../app/.env` 读，不需要复制。

---

## 装配结果长什么样

`profiles/repl.json` 是**故意倒序写的**（`tools` 在最前，`session` 在最后）：

```json
[
    { "id": "tools",   "name": "tools",   "inject": ["sandbox"] },
    { "id": "agent",   "name": "agent",   "inject": ["llm", "session", "tools"] },
    { "id": "repl",    "name": "repl",    "inject": ["agent", "session"] },
    { "id": "llm",     "name": "llm",     "config": { ... } },
    { "id": "sandbox", "name": "sandbox" },
    { "id": "session", "name": "session" }
]
```

跑出来是这样：

```
profile: repl   (dry run)
装配过程：
  ✓ llm
  ✓ sandbox
  ✓ session
  ✓ tools   ← sandbox
  ✓ agent   ← llm, session, tools
  ✓ repl    ← agent, session

已注册服务: cmdline, llm, sandbox, session, tools, agent, main
```

**行序完全乱了，装配顺序却完全正确。**

这就是 DSH `dsh-base/cordis.patch.yml` 开头那句注释的意思：

> *"**Row order carries no load semantics** (activation is **service-availability driven**); the grouping is for readers."*

---

## 核心机制（`container.ts`，约 70 行）

### ① 服务注册表

```ts
const ctx: Ctx = {
    has, get, provide, names
}
```

**插件之间不互相 import。** `plugins/tools.ts` 里是：

```ts
const sandbox = ctx.get<Sandbox>('sandbox')      // ← 通过服务名
```

而不是：

```ts
import { sandbox } from './sandbox.ts'            // ← 直接依赖（反面写法）
```

**这是整个设计的支点**：只要服务名和形状对得上，`sandbox` 的具体实现可以整个换掉，`tools` 不需要改一行。

### ② inject + 重复扫描

```ts
let progressed = true
while (pending.length > 0 && progressed) {
    progressed = false
    for (每一行还没装配的) {
        if (它需要(x)的服务都还没有) continue
        await plugin(ctx, config)
        progressed = true
    }
}
```

**这就是"activation is service-availability driven"的实现。** 一共 12 行。

### ③ fail-loud

```ts
if (pending.length > 0) {
    throw new Error(`装配失败，${pending.length} 个插件无法启动：\n${detail}`)
}
```

把 `agent` 的 `inject` 里去掉 `tools` 之后，它报的是：

```
Error: 装配失败，1 个插件无法启动：
  agent 缺少: tools
```

**说清了"谁、缺什么"，而不是留一个半残的进程让你去猜 `undefined is not a function`。**

对应 DSH 的 `dsh-app-boot`：*"fail-loud Loader guards"*。

---

## 和 DSH 的对应表

| miniplugin | DSH | 说明 |
|---|---|---|
| `container.ts` | `@deepseek-ai/cordis` | 本体（Cordis 是一个独立框架，有 loader / HMR / 配置，比这 70 行复杂得多） |
| `profiles/*.json` | `dsh-base/cordis.patch.yml` 等 | 装配文件。DSH 用 YAML + `insert` / `disabled` / `config` 覆盖 |
| `main.ts` | `dsh` CLI + `dsh-app-boot` | launcher：读配置、装配、启动 |
| `plugins/llm.ts` | `dsh-llm` + `dsh-llm-deepseek` | 提供 `llm` |
| `plugins/session.ts` | `dsh-session` + `dsh-session-projection` | 提供 `session` |
| `plugins/sandbox.ts` | `dsh-sandbox` + `-local` + `-policy` + `-windows-acl` | 提供 `sandbox`（这里只是字符串校验，DSH 是 OS 级围栏） |
| `plugins/tools.ts` | `dsh-tools` + 每个 `dsh-tool-*` | 提供 `tools`，inject `sandbox` |
| `plugins/agent.ts` | `dsh-agent-loop` | 提供 `agent` |
| `plugins/repl.ts` | `dsh-web-app` / `dsh-headless` | 提供一个"产品" |
| `plugins/headless.ts` | `dsh-headless` | 提供第二个"产品" |
| `seed: { cmdline }` | `dsh-cmdline` | launcher 提供的服务，插件也能 inject |
| `tsconfig` + `package.json` | 每个包一份 | — |

**一个文件 = 一个 DSH 包** 的粗略对应。

---

## 为什么说"核心是空的"

**因为同一批插件能装配出两个不同的产品。**

- `profiles/repl.json` → 交互式 REPL
- `profiles/headless.json` → 一次性执行

**区别只有一行**：`repl` 那一横换成 `headless`。

```diff
- { "id": "repl",     "name": "repl",     "inject": ["agent", "session"] }
+ { "id": "headless", "name": "headless", "inject": ["agent", "session", "cmdline"] }
```

**如果装配不出第二个产品，说明核心还有硬逻辑 —— 那就不是"一切皆插件"。**

> DSH 有 5 种以上：`dsh base` / `web` / `headless` / `acp` / `sdk-minimal`。
> 它们都是 `dsh-base` 上面再贴一层 patch。

---

## 三个留给你的作业

我**故意没做**这三件事，因为你补的时候会真正理解 DSH 为什么需要那些包：

### ❶ 循环依赖检测

现在如果 A 等 B、B 等 A，容器只会报：

```
A 缺少: (无缺失，疑似循环依赖)
B 缺少: (无缺失，疑似循环依赖)
```

**它说不清"这是个环"。** 你要自己加：记录"谁在等谁"，然后用拓扑排序或 DFS 找环。

> DSH 的 `inject` 是完整的依赖图，能报出路经。

### ❷ 服务冲突策略

现在同名服务直接抛 `服务重复注册`。

**但 DSH 的规则是 `last write winning per row`（按行覆盖）。**
你要决定：报错？后者覆盖？还是按 `id` 做优先级？

> 这是一个**产品决策**，不是技术问题。

### ❸ 插件清理（dispose）

容器没有"关掉"的能力。如果你的插件开了 readline、打开了文件、连了数据库，**没有地方释放**。

你要加：

```ts
export type Plugin = (ctx, config) => void | (() => void | Promise<void>)
//                                     ↑ 返回一个清理函数
```

然后在关停时**逆序**调用它们。

> 这就是 Cordis 里 `fiber.dispose()` 的等价物 —— 也是它比这 70 行复杂 100 倍的主要原因。

---

## 已知限制（和 DSH 的差距）

| | miniplugin | DSH |
|---|---|---|
| 装配文件格式 | JSON，无覆盖语义 | YAML，支持 `insert` / `disabled` / `config` / `!!js` 表达式 / 多层 patch 覆盖 |
| 配置热重载 | ❌ | `dsh-hmr` |
| 服务生命周期 | ❌ 只有 provide | disposal、scope、依赖注入的作用域 |
| 微调顺序 | 反复扫描（O(n²)） | 依赖图拓扑排序 |
| 插件加载 | 动态 `import()` 本地文件 | npm 包 + profile 装配 + 市场安装 |
| 版本约束 | ❌ | **peerDependencies 精确锁版**（`0.2.1-rc.5`，不是 `^`） |
| 沙箱 | 字符串校验 | 进程级（Windows ACL / landlock / Seatbelt） |

**最后一行"版本约束"值得单独说**：DSH 每个包的 `peerDependencies` 都是**精确版本**，因为服务契约在 rc 阶段还在变。

**一个为 rc.2 写的插件装上 rc.5 的核心，会怎样？**

```
peer 冲突 → npm 装一份嵌套副本 → 进程里有两个 dsh-fs 模块
        → 插件往「自己那份」注册服务
        → 核心读的是「另一份」→ 服务是 undefined
        → fail-loud guard 拒绝启动
```

**这就是"装了一些插件，dsh 就起不来"的真正机制。**

---

## 一句话总结

> **"一切皆插件"不是"功能可扩展"。**
> **是"连核心也是插件" —— 判断标准就是：同一批包，能不能装配出第二个产品。**
