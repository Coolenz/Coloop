// Compile against each model's matching RKLLM header/library. Isolate protocol stdout.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unistd.h>
#include <fcntl.h>
#include <sys/file.h>
#include "rkllm.h"

struct Result {
    std::string text;
    bool failed = false;
    int input_tokens = 0;
    int output_tokens = 0;
    double prefill_ms = 0;
    double generate_ms = 0;
};

static int callback(RKLLMResult* result, void* data, LLMCallState state) {
    auto* output = static_cast<Result*>(data);
    if (!output) return 0;
    if (state == RKLLM_RUN_ERROR) output->failed = true;
    if (result) {
        if (state == RKLLM_RUN_NORMAL && result->text) output->text += result->text;
        if (result->perf.prefill_tokens > 0) output->input_tokens = result->perf.prefill_tokens;
        if (result->perf.generate_tokens > 0) output->output_tokens = result->perf.generate_tokens;
        if (result->perf.prefill_time_ms > 0) output->prefill_ms = result->perf.prefill_time_ms;
        if (result->perf.generate_time_ms > 0) output->generate_ms = result->perf.generate_time_ms;
    }
    return 0;
}

int main(int argc, char** argv) {
    if (argc != 11) {
        std::fprintf(stderr, "worker MODEL CONTEXT LOCK FORMAT THINKING EMBED_FLASH "
                             "DOMAIN KEEP CACHE MAX_OUTPUT\n");
        return 2;
    }
    const bool embedded = std::string(argv[4]) == "embedded";
    if (!embedded && std::string(argv[4]) != "deepseek-r1") return 2;
    const int context = std::atoi(argv[2]);
    const int thinking = std::atoi(argv[5]), embed_flash = std::atoi(argv[6]);
    const int domain = std::atoi(argv[7]), keep = std::atoi(argv[8]);
    const int native_cache = std::atoi(argv[9]), max_output = std::atoi(argv[10]);
    if (context < 512 || context > 262144 || thinking < 0 || thinking > 1
        || embed_flash < 0 || embed_flash > 1 || domain < 0 || domain > 255
        || keep < 0 || keep >= context || native_cache < 0 || native_cache > 1
        || (!embedded && native_cache) || max_output < 1 || max_output > 2048
        || max_output >= context) return 2;
    int lock_fd = open(argv[3], O_CREAT | O_RDWR, 0600);
    if (lock_fd < 0 || flock(lock_fd, LOCK_EX | LOCK_NB) != 0) {
        std::fprintf(stderr, "Model is already in use. Close its existing chat first.\n");
        return 75;
    }
    // Retain a private channel; RKLLM's printf goes to the log, never to this protocol.
    FILE* channel = fdopen(dup(STDOUT_FILENO), "wb");
    if (!channel || dup2(STDERR_FILENO, STDOUT_FILENO) < 0) return 2;
    setvbuf(channel, nullptr, _IONBF, 0);
    RKLLMParam param = rkllm_createDefaultParam();
    param.model_path = argv[1];
    param.max_context_len = context;
    param.max_new_tokens = max_output;
    param.top_k = 1;
    param.top_p = 0.95;
    param.temperature = 0.1;
    param.repeat_penalty = 1.1;
    param.skip_special_token = true;
    param.is_async = false;
    param.extend_param.embed_flash = embed_flash;
    param.extend_param.base_domain_id = domain;
    param.n_keep = keep;
    RKLLMCallback callbacks = {};
    callbacks.result_callback = callback;
    LLMHandle handle = nullptr;
    if (rkllm_init(&handle, &param, &callbacks) != 0) return 3;
    // Python supplies the complete DeepSeek transcript. Do not wrap it a second time.
    if (!embedded && rkllm_set_chat_template(handle, "", "", "") != 0) {
        rkllm_destroy(handle); return 3;
    }
    std::fprintf(channel, "READY 3\n");
    size_t length = 0;
    int tokens = 0, mode = 0;
    // mode 0: independent request; 1: new native conversation; 2: append native turn.
    while (std::scanf("%zu %d %d", &length, &tokens, &mode) == 3) {
        if (getchar() != '\n' || length == 0 || length > 262144 || tokens < 1
            || tokens > max_output || mode < 0 || mode > 2 || (!native_cache && mode != 0)) break;
        std::string prompt(length, '\0');
        if (std::fread(&prompt[0], 1, length, stdin) != length) break;
        Result output;
        RKLLMInput input = {};
        input.role = "user";
        input.enable_thinking = thinking;
        input.input_type = RKLLM_INPUT_PROMPT;
        input.prompt_input = prompt.c_str();
        RKLLMInferParam inference = {};
        inference.mode = RKLLM_INFER_GENERATE;
        inference.keep_history = mode == 0 ? 0 : 1;
        inference.max_new_tokens = tokens;
        int code = mode == 2 ? 0 : rkllm_clear_kv_cache(handle, 0, nullptr, nullptr);
        int kv_before = 0, kv_after = 0;
        if (code == 0) code = rkllm_get_kv_cache_size(handle, &kv_before);
        if (code == 0) code = rkllm_run(handle, &input, &inference, &output);
        if (output.failed && code == 0) code = -1;
        if (code == 0) code = rkllm_get_kv_cache_size(handle, &kv_after);
        std::fprintf(channel, "%d %zu %d %d %.3f %.3f %d %d\n", code, output.text.size(),
                     output.input_tokens, output.output_tokens, output.prefill_ms,
                     output.generate_ms, kv_before, kv_after);
        if (!output.text.empty()) std::fwrite(output.text.data(), 1, output.text.size(), channel);
    }
    rkllm_destroy(handle);
    fclose(channel);
    close(lock_fd);
    return 0;
}
