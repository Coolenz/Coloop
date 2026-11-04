# 输入结果核验与恢复

## 开源参考

- Browser Use 的工具结果：动作返回 extracted_content/error，反馈给下一轮规划；仅 is_done 明确结束任务。https://docs.browser-use.com/open-source/customize/tools/response
- UI-TARS SDK 的 screenshot/execute Operator：可适配现有执行器，循环读取屏幕、执行并反馈。https://github.com/bytedance/UI-TARS-desktop/blob/main/docs/sdk.md
- Playwright actionability 与自动重试断言：在状态满足后推进动作，对可观察结果轮询核验。https://playwright.dev/docs/actionability

本次借鉴以上架构思路，使用 Coloop 现有 RK USB HID、OCR、UIA 执行适配；没有引入或声称集成完整 Browser Use / UI-TARS 依赖。

## 实现

1. 核验失败时保留原始文本和选区基线。核验成功后消费基线；不重新粘贴。
2. UnknownInput 携带原动作、观察、输入完成状态和动作回执。
3. 输入已完整发送，或键盘中性报告已确认释放按键后，重新读取当前观察。
4. 粘贴使用原控件、原文本、原选区的 UIA 插入核验；鼠标/快捷键优先核对目标控件状态或之前未出现的预期可见文本。
5. 最多三轮只读核验。正面证据确认效果后更新原回执并继续规划，不重放原动作。
6. 没有充分证据时保留 unknown 和任务上下文，才请求用户确认。OCR 缺少一段文字不能证明粘贴未发生，不能据此自动补发。
7. 停止信号在恢复前和每次观察、核验、输入释放前生效。

## 验证边界

新增回归覆盖：粘贴延迟后自动确认、不重复输入、原基线跨失焦保留、未知按键状态不能仅凭文本解除、确认中性报告后继续、无证据时保持 unknown、恢复中取消。相关 Python 和 TypeScript 测试通过；新恢复路径尚需真实 RK 部分输入故障注入验收。

开源框架也不能保证任意外部应用的每个副作用都可判定；目标是自动解决可核验情况，并明确保留真正不确定的写入状态。
