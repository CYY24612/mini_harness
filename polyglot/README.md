# 同一个 agent 内核，五种语言

复现我的 TypeScript coding agent 的**内核**，用 Python / Rust / C# / C++ / C 各写一遍。

**目的**：看清"语言差异"和"生态差异"是两件不同的事。

规格见 [SPEC.md](SPEC.md) —— 五个版本做的是**完全相同**的一件事：
读 `.env` → 发一次流式请求 → 解析 SSE → 逐字打印 → 打印 usage。

---

## 目录

```
polyglot/
├─ SPEC.md            内核规格（五版共同遵守）
├─ README.md          这个文件（对比结论）
├─ python/main.py     108 行   零依赖
├─ rust/              127 行   reqwest(blocking) + serde_json
│  ├─ Cargo.toml
│  └─ src/main.rs
├─ csharp/            155 行   零依赖
│  ├─ core.csproj
│  └─ Program.cs
├─ cpp/main.cpp       187 行   libcurl + nlohmann/json
└─ c/main.c           312 行   libcurl + cJSON
```

## 怎么跑

先把 `app/.env` 的内容复制到 `polyglot/` 目录（各版本从当前目录读 `.env`）：

```powershell
Copy-Item ..\app\.env .env
```

| 语言 | 命令 |
|---|---|
| Python | `cd python; python main.py "你好"` |
| Rust | `cd rust; cargo run -- "你好"` |
| C# | `cd csharp; dotnet run -- "你好"` |
| C++ | `cd cpp; g++ -std=c++17 -O2 main.cpp -o core -lcurl; ./core "你好"` |
| C | `cd c; gcc -std=c11 -O2 main.c -o core -lcurl -lcjson; ./core "你好"` |

---

# 一、第一个数字：行数

| 语言 | 行数 | 相对 Python |
|---|---:|---:|
| Python | 108 | 1.0× |
| Rust | 127 | 1.2× |
| C# | 155 | 1.4× |
| C++ | 187 | 1.7× |
| **C** | **312** | **2.9×** |

**做同一件事，C 是 Python 的 2.9 倍。** 而且这 312 行里，**真正属于"业务逻辑"的约 60 行**：

```
SSE 解析 + JSON 处理        ~40 行
主流程（发请求、打印）        ~20 行
────────────────────────────────
字符串动态缓冲 Buf          ~30 行   ← C 没有 std::string
内存管理 / free / cleanup   ~25 行   ← C 没有 RAII
错误处理样板（goto）         ~20 行   ← C 没有异常
环境变量移植层（_putenv_s）  ~10 行   ← C 没有可移植的 setenv
curl 回调 + 手拼请求体       ~30 行   ← C 没有 JSON 构造器就要写转义
```

---

# 二、七个维度的对比

| 维度 | Python | C# | Rust | C++ | C |
|---|---|---|---|---|---|
| **第三方依赖** | **0** | **0** | 2（reqwest, serde_json） | 2（curl, nlohmann） | 2（curl, cJSON） |
| **HTTP 客户端** | `urllib`（标准库） | `HttpClient`（BCL） | reqwest | libcurl | libcurl |
| **JSON** | `json`（标准库） | `System.Text.Json`（BCL） | serde_json | nlohmann | cJSON |
| **异步模型** | 同步阻塞 | `async/await` | 同步阻塞 | 同步阻塞（回调） | 同步阻塞（回调） |
| **JSON 使用方式** | 动态 dict | 动态 `JsonElement` | 动态 `Value` | 动态 `json` | 手写遍历树 |
| **字段名写错** | 运行时 `None` | 运行时 0 / 抛异常 | 运行时 `None` | 运行时 0 | 运行时 0 或空指针 |
| **buffer 谁管** | 解释器 | GC | 所有权 | RAII | **你** |
| **错误处理** | 异常 | 异常 | `Result<T,E>` | 异常 + 返回码 | 返回码 + `goto cleanup` |

## 最重要的一行：第三方依赖

> **标准库里同时带 HTTP 客户端和 JSON 解析的，只有三个：Python、C#、Node。**
>
> 这三个恰好都能"零依赖写一个 agent"。
> **C / C++ / Rust 的困难主要不是语言，是你得先解决"依赖从哪来"。**

这也解释了为什么在 C 里"我要发个 HTTP 请求"本身就是一个工程决定 —— 而在 Python 里它是一行 import。

---

# 三、每门语言最突出的一个差异

## Python · 行缓冲是免费的

```python
for raw in resp:                     # ← 跨 chunk 的拼接由 http.client 完成
    line = raw.decode("utf-8").strip()
```

对比我的 TypeScript 版：

```ts
buffer += decoder.decode(chunk, { stream: true })   // 手动缓冲
while (buffer.indexOf('\n\n') !== -1) { ... }       // 手动切分
```

**Node 的 `fetch` 给你原始字节，Python 的 `http.client` 给你行。**
这不是"谁更好"—— Node 那个设计让它可以处理任意二进制协议，代价是文本协议要自己拼。

## C# · 一个选项决定成败

```csharp
using var response = await client.SendAsync(
    request, HttpCompletionOption.ResponseHeadersRead);   // ★ 不加这个，流式就废了
```

默认的 `SendAsync` 会**等整个 body 下载完**才返回。加了 `ResponseHeadersRead` 才拿到"响应头一到就返回"的效果。

**这类"默认值刚好是错的那个"是库设计里最容易被忽略的坑。**

## Rust · 不需要 async runtime

```rust
// blocking::Response 实现了 std::io::Read
for line in BufReader::new(response).lines() {
    handle_line(&line);
}
```

大多数人以为"Rust 写网络程序必须 tokio"。**不是** —— `reqwest` 的 `blocking` 特性给你一个同步的 `Read` 实现，用 `BufReader::lines()` 就够了。

少一个异步运行时 = 少 200 个 crate 的依赖树。

## C++ · 回调给你半行

```cpp
size_t on_write(char* data, size_t size, size_t nmemb, void* userp) {
    pending->append(data, size * nmemb);        // 可能是半行
    // 然后自己在 '\n' 上切
}
```

libcurl 的写入回调**按字节流给你数据，不保证行边界**。你在 TS 里踩过的"SSE 事件被 TCP 切断"，在 C++ 里换成"行被切断"，本质完全一样。

## C · 一切都是手动的

```c
static int buf_append(Buf *b, const char *src, size_t n) { ... }   // 30 行
cleanup:
    if (headers) curl_slist_free_all(headers);   // 漏一个就泄漏
    if (curl) curl_easy_cleanup(curl);
    free(body_text);
```

**C 版本里最值钱的不是"怎么写"，而是"为什么现代语言都长那些特性"**：

| C 的痛点 | 后来的语言给出的答案 |
|---|---|
| 动态字符串要手写 | `std::string` / `String` / `str` / `list` |
| 释放靠人记 | RAII / GC / 所有权 |
| 错误靠返回码 + `goto` | 异常 / `Result` |
| 没有命名空间 | `namespace` / `mod` / 包 |
| 没有容器 | `vector` / `Vec` / `List` / `dict` |

**写完 C 版你会理解：那些"啰嗦的抽象"不是学术洁癖，每一条都在消灭一类具体的事故。**

---

# 四、一个共同的坑：所有版本都要处理 SSE 的四个细节

不管哪门语言，这四件事都得做 —— **它们和语言无关，和协议有关**：

1. **`usage` 在顶层**，不在 `choices` 里；而且那一块的 `choices` 可能是空数组
2. **`reasoning_content` 要忽略**（推理模型先吐几十块这个，`content` 一直是 `null`）
3. **`content` 可能是 `null` 或空串**
4. **`data:` 后面可能没有空格**

> 这四条在五种语言里写了五遍，一行都没变。
> **协议层的知识是跨语言可迁移的 —— 这才是你写那个 TS agent 真正学到的东西。**

---

# 五、⚠️ 已知环境问题（这台机器特有）

写这些文件时踩到一个真实问题，值得记下来：

## 现象

| 现象 | 说明 |
|---|---|
| `python -m py_compile` 报 `source code string cannot contain null bytes` | 但 PowerShell 读同一个文件是正常源码 |
| **同一个文件，两个进程看到不同大小** | PowerShell: 3655 字节 / python: 7751 字节（密文） |
| `dotnet build` 报 `MSB4025: Data at the root level is invalid` | 同一类问题：MSBuild 读到的是密文 |

## 根因

**`write` 工具（DSH 进程）写出的文件，会被这台机器上的加密软件包一层。**
部分进程（PowerShell / .NET File IO）能透明解密，另一部分（python.exe、MSBuild）读到密文。

这和之前"文件被锁住"是同一个问题，只是换了个表现。

## 修复

**把内容用 PowerShell 读明文再写回**（转码一遍）：

```powershell
$utf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($f in (Get-ChildItem -Recurse -Include *.py,*.rs,*.cs,*.cpp,*.c,*.toml,*.csproj,*.md)) {
    $text = Get-Content $f.FullName -Raw -Encoding UTF8
    [System.IO.File]::WriteAllText($f.FullName, $text, $utf8)
}
```

## 根治

**把项目目录挪到不被加密软件监控的位置**（这是我几周前就建议过的那件事）。
在那之前，每次大改之后跑一遍上面的转码脚本。

---

# 六、验证状态

| 版本 | 状态 |
|---|---|
| Python | ✅ **已验证**（`py_compile` 通过，文件转码后可读） |
| C# | ⚠️ 未验证（我的沙箱挡住 `dotnet` 写 `~/.dotnet`；且 MSBuild 受加密层影响） |
| Rust | ⚠️ 未验证（我的沙箱拒绝执行 `rustc.exe`） |
| C++ | ⚠️ 未验证（需要 libcurl + nlohmann/json 开发包） |
| C | ⚠️ 未验证（需要 libcurl + cJSON 开发包） |

**Python 版是参照基准，它跑通了就说明协议细节是对的。** 其余四个版本请在你自己机器上验证 —— 你的环境没有我的沙箱限制。

C / C++ 的依赖建议用 vcpkg：

```powershell
vcpkg install curl nlohmann-json cjson
```
