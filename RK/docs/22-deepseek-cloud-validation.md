# 真实 DeepSeek 云端验证（2026-10-30）

本轮使用用户已保存的真实 DeepSeek 账户，调用官方 `https://api.deepseek.com`、模型 ID `deepseek-flash`。与[上一轮云协议回环](21-coloop-cloud-cooperation.md)分开记录；本次没有固定云答案，也没有把合法 JSON 当作内容正确。

## 最终结果

| 验证 | 原始证据 | 结果 |
|---|---|---|
| 两道公开合成云题 | `logs/coloop-deepseek-direct-20261030134347/` | 两题内容及严格JSON均通过，HTTP 200、finish_reason=stop |
| 真实 RK → DeepSeek → RK | `logs/coloop-deepseek-full-20261030140918/` | 简单／复杂题均通过，关键源事实保真通过，退出0 |
| 主机软件检查 | `logs/coloop-deepseek-verification-20261030-141149/` | 492项全工作树测试、类型检查、构建及打包版9项桌面回归通过 |

独立云题为：

1. **装箱计算**：18批、每批24件，取走137件，余量每7件装箱。真实答案为 `FULL_BOXES=42;REMAINDER=1`，与程序独立计算的432−137=295、295=7×42+1一致。
2. **两工位排程**：A耗时3、B耗时2可从0开始；C耗时4依赖A；D耗时2依赖A和B；E耗时1依赖C和D。真实答案为 `MIN_DURATION=8`。人工核对模型步骤：A 0–3、B 0–2、C 3–7、D 3–5、E 7–8，依赖与工位上限成立，达到关键路径A–C–E的8时长下界。原文及独立见证在结果文件，人工核对另存 `manual-semantic-review.json`。

完整协作仍使用原合成A/B题及随机项目代号、随机测试密码：A初期投入低但维护负担高，B初期投入适中但维护负担低。最终出境 `facts` 逐字保留这两个条件，只有不透明实体占位符，没有原代号、密码、映射或完整本地请求。测试出口额外逐字核验这两个条件，缺失就报 `TEST_SOURCE_FACTS_LOST` 并阻断真实发送，不能由测试补全请求。

DeepSeek真实结论为：B长期维护更轻，但不能仅凭现有信息判定综合最优，需要量化投入、上线风险及回退路径。RK本地答案保留了该条件结论和精确原项目名，没有回填密码。人工复核另存该轮 `manual-semantic-review.json`。

简单题约8.40秒、零云请求；复杂题约76.88秒，含一次真实本地格式重生。共8次真实RK调用、1次真实DeepSeek请求，自有租约残留0，连接正常关闭，没有停止或重启其他任务的共享服务。业务名在确定性标题与模型正文中重复，原样保留。样例耗时不是SLA。

## 本轮修正

- **DeepSeek推理／返回预算**：原通用512 token同时被内部思考占用，出现 `finish_reason=length`；关闭思考的实验又出现装箱算错。最终仅对官方DeepSeek两个已知模型开启低强度思考，预算2048 tokens，显式请求 `json_object`；返回提示保持250字以内，原有4096字节分析／32768字节HTTP硬上限、完整stop及字段校验继续执行。其他端点／模型仍沿用通用512 token参数。依据[官方接口](https://api-docs.deepseek.com/api/create-chat-completion/)与[JSON Output说明](https://api-docs.deepseek.com/guides/json_mode/)，JSON语法保证不替代本地schema和内容验收。
- **源事实保真**：旧RK自由摘要丢失A/B具体条件，虽隐私与传输通过，实际分析任务未完成。改为主机将掩码原文分句，RK只返回严格 `[{"id":"S..."}]` 选择结果，主机按源顺序逐字摘录 `facts`，再做隐私与条件完整性复核。未知／重复ID、额外正文、旧字符串数组、超预算一律拒绝，不修补模型输出、不补造事实。实现为 `D:\Coloop\src\main\domain\cloud-spans.ts`。
- **已运行板端接口兼容**：另一任务将板端升级为worker protocol 3，曾临时运行 `validation-alt-4b`。本轮只读预检拒绝该配置；待其恢复默认4B后，增加对运行中默认 `qwen35-4b` / embedded / 16K以内 / 指纹及输出能力明确 / metadata-only的protocol 3校验，保留protocol 2兼容。没有接纳任意验证模型或8B，也没有修改／重启板端服务、权重或Runtime。旧启动脚本的protocol 2路径未在本轮改写，实际验证使用已运行的protocol 3服务。

## 失败同样保留

| 原始目录 | 事实与判断 |
|---|---|
| `coloop-deepseek-direct-20261030133826` | 装箱正确；排程512 token中491用于推理，JSON截断，失败 |
| `coloop-deepseek-direct-20261030133933` | 关闭思考后排程仍长篇自我修正并截断，失败 |
| `coloop-deepseek-direct-20261030134129` | 合法短JSON却把295÷7算成43余0，内容失败 |
| `coloop-deepseek-direct-20261030134234` | 低强度推理后排程数值正确，但steps有空字符串，严格拒绝 |
| `coloop-deepseek-full-20261030134424` | 板端正运行临时验证profile，连接预检拒绝，零云请求 |
| `coloop-deepseek-full-20261030135119` | 本地识别阶段请求失败，零云请求；原始保护错误留档，未当作云端质量结论 |
| `coloop-deepseek-full-20261030135347` | 原自动传输／隐私条件通过，但人工发现RK摘要漏掉A/B属性，另存语义失败复核，不改写原summary |
| `coloop-deepseek-full-20261030140257` | 新选择器返回空数组，被拒绝，零云请求 |
| `coloop-deepseek-full-20261030140528` | 选中S1/S2但返回对象数组，与当时字符串协议不符，拒绝；随后正式采用唯一严格id对象协议，不修补旧结果 |

最终采用两道独立云题通过目录和完整链路通过目录。各轮提示与协议有所变化，以上是工程调试记录，不可据此计算固定配置成功率。所有保留运行共11次实际DeepSeek请求，API返回usage合计7506 tokens（包含推理）；不是账单或费用对账。

## 密钥、范围与交付

测试只读应用保存的provider和加密密钥，通过原profile的Electron safeStorage在主进程内存解密；没有实例化AppStore或持久化用户历史，网络使用独立非持久session。请求日志不记录Authorization或API Key；接口错误正文丢弃，响应仅对成功且有大小限制的合成数据留档。通过运行的 `configuration-integrity.json` 确认state.json与Local State未改写，未导出密钥材料。

本轮只使用公开或随机合成资料。显式私密标记和已知凭据规则经过验证，未标注业务隐私的普遍自动识别、任意复杂问题质量、多轮完整会话及实际跨应用/HID操作仍不在本轮验收范围。RK资料选择仍可能遗漏条件，源绑定避免“改写／新增事实”，不能证明语义选择永远正确；本次固定A/B条件由独立出口断言及人工复核覆盖。

可复现入口位于 `D:\Coloop\tests\deepseek-live.mjs`、`deepseek-live-worker.mjs`，不被Vitest自动执行；`--phase=direct` 最多2次实际云请求，`--phase=full` 最多1次实际云请求，需要本进程的板端密码环境。失败不自动重发云端，重试输出仅限已定义的一次本地最终格式重生。运行这些入口会使用真实账户。

新构建为 `D:\Coloop\release\deepseek-validated-0.12.0\win-unpacked\Coloop.exe`，`D:\Coloop\start.cmd` 优先启动该目录。未覆盖已安装程序或关闭其现有进程；使用前需从托盘退出旧版，以免单实例机制只激活旧窗口。构建内容逐个匹配冻结out文件，关键源码与真实RK通过轮次匹配。并行任务在构建后修改了 `mobile-remote.css`，该项未回滚；本次交付绑定已验证快照，不冒充后续UI改动已验证。
