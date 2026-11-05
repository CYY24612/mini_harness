// 最小 agent 内核 —— C# 版。
//
// 依赖：零。HttpClient 和 System.Text.Json 都在 .NET BCL 里。
//
// 跑法：dotnet run -- "用一句话解释什么是事件循环"

using System.Text;
using System.Text.Json;

namespace Core;

internal static class Program
{
    private static void LoadEnv(string path)
    {
        if (!File.Exists(path))
        {
            return;
        }

        foreach (var raw in File.ReadLines(path, Encoding.UTF8))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#') || !line.Contains('='))
            {
                continue;
            }

            var idx = line.IndexOf('=');
            var key = line[..idx].Trim();
            var value = line[(idx + 1)..].Trim();

            // 不覆盖已存在的环境变量
            if (Environment.GetEnvironmentVariable(key) is null)
            {
                Environment.SetEnvironmentVariable(key, value);
            }
        }
    }

    /// <summary>处理一行 SSE。返回 true 表示收到 [DONE]。</summary>
    private static bool HandleLine(string raw)
    {
        var line = raw.Trim();
        if (!line.StartsWith("data:", StringComparison.Ordinal))
        {
            return false;
        }

        var payload = line[5..].Trim();
        if (payload == "[DONE]")
        {
            return true;
        }

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(payload);
        }
        catch (JsonException)
        {
            return false;
        }

        using (doc)
        {
            var root = doc.RootElement;

            if (root.TryGetProperty("usage", out var usage) &&
                usage.ValueKind == JsonValueKind.Object)
            {
                var p = usage.TryGetProperty("prompt_tokens", out var pe) ? pe.GetInt32() : 0;
                var c = usage.TryGetProperty("completion_tokens", out var ce) ? ce.GetInt32() : 0;
                Console.WriteLine($"\n\n[usage] prompt={p} completion={c}");
                return false;
            }

            if (root.TryGetProperty("choices", out var choices) &&
                choices.ValueKind == JsonValueKind.Array)
            {
                foreach (var choice in choices.EnumerateArray())
                {
                    if (choice.TryGetProperty("delta", out var delta) &&
                        delta.TryGetProperty("content", out var content) &&
                        content.ValueKind == JsonValueKind.String)
                    {
                        var text = content.GetString();
                        if (!string.IsNullOrEmpty(text))
                        {
                            Console.Write(text);
                            Console.Out.Flush();
                        }
                    }
                }
            }
        }

        return false;
    }

    private static async Task<int> Main(string[] args)
    {
        LoadEnv(".env");

        var baseUrl = Environment.GetEnvironmentVariable("OPENAI_BASE_URL");
        var apiKey = Environment.GetEnvironmentVariable("OPENAI_API_KEY");
        var model = Environment.GetEnvironmentVariable("AGENT_MODEL");

        if (string.IsNullOrEmpty(baseUrl) || string.IsNullOrEmpty(apiKey) ||
            string.IsNullOrEmpty(model))
        {
            await Console.Error.WriteLineAsync(
                "缺少环境变量：OPENAI_BASE_URL / OPENAI_API_KEY / AGENT_MODEL");
            return 1;
        }

        var joined = string.Join(' ', args);
        var prompt = joined.Length == 0 ? "用一句话解释什么是事件循环" : joined;

        // 用匿名对象构造请求体 —— 字段名由编译器检查
        var body = JsonSerializer.Serialize(new
        {
            model,
            stream = true,
            messages = new object[]
            {
                new { role = "system", content = "回答简洁。" },
                new { role = "user", content = prompt },
            },
        });

        using var client = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"{baseUrl.TrimEnd('/')}/chat/completions");
        request.Headers.TryAddWithoutValidation("authorization", $"Bearer {apiKey}");
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");

        // ★ ResponseHeadersRead：拿到响应头就返回，不等 body 下载完。
        //   不加这个，整段内容会在响应结束时才一次性到达 —— 流式就白做了。
        using var response = await client.SendAsync(
            request, HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(stream, Encoding.UTF8);

        Console.WriteLine($"你 > {prompt}\n");

        while (await reader.ReadLineAsync() is { } line)
        {
            if (HandleLine(line))
            {
                break;
            }
        }

        return 0;
    }
}
