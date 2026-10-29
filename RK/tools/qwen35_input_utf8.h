#ifndef QWEN35_INPUT_UTF8_H
#define QWEN35_INPUT_UTF8_H

#include <cstdint>
#include <string>

// Reject malformed sequences before the RKLLM tokenizer can throw.
inline bool valid_utf8_input(const std::string& text)
{
    for (std::size_t i = 0; i < text.size();) {
        const auto lead = static_cast<unsigned char>(text[i++]);
        if (lead < 0x80) {
            if (lead == 0) return false;  // C string API would truncate at NUL.
            continue;
        }
        unsigned int extra;
        std::uint32_t codepoint;
        std::uint32_t minimum;
        if (lead >= 0xc2 && lead <= 0xdf) {
            extra = 1; codepoint = lead & 0x1f; minimum = 0x80;
        } else if (lead >= 0xe0 && lead <= 0xef) {
            extra = 2; codepoint = lead & 0x0f; minimum = 0x800;
        } else if (lead >= 0xf0 && lead <= 0xf4) {
            extra = 3; codepoint = lead & 0x07; minimum = 0x10000;
        } else {
            return false;
        }
        if (extra > text.size() - i) return false;
        for (unsigned int n = 0; n < extra; ++n) {
            const auto next = static_cast<unsigned char>(text[i++]);
            if ((next & 0xc0) != 0x80) return false;
            codepoint = (codepoint << 6) | (next & 0x3f);
        }
        if (codepoint < minimum || codepoint > 0x10ffff ||
            (codepoint >= 0xd800 && codepoint <= 0xdfff)) return false;
    }
    return true;
}

#endif
