"""Prepare a pinned, locally patched Qwen3.5-9B application bundle."""
import hashlib
import io
import json
import re
import urllib.request
import zipfile

from prepare_qwen35 import DEST, ROOT

SOURCE_REV = '304aaaa1c1b6c70bcea2c3df37572e828994fe0a'
BUNDLE = ROOT / 'deployment/qwen35'
SDK_FILES = {
    'lib/librkllmrt.so': ('rkllm-runtime/Linux/librkllm_api/aarch64/librkllmrt.so',
                        '6a9e4fc5324c68921c3a900340361e107af7599fe34dc8fa7759b2c5ae22a6e6'),
    'include/rkllm.h': ('rkllm-runtime/Linux/librkllm_api/include/rkllm.h',
                       '80596a578f7f8e70df6eda1c2cbead3bfced14623a190258f2bd009a3d1f72cf'),
}


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f'Unexpected upstream source: {old[:80]}')
    return text.replace(old, new, 1)


def main(*, bundle=BUNDLE, destination=DEST, source_revision=SOURCE_REV,
         source_repository='Qengineering/Qwen3.5-9B-NPU', model_stem='qwen3.5-9b', lock_name='qwen35'):
    BUNDLE, DEST, SOURCE_REV = bundle, destination, source_revision
    archive = DEST / 'upstream.zip'
    if not archive.exists():
        url = f'https://codeload.github.com/{source_repository}/zip/{SOURCE_REV}'
        archive.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=60) as response:
            archive.write_bytes(response.read())
    data = archive.read_bytes()
    z = zipfile.ZipFile(io.BytesIO(data))
    if z.comment.decode() != SOURCE_REV:
        raise ValueError('Unexpected upstream archive revision')
    prefix = z.namelist()[0].split('/')[0] + '/'
    source = z.read(prefix + 'src/RK35llm.cpp').decode()
    header = z.read(prefix + 'include/RK35llm.h').decode()
    source, template_calls = re.subn(
        r'rkllm_set_chat_template\(llmHandle,.*?\);',
        '// Keep the embedded Qwen3.5 template and enable_thinking handling.', source, flags=re.S)
    if template_calls != 2:
        raise ValueError('Unexpected custom-template calls in upstream source')
    source = replace_once(source, '    else if(Info) printf("rkllm init success\\n");',
                          '    else if(Info) printf("rkllm init success\\n");\n'
                          '    ret = rkllm_clear_kv_cache(llmHandle, 0, nullptr, nullptr);\n'
                          '    if (ret != 0) return false;')
    header = replace_once(header, '#include <opencv2/opencv.hpp>',
                          '#include <opencv2/core.hpp>\n#include <opencv2/imgproc.hpp>\n'
                          '#include <opencv2/imgcodecs.hpp>\n#include <stdexcept>')
    header = replace_once(header, 'bool                responseReady_ = false;',
                          'bool                responseReady_ = false;\n'
                          '    bool                inferenceFailed_ = false;')
    start = source.index('int RK35llm::InstanceCallback(')
    end = source.index('//----------------------------------------------------------------------------------------', start)
    source = source[:start] + '''int RK35llm::InstanceCallback(RKLLMResult* result, LLMCallState state)
{
    std::lock_guard<std::mutex> lock(responseMutex_);
    if (state == RKLLM_RUN_FINISH || state == RKLLM_RUN_ERROR) {
        inferenceFailed_ = (state == RKLLM_RUN_ERROR);
        if (!Silence) { printf("\\n"); fflush(stdout); }
        responseReady_ = true;
        responseCv_.notify_all();
    } else if (state == RKLLM_RUN_NORMAL && result && result->text) {
        responseBuffer_ += result->text;
        if (!Silence) { printf("%s", result->text); fflush(stdout); }
    }
    return 0;
}
''' + source[end:]
    source = replace_once(source, 'rknn_outputs_release(rknn_app_ctx.rknn_ctx, 1, outputs);',
                          'rknn_outputs_release(rknn_app_ctx.rknn_ctx, rknn_app_ctx.io_num.n_output, outputs);')
    source = replace_once(source, '    ret = InitImgEnc(VLMmodel.c_str());\n    if(ret != 0) return false;',
                          '    if (!VLMmodel.empty()) {\n'
                          '        ret = InitImgEnc(VLMmodel.c_str());\n'
                          '        if (ret != 0) return false;\n    }')
    source = replace_once(source, '    RunImgEnc(ImgVec); // Pass base pointer',
                          '    if (RunImgEnc(ImgVec) != 0) throw std::runtime_error("Image encoder failed");')
    source = replace_once(source, '        RunImgEnc(ImgVec + (i * single_frame_size));',
                          '        if (RunImgEnc(ImgVec + (i * single_frame_size)) != 0)\n'
                          '            throw std::runtime_error("Video frame encoder failed");')
    source = replace_once(source, '        responseReady_ = false;\n    }',
                          '        responseReady_ = false;\n        inferenceFailed_ = false;\n    }')
    source = replace_once(source, '    if (ret != 0) std::cerr << "rkllm_run returned " << ret << "\\n";',
                          '    if (ret != 0) throw std::runtime_error("rkllm_run returned " + std::to_string(ret));')
    source = replace_once(source, '    return responseBuffer_;',
                          '    if (inferenceFailed_) throw std::runtime_error("Inference callback reported an error");\n'
                          '    return responseBuffer_;')
    for rel, content in {'src/RK35llm.cpp': source, 'include/RK35llm.h': header}.items():
        target = BUNDLE / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8', newline='\n')
    (BUNDLE / 'samples').mkdir(exist_ok=True)
    (BUNDLE / 'samples/moon.jpg').write_bytes(z.read(prefix + 'Moon.jpg'))
    (BUNDLE / 'LICENSE').write_bytes(z.read(prefix + 'LICENSE'))
    # Use the already verified official runtime, with matching SDK header.
    sdk = ROOT / 'downloads/rkllm-1.3.0-qwen35'
    for local_name, (upstream_name, expected) in SDK_FILES.items():
        cached = sdk / local_name
        if cached.exists():
            content = cached.read_bytes()
        else:
            url = 'https://raw.githubusercontent.com/airockchip/rknn-llm/release-v1.3.0/' + upstream_name
            with urllib.request.urlopen(url, timeout=60) as response:
                content = response.read()
        if hashlib.sha256(content).hexdigest() != expected:
            raise ValueError(f'Official RKLLM 1.3.0 SDK SHA256 mismatch: {local_name}')
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(content)
    for relative, original in {
        'lib/librkllmrt.so': sdk / 'lib/librkllmrt.so',
        'include/rkllm.h': sdk / 'include/rkllm.h',
        'include/input_utf8.h': ROOT / 'tools/qwen35_input_utf8.h',
    }.items():
        if relative == 'lib/librkllmrt.so' and hashlib.sha256(original.read_bytes()).hexdigest() != \
                '6a9e4fc5324c68921c3a900340361e107af7599fe34dc8fa7759b2c5ae22a6e6':
            raise ValueError('Official RKLLM runtime SHA256 mismatch')
        target = BUNDLE / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(original.read_bytes())
    # RKNN header from the source archive is paired with its API usage. The
    # deployment script copies the board's existing runtime into this app only.
    (BUNDLE / 'include/rknn_api.h').write_bytes(z.read(prefix + 'aarch64/include/rknn_api.h'))
    main_cpp = ROOT / 'tools/qwen35_main.cpp'
    (BUNDLE / 'src/main.cpp').write_text(main_cpp.read_text(encoding='utf-8').replace(
        'qwen3.5-9b', model_stem), encoding='utf-8', newline='\n')
    (BUNDLE / 'CMakeLists.txt').write_text('''cmake_minimum_required(VERSION 3.10)
project(qwen35 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
add_executable(qwen35 src/main.cpp src/RK35llm.cpp)
target_include_directories(qwen35 PRIVATE include /usr/include/opencv4)
target_compile_options(qwen35 PRIVATE -O2 -Wall -pthread)
target_link_libraries(qwen35 PRIVATE opencv_core opencv_imgproc opencv_imgcodecs
    ${CMAKE_SOURCE_DIR}/lib/librkllmrt.so ${CMAKE_SOURCE_DIR}/lib/librknnrt.so
    dl pthread gomp)
set_target_properties(qwen35 PROPERTIES BUILD_RPATH "$ORIGIN/../lib")
''', encoding='utf-8')
    (BUNDLE / 'run.sh').write_text('''#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
export LANG=C.UTF-8 LC_ALL=C.UTF-8
export LD_LIBRARY_PATH="$PWD/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export RKLLM_LOG_LEVEL="${RKLLM_LOG_LEVEL:-1}"
exec flock -n -E 75 "$HOME/rk-edge-ai/.qwen35-inference.lock" ./build/qwen35 "$@"
'''.replace('.qwen35-inference.lock', f'.{lock_name}-inference.lock'), encoding='utf-8', newline='\n')
    report = {'source_repository': source_repository, 'source_revision': SOURCE_REV,
              'archive_sha256': hashlib.sha256(data).hexdigest(), 'runtime': '1.3.0',
              'defaults': {'context': 16384, 'max_new_tokens': 128, 'thinking': False},
              'context_range': {'min': 512, 'max': 16384,
                                'basis': 'Pinned RKLLM model max_context_limit=16384'},
              'changes': ['16K default context bounded by the pinned model limit; configurable output', 'Optional text-only mode',
                          'Use embedded Qwen3.5 chat template so enable_thinking is respected',
                          'UTF-8/EOF handling', 'Callback synchronization and error propagation',
                          'Correct RKNN output release count', 'App-local runtime libraries'],
              'files': {p.relative_to(BUNDLE).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in BUNDLE.rglob('*') if p.is_file() and p.name != 'source-manifest.json'}}
    (BUNDLE / 'source-manifest.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('Bundle ready:', BUNDLE)


if __name__ == '__main__':
    main()
