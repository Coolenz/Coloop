# OpenCode v1.19.5

Downloaded separately from https://github.com/anomalyco/opencode/releases/tag/v1.19.5.
Upstream license: https://github.com/anomalyco/opencode/blob/v1.19.5/LICENSE.
The following notice applies to OpenCode, not automatically to this integration's original files.

MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

# Existing Rockchip components and DeepSeek model

Mem0 OSS is used as an unmodified Python dependency (`mem0ai==2.2.1`), under
Apache-2.0: https://github.com/mem0ai/mem0/blob/main/LICENSE . Provider adapters,
bounded extraction prompts, idle scheduling and source-preserving summary capsules
are this project's integration. The independent `BAAI/bge-small-zh-v1.5` embedding
model is MIT licensed; downloaded file revisions and SHA-256 hashes are recorded in
the model's `manifest.json`. Qdrant, FastEmbed and ONNX Runtime retain their upstream
licenses in the private Python environment. No model weights are redistributed here.

RKLLM headers, runtime and model weights are referenced from the existing board application,
not redistributed by this repository. Their respective upstream license terms continue to apply.
