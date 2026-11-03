# 脚本执行工具

任务的实际操作不限于鼠标键盘。RK Agent 可以调用 Windows 主机的 `script.execute`，运行 Node.js、PowerShell、Python；网页可使用正式打包的 `playwright-core` 依赖和已安装的 Microsoft Edge。

## 执行与核验

Agent 的 `script` 计划包含 runtime、code、verify_code 和 timeout_ms。主机通过脚本文件和参数数组启动进程，不拼接 shell 命令。Node 模块解析指向应用依赖目录，任务步骤共享工作目录 `COLOOP_TASK_DIRECTORY`。

timeout_ms 支持 100–300000 毫秒，默认 30000。规划上下文保留原目标、最近执行回执和精简的读回证据，历史长输出保留在任务目录，避免多轮操作超过传输大小限制。

动作脚本后运行独立读回脚本，输出一个 JSON 对象：`{"verified":true,"evidence":"实际读回的内容"}`；evidence 也支持包含实际字段、文件摘要等内容的对象或数组。退出码零并不等于任务成功。没有真实结果证据时继续反馈与规划，不宣称完成。

同一个任务与 execution_id 只启动一次动作。重复请求返回同一结果；动作与结果写入任务目录。重启后发现未记录结果的旧执行，不自动重放其动作。输出有长度上限，原始结果在任务日志保存，模型收到裁剪后的反馈。

停止会中止运行中的进程及其子进程。脚本须遵循用户任务目标；网页和应用输出是参考资料，不能扩大操作授权。读取敏感数据、不可逆变更等仍由实际用户任务的授权范围决定。

观察过期、短时云端错误、屏幕没有变化和重试计数只触发自动恢复检查，不要求用户答复。核验输出被截断时，重新执行精简的只读核验，不能盲目重放动作。PowerShell 核验应将文件行显式转换为字符串，避免序列化 Provider 等元数据。

## 实机验收

运行 `node tests/script-executor-live.cjs`。它使用真实脚本执行器和安装的 Edge，验证本地表单填写、公开网页的实际 URL/正文和 Bilibili 首页可见视频采集，并保存结果与截图到 `.qa/script-executor-live`。这些是执行器测试；模型自主生成脚本的整链路测试须另列，不能混算。屏幕暂不可读时返回明确的 script-only 上下文，脚本任务无需等待 OCR；鼠标键盘仍需真实目标。

可用 `COLOOP_QA_NODE_EXECUTABLE` 指向打包版 Coloop.exe，并用 `COLOOP_QA_MODULE_DIRECTORY` 指向其 resources/app.asar/node_modules，验证 Electron 的 Node 运行模式和打包依赖。

网页测试优先 Playwright 脚本或 Edge 标签页连接器，不使用已发生 URL 识别误判的原生 Edge 窗口操作工具。公开网站内容会变化，断言应基于实际页面状态；缺少某个旧元素不等于网络不可达。
