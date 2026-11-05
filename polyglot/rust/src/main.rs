//! 最小 agent 内核 —— Rust 版。
//!
//! 依赖：reqwest（blocking）+ serde_json。
//! 这两个都不是标准库能提供的东西 —— 这是和 Python / C# / Node 最大的差别。
//!
//! 跑法：cargo run -- "用一句话解释什么是事件循环"

use std::io::{BufRead, BufReader, Write};
use std::process::ExitCode;

fn load_env(path: &str) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        // 不覆盖已存在的环境变量
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    }
}

/// 处理一行 SSE。返回 true 表示收到 [DONE]。
fn handle_line(raw: &str) -> bool {
    let line = raw.trim();
    if !line.starts_with("data:") {
        return false;
    }

    let payload = line[5..].trim();
    if payload == "[DONE]" {
        return true;
    }

    // serde_json::Value 是动态类型 —— 和 Python 的 dict 一样，
    // 字段名写错只会在运行时返回 None，不会编译报错。
    let Ok(chunk) = serde_json::from_str::<serde_json::Value>(payload) else {
        return false;
    };

    if let Some(usage) = chunk.get("usage").filter(|u| !u.is_null()) {
        println!(
            "\n\n[usage] prompt={} completion={}",
            usage["prompt_tokens"], usage["completion_tokens"]
        );
        return false;
    }

    if let Some(choices) = chunk["choices"].as_array() {
        for choice in choices {
            if let Some(text) = choice["delta"]["content"].as_str() {
                if !text.is_empty() {
                    print!("{text}");
                    let _ = std::io::stdout().flush();
                }
            }
        }
    }

    false
}

fn main() -> ExitCode {
    load_env(".env");

    let base_url = std::env::var("OPENAI_BASE_URL").unwrap_or_default();
    let api_key = std::env::var("OPENAI_API_KEY").unwrap_or_default();
    let model = std::env::var("AGENT_MODEL").unwrap_or_default();

    if base_url.is_empty() || api_key.is_empty() || model.is_empty() {
        eprintln!("缺少环境变量：OPENAI_BASE_URL / OPENAI_API_KEY / AGENT_MODEL");
        return ExitCode::FAILURE;
    }

    let joined = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
    let prompt = if joined.is_empty() {
        "用一句话解释什么是事件循环".to_string()
    } else {
        joined
    };

    let body = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": [
            { "role": "system", "content": "回答简洁。" },
            { "role": "user", "content": prompt },
        ],
    });

    let client = reqwest::blocking::Client::new();
    let request = client
        .post(format!(
            "{}/chat/completions",
            base_url.trim_end_matches('/')
        ))
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {api_key}"))
        .body(serde_json::to_vec(&body).unwrap())
        .send();

    let response = match request {
        Ok(r) => r,
        Err(e) => {
            eprintln!("请求失败: {e}");
            return ExitCode::FAILURE;
        }
    };

    if !response.status().is_success() {
        eprintln!("HTTP {}", response.status());
        return ExitCode::FAILURE;
    }

    println!("你 > {prompt}\n");

    // ★ 关键：blocking::Response 实现了 std::io::Read，
    //   所以可以直接包进 BufReader 按行读 —— 不需要 async 运行时。
    for line in BufReader::new(response).lines() {
        let Ok(line) = line else { break };
        if handle_line(&line) {
            break;
        }
    }

    ExitCode::SUCCESS
}
