# 内核规格 · 同一件事，五种语言

这不是"复现整个 agent"，而是复现**内核**：发一次流式请求，把文本逐字打出来。

**为什么只做内核**：如果复现全部 1067 行，C 版本里 80% 的代码会是 HTTP 客户端、JSON 解析、
字符串缓冲和内存管理 —— 你会学到"怎么在 C 里手搓 HTTP 客户端"，而不是"语言差异"。

内核这 70~230 行就足以暴露全部关键差异。

---

## 必须实现的五步

| # | 步骤 | 要点 |
|---|---|---|
| 1 | 读 `.env` | 解析 `KEY=VALUE`，跳过空行和 `#` 注释，**不覆盖已存在的环境变量** |
| 2 | 发请求 | `POST {baseUrl}/chat/completions`，`content-type: application/json`，`authorization: Bearer <key>` |
| 3 | 请求体 | `{ model, messages: [{role:system}, {role:user}], stream: true }` |
| 4 | 解析 SSE | 逐行读；只处理 `data:` 开头的行；`[DONE]` 结束；其余按 JSON 解析 |
| 5 | 输出 | 有 `delta.content` 就立刻打印并 flush；有 `usage` 就打印 token 数 |

## 请求体（固定）

```json
{
  "model": "<AGENT_MODEL>",
  "stream": true,
  "messages": [
    { "role": "system", "content": "回答简洁。" },
    { "role": "user",   "content": "<命令行参数拼成的 prompt>" }
  ]
}
```

**不带 `tools`** —— 工具调用属于下一层，内核先不碰。

## SSE 帧格式（真实样例）

```
data: {"choices":[{"delta":{"role":"assistant","content":""}}]}

data: {"choices":[{"delta":{"reasoning_content":"用户在问..."}}]}

data: {"choices":[{"delta":{"content":"事件"}}]}

data: {"choices":[{"delta":{"content":"循环"}}]}

data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":32,"completion_tokens":68}}

data: [DONE]
```

**四个必须处理的细节：**

1. **`usage` 在顶层**，不在 `choices` 里；而且最后那块 `choices` 可能为空
2. **`reasoning_content` 要忽略**（推理模型会先吐几十块这个，`content` 一直是 `null`）
3. **`content` 可能是 `null` 或空串**，不是只有非空字符串
4. **`data:` 后面可能没有空格**，所以取 `line[5:]` 之后要 trim

## 成功标准

```
你 > 用一句话解释什么是事件循环

事件循环是……（文字逐字流出，不是等完再一次性出现）

[usage] prompt=32 completion=68
```

**"逐字流出"是核心验收点。** 如果最终一次性打印，说明你没真正流式读取
（很可能是一次性读完整个 body 再解析 —— 那就退化成了非流式）。

---

## 每个版本必须遵守的约束

| 约束 | 目的 |
|---|---|
| **不做工具调用** | 保持五个版本可比 |
| **不做重试 / 不做错误分类** | 那是 harness 层的事，不是语言差异 |
| **允许用第三方库** | 但要记录"用了什么、为什么必须用" |
| **不许为了省事砍掉流式** | 流式读是整个对比的关键 |

---

## 记录表（每个版本填一次）

| 项 | 说明 |
|---|---|
| 依赖 | 标准库 / 第三方（列出名字和行数） |
| 代码行数 | `wc -l` 或等价 |
| 异步模型 | 同步阻塞 / async-await / 回调 |
| JSON 使用方式 | 静态类型 / 动态字典 / 手动解析 |
| 字段名写错的表现 | 编译错误 / 运行时 null / 段错误 |
| buffer 管理 | 谁负责（库 / 语言 / 你） |
| 最别扭的一处 | 一句话 |

这七行填完之后，五门语言的差别会比任何文章都清楚。
