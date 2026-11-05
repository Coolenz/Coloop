# DSH 生态适配评估

2026-11-06。通过 GitHub 检索 DSH 生态，阅读原仓库 README、package.json 和 Engram 的 src/index.ts。以下是兼容性评估，不是插件已安装声明。

Coloop 锁定 DSH SDK/CLI 0.2.1-rc.5、独立标准 Node 24，只开放受控 coloop 工具。插件不能绕过授权、预算或私密记忆边界。

| 候选                                                                                                                      | 价值                                             | 本轮决定                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [dsh-engram](https://github.com/kenz1117/dsh-engram)，package 0.11.5                                                      | 本地 SQLite、中文 FTS5、向量融合、来源、项目隔离 | 最值得后续适配检索层。源码注册 23 工具并注入画像，包含摄取/反思/辅助模型及 Web 面板，引入 transformers；Node 相容不代表授权与隐私相容。本轮不直接挂载，不迁移原库。 |
| [dsh-dream](https://github.com/STARDUSTLC666/dsh-dream)，0.13.9                                                           | 候选经验、审阅、来源与冲突                       | 声明 DSH >=0.2.1-rc.3，覆盖当前版本；依赖 DSH Web 设置/侧栏与更新插件，Coloop 不运行该 UI。采用证据与候选分开的原则，不启用额外模型提炼。                           |
| [dsh-soul](https://github.com/icyaaaww/dsh-soul)，package 2.0.0                                                           | 记忆骨架、压缩后召回、配对验收与预算审计         | 声明 Node >=24、DSH 0.2.x；README 仍含较早演化流程，与 manifest 2.0.0 定位不同。需要固定提交、专项恢复回归，不直接替换当前压缩器。                                  |
| [官方 checkpoint](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session/session-checkpoint-policy) | 派发前 checkpoint 与持久化                       | 已接入，继续复用宿主 intent/result 账本，不加第二推理循环。                                                                                                         |

发现入口：[Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。依据为原仓库而非索引宣传；未运行第三方安装脚本，未用浮动 latest 升级依赖。

记忆结论：保留 RK 原库、worker、QA namespace 和本地路由检查。DSH 默认画像注入可能把私密事实交给云端，不能为了生态兼容牺牲该边界。后续 Engram 适配先只开放现有 catalog/get，禁用画像注入、ingest、reflect、辅助 LLM；独立目标库核对中文检索、来源、去重、删除、重启、local→remote 拒绝后再决定切换。当前没有证明其在 RK 上优于原系统的同题实测，故本轮不进行不可逆迁移。

实际落地：宿主缺价拒绝、累计费用上限及服务端持久冷却，覆盖 Harness、Stagehand 和咨询共享出口，无需依赖第三方插件自律。
