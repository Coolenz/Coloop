# 2026-11-05 实机测试前云端请求检查

用户要求先排查重复云端请求，再进行受预算约束的实机测试。下面的预检与回归使用假 provider；后续真实请求另外记录在文末。

## 已修复

1. Harness 的 `/v1/chat/completions` 本地连接断开后，原逻辑仍消费上游流。现将客户端断开绑定到上游取消信号，并取消流读取。
2. 原代理没有模型请求单飞约束。现旧请求实际收尾前拒绝重叠请求，不产生第二次上游调用；包括上游暂时忽略取消的情况。
3. 同一任务反复调用 `coloop_consult`、使用相同 kind 和已批准 facts 时，原逻辑会重新请求。现按摘要缓存本任务的结果或终止失败，返回结果复制件，不重复开启重试预算。原有 429/5xx 最多三次尝试仍保留，失败缓存避免下一次相同工具调用再来三次。事实或咨询类型实际改变才建立新请求。

## 已核对的触发与预算

- 被动观察建议仅调用 RK，无自动云端回退。
- OpenAI Browser/TARS 客户端与 Harness SDK 都关闭隐式重试。
- Stagehand、CloudGateway、任务推理共用 ModelUsageLedger；浏览器抽取与分析共享原任务预算。
- 标题服务未注册标题模型提供者，不自动额外发起推理。Harness 压缩有界并经过计量。
- 生产配置原先未设置 modelLimits，因此默认累计 token / 日请求预算不启用。不能把默认存在的字段误认为已强制执行。
- 每个 COLOOP_DATA_DIR 有独立账本；不是账号全局限额，不得切目录或清空账本重置本轮测试额度。

## 本轮测试约束

同批验收统一使用一个隔离 profile，先不放云密钥、强制 RK。启用云端前显式配置：

```json
{
  "usageBudgetEnabled": true,
  "maxRequestsPerTask": 6,
  "maxRequestsPerDay": 12,
  "maxTokenUnitsPerTask": 150000,
  "maxTokenUnitsPerDay": 300000,
  "maxOutputTokens": 2048,
  "minRequestIntervalMs": 2000,
  "maxNoProgressRequests": 4
}
```

无进展上限允许最小的 enable_tools → observe → click → verify 四轮，再要求实际核验证据；总调用上限仍为每任务六次。tokenUnits 在请求前按输入字节数加输出上限保守预留，完整收到服务商usage才对账，未知/中断保留预留；不等于账单精确token。未配置模型单价，不声称具有人民币费用硬限。

失败时保留同一账本和证据，不通过自动新建任务无限重试。测试分别记录请求数、实际usage或保守预留、Cua与RK输入通道；不能将脚本直接操作当作模型自主完成。

## 离线验证

- 新增 `cloud-budget-audit.test.ts` 三项真实SDK/假fetch测试：429和500各只发送一次；浏览器与CloudGateway共享额度，超额请求发网前被拒绝。
- Harness新增真实回环HTTP断开/并发/流取消测试。
- 咨询重复调用复用、修改返回对象不污染缓存、失败不重开重试预算测试通过。
- 最终 `harness-runtime`、`tars-agent`、`model-usage`、`cloud-budget-audit` 四个文件共144项通过；此前观察/预算/网页等六个文件179项回归通过。TypeScript两套配置通过。

这些结果证明所测路径的限制生效，不是所有运行环境都绝无重复调用的保证。最终云端实测须观察同一个profile的model-usage.jsonl，而不能只看任务界面完成状态。

## 本批真实请求与审计

统一 profile 为 `.qa/harness-live-rk-rk-checkbox-1793870978312/profile`。新增只读检查命令：

```powershell
node scripts/audit-model-usage.mjs .qa/harness-live-rk-rk-checkbox-1793870978312/profile
```

脚本比较持久账本与请求/回执日志，检查重复ID、未结算预留和每日/每任务一致性；不输出密钥、正文或原始任务ID。缺少账本/日志返回 inconclusive，不解释为零请求。退出码0为证据完整且在限额内，1为预算关闭或超限，2为证据不足或不一致。7项脚本测试通过。

同批实际运行的三个云端案例各4次请求，达到12次日上限后停止云测试，保留原账本：

- 第一次 Cua checkbox：前台实际是任务栏，三次相同观察后查询空工作区，无输入；无进展上限阻断。证据 `.qa/harness-live-cloud-cua-checkbox-1793873246269`。
- 第二次 Cua checkbox：修正测试窗口准备，并在派任务前用实际 HWND/PID 断言前台。模型完成 observe → click → verify → final，fixture记录一次点击和checked=true。证据 `.qa/harness-live-cloud-cua-checkbox-1793873446022`。
- RK 原文替换：正文保护拒绝整区paste，模型用OCR大小写不准确的文本patch又失败，随后BACKSPACE清除了选区原文；任务被无进展上限阻断，不能计为成功。该结果由同批实机测试任务保留。

截至第三例结束，同批审计记录12个request和12个response，无重复或未结算，tokenUnits为100178，其中一次中断使用保守预留。未配置单价，不能将界面的estimatedCostYuan=0解释为免费。后续组件调试不调用云模型，也不重置本批额度。
