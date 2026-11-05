#!/usr/bin/env python3
"""最小 agent 内核 —— Python 版。

只用标准库：urllib 负责 HTTP，json 负责解析，ssl 是 urllib 的隐式依赖。
零第三方依赖。

跑法：  python main.py "用一句话解释什么是事件循环"
"""

import json
import os
import sys
import urllib.request


def load_env(path: str) -> None:
    """读 KEY=VALUE 格式的 .env，不覆盖已存在的环境变量。"""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def stream_chat(base_url: str, api_key: str, model: str, messages: list):
    """发流式请求，逐个产出 ("text", str) / ("usage", dict)。"""
    body = json.dumps(
        {"model": model, "messages": messages, "stream": True}
    ).encode("utf-8")

    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=body,
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    with urllib.request.urlopen(req) as resp:
        # ★ 按行迭代 —— 跨 chunk 的拼接由 http.client 替你完成。
        #   对比 TypeScript：那边拿到的是原始 Uint8Array，要自己 buffer += decode(chunk)。
        for raw in resp:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data:"):
                continue

            payload = line[5:].strip()
            if payload == "[DONE]":
                break

            try:
                chunk = json.loads(payload)
            except json.JSONDecodeError:
                continue

            # usage 在顶层，而且此时 choices 可能是空数组
            usage = chunk.get("usage")
            if usage:
                yield ("usage", usage)
                continue

            for choice in chunk.get("choices") or []:
                delta = choice.get("delta") or {}
                content = delta.get("content")
                # content 可能是 None 或 ""；reasoning_content 是另一个字段，忽略
                if content:
                    yield ("text", content)


def main() -> None:
    load_env(".env")

    base_url = os.environ.get("OPENAI_BASE_URL")
    api_key = os.environ.get("OPENAI_API_KEY")
    model = os.environ.get("AGENT_MODEL")
    if not (base_url and api_key and model):
        print(
            "缺少环境变量：OPENAI_BASE_URL / OPENAI_API_KEY / AGENT_MODEL",
            file=sys.stderr,
        )
        sys.exit(1)

    prompt = " ".join(sys.argv[1:]) or "用一句话解释什么是事件循环"

    messages = [
        {"role": "system", "content": "回答简洁。"},
        {"role": "user", "content": prompt},
    ]

    print(f"你 > {prompt}\n")
    try:
        for kind, value in stream_chat(base_url, api_key, model, messages):
            if kind == "text":
                sys.stdout.write(value)
                sys.stdout.flush()  # ★ 不 flush 就看不到"流"
            else:
                print(
                    f"\n\n[usage] prompt={value.get('prompt_tokens')} "
                    f"completion={value.get('completion_tokens')}"
                )
    except urllib.error.HTTPError as e:
        print(f"\nHTTP {e.code}: {e.read().decode('utf-8', 'replace')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
