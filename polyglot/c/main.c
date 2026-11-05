/* 最小 agent 内核 —— C 版。
 *
 * 依赖：libcurl（HTTP）+ cJSON（JSON）。
 * 两者都不在标准库里，而且 C 还没有：
 *   - 动态字符串（要自己写 append / grow）
 *   - 异常 / Result（错误码 + goto cleanup）
 *   - 名字空间
 *
 * 这个文件比 Python 版长 3 倍，而 **其中真正的"业务逻辑"只占 20%**。
 * 剩下 80% 是：字符串缓冲、内存管理、JSON 遍历、错误处理样板。
 *
 * Linux:   gcc -std=c11 -O2 main.c -o core -lcurl -lcjson
 * Windows: 用 vcpkg 装 curl 和 cjson
 *
 * 跑法：./core "用一句话解释什么是事件循环"
 */

#include <curl/curl.h>
#include <cJSON.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ──────────────────────────── 动态字符串 ──────────────────────────── */
/* C 没有 std::string / str / String，这 25 行是任何 C 项目的第一笔开销。 */

typedef struct {
    char *data;
    size_t len;
    size_t cap;
} Buf;

static int buf_init(Buf *b, size_t cap) {
    b->data = (char *)malloc(cap);
    if (!b->data) return 0;
    b->len = 0;
    b->cap = cap;
    if (cap > 0) b->data[0] = '\0';
    return 1;
}

static int buf_append(Buf *b, const char *src, size_t n) {
    if (b->len + n + 1 > b->cap) {
        size_t next = b->cap ? b->cap : 1024;
        while (next < b->len + n + 1) next *= 2;
        char *grown = (char *)realloc(b->data, next);
        if (!grown) return 0;
        b->data = grown;
        b->cap = next;
    }
    memcpy(b->data + b->len, src, n);
    b->len += n;
    b->data[b->len] = '\0';
    return 1;
}

static void buf_free(Buf *b) {
    free(b->data);
    b->data = NULL;
    b->len = b->cap = 0;
}

/* ──────────────────────────── 工具函数 ──────────────────────────── */

static char *xstrdup(const char *s) {
    size_t n = strlen(s) + 1;
    char *p = (char *)malloc(n);
    if (p) memcpy(p, s, n);
    return p;
}

/* 原地去掉首尾空白，返回新的起点（可能指向 s 内部） */
static char *trim(char *s) {
    while (*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n') s++;
    if (*s == '\0') return s;
    char *end = s + strlen(s) - 1;
    while (end > s && (*end == ' ' || *end == '\t' || *end == '\r' || *end == '\n')) {
        *end = '\0';
        end--;
    }
    return s;
}

static void load_env(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return;

    char line[4096];
    while (fgets(line, sizeof(line), f)) {
        char *p = trim(line);
        if (*p == '\0' || *p == '#') continue;

        char *eq = strchr(p, '=');
        if (!eq) continue;

        *eq = '\0';
        char *key = trim(p);
        char *value = trim(eq + 1);
        if (*key == '\0') continue;

#ifdef _WIN32
        _putenv_s(key, value);
#else
        if (getenv(key) == NULL) setenv(key, value, 0);
#endif
    }
    fclose(f);
}

/* ──────────────────────────── SSE 行处理 ──────────────────────────── */

static int g_done = 0;

/* 返回 1 表示这行被处理了（无论有无内容） */
static int handle_line(const char *raw) {
    char *copy = xstrdup(raw);
    if (!copy) return 0;

    char *line = trim(copy);
    if (strncmp(line, "data:", 5) != 0) {
        free(copy);
        return 0;
    }

    char *payload = trim(line + 5);
    if (strcmp(payload, "[DONE]") == 0) {
        g_done = 1;
        free(copy);
        return 1;
    }

    cJSON *chunk = cJSON_Parse(payload);
    if (!chunk) {
        free(copy);
        return 0;
    }

    /* usage 在顶层，此时 choices 可能是空数组 */
    cJSON *usage = cJSON_GetObjectItemCaseSensitive(chunk, "usage");
    if (cJSON_IsObject(usage)) {
        cJSON *pt = cJSON_GetObjectItemCaseSensitive(usage, "prompt_tokens");
        cJSON *ct = cJSON_GetObjectItemCaseSensitive(usage, "completion_tokens");
        printf("\n\n[usage] prompt=%d completion=%d\n",
               cJSON_IsNumber(pt) ? pt->valueint : 0,
               cJSON_IsNumber(ct) ? ct->valueint : 0);
        fflush(stdout);
        cJSON_Delete(chunk);
        free(copy);
        return 1;
    }

    cJSON *choices = cJSON_GetObjectItemCaseSensitive(chunk, "choices");
    if (cJSON_IsArray(choices)) {
        cJSON *choice = NULL;
        cJSON_ArrayForEach(choice, choices) {
            cJSON *delta = cJSON_GetObjectItemCaseSensitive(choice, "delta");
            cJSON *content = cJSON_GetObjectItemCaseSensitive(delta, "content");
            if (cJSON_IsString(content) && content->valuestring[0] != '\0') {
                fputs(content->valuestring, stdout);
                fflush(stdout);
            }
        }
    }

    cJSON_Delete(chunk);
    free(copy);
    return 1;
}

/* ──────────────────────────── libcurl 回调 ──────────────────────────── */

static size_t on_write(char *data, size_t size, size_t nmemb, void *userp) {
    Buf *pending = (Buf *)userp;
    size_t total = size * nmemb;

    if (!buf_append(pending, data, total)) return 0; /* 返回 0 → curl 中止 */

    /* 数据可能一次来半行，所以要按 '\n' 自己切 */
    size_t start = 0;
    for (;;) {
        char *nl = memchr(pending->data + start, '\n', pending->len - start);
        if (!nl) break;

        size_t end = (size_t)(nl - pending->data);
        char *line = (char *)malloc(end - start + 1);
        if (!line) return 0;
        memcpy(line, pending->data + start, end - start);
        line[end - start] = '\0';

        handle_line(line);
        free(line);

        start = end + 1;
        if (g_done) break;
    }

    if (start > 0) {
        memmove(pending->data, pending->data + start, pending->len - start);
        pending->len -= start;
        pending->data[pending->len] = '\0';
    }

    return total;
}

/* ──────────────────────────── main ──────────────────────────── */

int main(int argc, char **argv) {
    int rc = 1;
    CURL *curl = NULL;
    struct curl_slist *headers = NULL;
    char *body_text = NULL;
    Buf pending = {0};

    load_env(".env");

    const char *base_url = getenv("OPENAI_BASE_URL");
    const char *api_key = getenv("OPENAI_API_KEY");
    const char *model = getenv("AGENT_MODEL");

    if (!base_url || !api_key || !model) {
        fprintf(stderr, "缺少环境变量：OPENAI_BASE_URL / OPENAI_API_KEY / AGENT_MODEL\n");
        return 1;
    }

    /* 拼 prompt */
    Buf prompt = {0};
    if (!buf_init(&prompt, 256)) goto cleanup;
    for (int i = 1; i < argc; i++) {
        if (i > 1 && !buf_append(&prompt, " ", 1)) goto cleanup;
        if (!buf_append(&prompt, argv[i], strlen(argv[i]))) goto cleanup;
    }
    if (prompt.len == 0 && !buf_append(&prompt, "用一句话解释什么是事件循环", 39)) {
        goto cleanup;
    }

    /* 构造请求体 —— 用 cJSON 而不是 snprintf，避免手写转义 */
    {
        cJSON *root = cJSON_CreateObject();
        cJSON *messages = cJSON_AddArrayToObject(root, "messages");
        cJSON *sys = cJSON_CreateObject();
        cJSON *usr = cJSON_CreateObject();

        cJSON_AddStringToObject(root, "model", model);
        cJSON_AddBoolToObject(root, "stream", 1);

        cJSON_AddStringToObject(sys, "role", "system");
        cJSON_AddStringToObject(sys, "content", "回答简洁。");
        cJSON_AddStringToObject(usr, "role", "user");
        cJSON_AddStringToObject(usr, "content", prompt.data);

        cJSON_AddItemToArray(messages, sys);
        cJSON_AddItemToArray(messages, usr);

        body_text = cJSON_PrintUnformatted(root);
        cJSON_Delete(root);
        if (!body_text) goto cleanup;
    }

    curl_global_init(CURL_GLOBAL_DEFAULT);
    curl = curl_easy_init();
    if (!curl) {
        fprintf(stderr, "curl_easy_init 失败\n");
        goto cleanup;
    }

    if (!buf_init(&pending, 8192)) goto cleanup;

    {
        char *url = (char *)malloc(strlen(base_url) + 32);
        char *auth = (char *)malloc(strlen(api_key) + 32);
        if (!url || !auth) {
            free(url);
            free(auth);
            goto cleanup;
        }
        sprintf(url, "%s/chat/completions", base_url);
        sprintf(auth, "authorization: Bearer %s", api_key);

        headers = curl_slist_append(headers, "content-type: application/json");
        headers = curl_slist_append(headers, "expect:");
        headers = curl_slist_append(headers, auth);

        curl_easy_setopt(curl, CURLOPT_URL, url);
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body_text);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(body_text));
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, on_write);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &pending);

        printf("你 > %s\n\n", prompt.data);

        CURLcode cr = curl_easy_perform(curl);
        long status = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);

        if (cr != CURLE_OK) {
            fprintf(stderr, "\n请求失败: %s\n", curl_easy_strerror(cr));
        } else if (status < 200 || status >= 300) {
            fprintf(stderr, "\nHTTP %ld\n", status);
        } else {
            rc = 0;
        }

        free(url);
        free(auth);
    }

cleanup:
    /* ★ 这段 cleanup 是 C 的日常：任何一步失败，都必须跳到同一个地方释放所有东西。
       漏掉任何一个 → 泄漏。这就是 RAII / defer / try-with-resources 想解决的问题。 */
    if (headers) curl_slist_free_all(headers);
    if (curl) curl_easy_cleanup(curl);
    free(body_text);
    buf_free(&pending);
    buf_free(&prompt);
    return rc;
}
