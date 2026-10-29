#include "RK35llm.h"
#include "input_utf8.h"
#include <chrono>

int main(int argc, char** argv)
{
    std::string image, prompt;
    // Both pinned RK3588 model files report max_context_limit=16384.
    constexpr int min_context = 512, max_context = 16384;
    int tokens = 128, context = max_context;
    try {
        for (int i = 1; i < argc; ++i) {
            const std::string arg = argv[i];
            if (arg == "--help") {
                std::cout << "qwen35 [--image FILE] [--prompt TEXT] [--tokens 128] [--context 16384]\n"
                          << "Context range: 512..16384 (pinned RKLLM model limit).\n";
                return 0;
            }
            if (i + 1 >= argc) throw std::runtime_error("Missing option value");
            const std::string value = argv[++i];
            if (arg == "--image") image = value;
            else if (arg == "--prompt") prompt = value;
            else if (arg == "--tokens") tokens = std::stoi(value);
            else if (arg == "--context") context = std::stoi(value);
            else throw std::runtime_error("Unknown option: " + arg);
        }
        if (tokens < 1 || tokens > 1024 || context < min_context || context > max_context || tokens >= context)
            throw std::runtime_error("Require 1..1024 output tokens, 512..16384 context, output < context");
        cv::Mat frame;
        if (!image.empty()) {
            frame = cv::imread(image);
            if (frame.empty()) throw std::runtime_error("Cannot read image: " + image);
        }
        const auto start = std::chrono::steady_clock::now();
        std::cout << "CONFIG context=" << context << " max_new_tokens=" << tokens << std::endl;
        RK35llm model;
        model.SetInfo(true);
        model.SetSilence(false);
        model.SetThinking(false);
        if (!model.LoadModel(image.empty() ? "" : "qwen3.5-9b_vision_rk3588.rknn",
                             "qwen3.5-9b_w8a8_rk3588.rkllm", tokens, context))
            throw std::runtime_error("Model initialization failed");
        if (!image.empty()) model.LoadImage(frame);
        const auto ready = std::chrono::steady_clock::now();
        std::cout << "\nREADY initialization_seconds="
                  << std::chrono::duration<double>(ready - start).count() << std::endl;
        auto ask = [&](std::string question) {
            if (!valid_utf8_input(question)) throw std::runtime_error("Input must be valid UTF-8");
            if (!image.empty() && question != "clear" && question.find("<image>") == std::string::npos)
                question = "<image>" + question;
            const auto before = std::chrono::steady_clock::now();
            model.Ask(question);
            std::cout << "\nTURN_SECONDS=" << std::chrono::duration<double>(
                std::chrono::steady_clock::now() - before).count() << std::endl;
        };
        if (!prompt.empty()) {
            model.SetHistory(false);
            ask(prompt);
            return 0;
        }
        std::cout << "输入问题；clear 清空历史；exit 退出。" << std::endl;
        std::string line;
        while (std::cout << "\nUser: " && std::getline(std::cin, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (line == "exit") break;
            if (line.empty()) continue;
            if (!valid_utf8_input(line)) { std::cerr << "输入不是有效 UTF-8。\n"; continue; }
            ask(line);
        }
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "ERROR: " << error.what() << std::endl;
        return 2;
    }
}
