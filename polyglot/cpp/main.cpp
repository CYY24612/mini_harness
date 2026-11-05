// 最小 agent 内核 —— C++ 版。
//
// 依赖：libcurl（HTTP）+ nlohmann/json（JSON）。
// 两者都 **不在标准库里** —— 这是和 Python / C# / Node 最根本的差别。
//
// Linux:   g++ -std=c++17 -O2 main.cpp -o core -lcurl
// Windows: 用 vcpkg 装 curl 和 nlohmann-json，或用 CMake 的 find_package
//
// 跑法：./core "用一句话解释什么是事件循环"

#include <curl/curl.h>
#include <nlohmann/json.hpp>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>

using json = nlohmann::json;

namespace {

bool g_done = false;

std::string trim(const std::string& s) {
    const auto b = s.find_first_not_of(" \t\r\n");
    if (b == std::string::npos) return "";
    const auto e = s.find_last_not_of(" \t\r\n");
    return s.substr(b, e - b + 1);
}

// 处理一行 SSE。设置 g_done 表示收到 [DONE]。
void handle_line(const std::string& raw) {
    const std::string line = trim(raw);
    if (line.rfind("data:", 0) != 0) return;

    const std::string payload = trim(line.substr(5));
    if (payload == "[DONE]") {
        g_done = true;
        return;
    }

    // 解析失败不抛异常（allow_exceptions=false → discarded）
    const json chunk = json::parse(payload, nullptr, false);
    if (chunk.is_discarded()) return;

    // usage 在顶层，此时 choices 可能是空数组
    if (chunk.contains("usage") && !chunk["usage"].is_null()) {
        const auto& u = chunk["usage"];
        std::cout << "\n\n[usage] prompt=" << u.value("prompt_tokens", 0)
                  << " completion=" << u.value("completion_tokens", 0)
                  << std::endl;
        return;
    }

    if (!chunk.contains("choices") || !chunk["choices"].is_array()) return;

    for (const auto& choice : chunk["choices"]) {
        if (!choice.contains("delta")) continue;
        const auto& delta = choice["delta"];
        if (!delta.contains("content") || !delta["content"].is_string()) continue;

        const auto text = delta["content"].get<std::string>();
        if (text.empty()) continue;

        std::cout << text << std::flush;
    }
}

// libcurl 写出回调：数据可能一次来半行，所以要自己按 '\n' 切
size_t on_write(char* data, size_t size, size_t nmemb, void* userp) {
    auto* pending = static_cast<std::string*>(userp);
    const size_t total = size * nmemb;
    pending->append(data, total);

    size_t start = 0;
    for (;;) {
        const auto nl = pending->find('\n', start);
        if (nl == std::string::npos) break;

        handle_line(pending->substr(start, nl - start));
        start = nl + 1;

        if (g_done) break;
    }
    pending->erase(0, start);

    return total;
}

void load_env(const char* path) {
    std::ifstream in(path);
    if (!in) return;

    std::string raw;
    while (std::getline(in, raw)) {
        const std::string line = trim(raw);
        if (line.empty() || line[0] == '#') continue;

        const auto eq = line.find('=');
        if (eq == std::string::npos) continue;

        const std::string key = trim(line.substr(0, eq));
        const std::string value = trim(line.substr(eq + 1));

        // 不覆盖已存在的环境变量
#ifdef _WIN32
        _putenv_s(key.c_str(), value.c_str());
#else
        setenv(key.c_str(), value.c_str(), 0);
#endif
    }
}

std::string env_or_empty(const char* name) {
    const char* v = std::getenv(name);
    return v ? v : "";
}

}  // namespace

int main(int argc, char** argv) {
    load_env(".env");

    const std::string base_url = env_or_empty("OPENAI_BASE_URL");
    const std::string api_key = env_or_empty("OPENAI_API_KEY");
    const std::string model = env_or_empty("AGENT_MODEL");

    if (base_url.empty() || api_key.empty() || model.empty()) {
        std::cerr << "缺少环境变量：OPENAI_BASE_URL / OPENAI_API_KEY / AGENT_MODEL"
                  << std::endl;
        return 1;
    }

    std::string prompt;
    for (int i = 1; i < argc; ++i) {
        if (i > 1) prompt += ' ';
        prompt += argv[i];
    }
    if (prompt.empty()) prompt = "用一句话解释什么是事件循环";

    json body;
    body["model"] = model;
    body["stream"] = true;
    body["messages"] = json::array({
        {{"role", "system"}, {"content", "回答简洁。"}},
        {{"role", "user"}, {"content", prompt}},
    });
    const std::string body_text = body.dump();

    CURL* curl = curl_easy_init();
    if (!curl) {
        std::cerr << "curl_easy_init 失败" << std::endl;
        return 1;
    }

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "content-type: application/json");
    headers = curl_slist_append(headers, "expect:");  // 避免 100-continue 延迟
    const std::string auth = "authorization: Bearer " + api_key;
    headers = curl_slist_append(headers, auth.c_str());

    const std::string url = base_url + "/chat/completions";
    std::string pending;

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body_text.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body_text.size()));
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, on_write);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &pending);

    std::cout << "你 > " << prompt << "\n" << std::endl;

    const CURLcode rc = curl_easy_perform(curl);

    long status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (rc != CURLE_OK) {
        std::cerr << "\n请求失败: " << curl_easy_strerror(rc) << std::endl;
        return 1;
    }
    if (status < 200 || status >= 300) {
        std::cerr << "\nHTTP " << status << std::endl;
        return 1;
    }

    return 0;
}
