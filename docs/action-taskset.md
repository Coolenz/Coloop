# Cloud-direct / RK USB 动作任务集

2026-11-03，Asia/Shanghai。此任务集扩展已通过的中文追加和tag记忆闭环，覆盖鼠标动作、跨字段编辑及撤销/重做。**六类均取得真实独立判据通过，来自两轮：suite01的two_fields＋修复后suite02的五项复测。** suite01五个失败原样保留，不称单次6/6。共30次真实云调用，所有case本地模型调用0、translate=0，剪贴板均恢复；revision需要多轮纠正，非一次规划成功。

## 执行方式与证据边界

每个case启动一个新的独立`ActionTaskLab`进程与窗口，用唯一标题、PID、HWND和独立输出目录绑定观察及执行范围；上一case结束并退出后才启动下一case。实验窗只接收`output_dir task_id unique_title`，不接收目标动作、模型结果或驱动的状态写入。`tests/ActionTaskLab.cs`从真实Windows控件事件和原生状态原子写入`identity.json`、`state.json`，作为独立判据。

驱动仅负责启动、提供用户目标、等待、只读采集和关闭自身实验窗。规划必须真实调用云端，由RK纯程序校验后通过原生USB执行；上位机只观察/守卫，不使用`SendInput`、软件点击、写控件值、直接修改实验窗状态等替代路径。Qwen不作动作转换，所有case要求translate调用数为0。直接任务无需触发被动建议；若无需classify，本地模型调用可以为0。

主Agent的完成判断与独立实验窗判据分别记录。生产非paste完成判断使用严格同窗口的新鲜OCR观察及动作后出现的成功标记；动作前就存在的marker不能算新完成证据，不能只根据`input_sent`或云端“完成”声明通过。独立fixture判据仍必须另行通过。严格目标校验失败、取消、结果未知均保留失败记录；不自动重放未知输入，也不修改实验窗判据来迁就输出。

## 六类任务计划表

| Case / 新窗口 | 用户目标与初始状态 | 覆盖动作 | 预期结果 | 独立状态JSON判据 | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| `checkbox` | 初始未勾选`Enable feature`，点击一次启用，不切换其他控件。 | `click` | 可见`Feature enabled`，复选框true。 | `checked=true`；相对执行前基线有该控件真实mouse_down/up、click及checked_changed=true；不出现随后反向关闭。结合RK动作组确认是mouse click，不能只用键盘切换。 | suite01失败、0USB；suite02独立PASS |
| `double_click` | 对列表第一项`Double click target`完成一次双击。 | `double_click` | 可见`Double click verified`且计数1。 | `doubleclick_count`相对基线加1，真实`mouse_double_click`事件的control为double_click_item；两次按下/释放的原生事件存在。不用普通click计数推断双击，因为Windows事件语义可能不同。 | suite01失败、0USB；suite02独立PASS |
| `hover` | 指针初始在目标外，移入`Hover target`，不点击。 | `move` | 可见`Hover verified`，鼠标按下仍为0。 | `mouse_enter_count`相对基线增加；`mouse_down_count`、`mouse_up_count`、`click_count`保持基线；RK执行动作是move。MouseHover可额外记录，但不以等待系统hover超时替代实际移入判据。 | suite01失败、0USB；suite02独立PASS |
| `scroll` | 文档初始在TOP_MARKER，向下滚动到BOTTOM_MARKER。 | `scroll`（必要时move定位） | `Bottom reached`，真实底部标记可见。 | `scroll.bottom_visible=true`、`top_visible=false`、`first_visible_line>0`且`native_scroll_count`相对基线增加；原生滚轮/滚动事件存在。不得用CTRL+END冒充scroll覆盖。 | suite01失败、0USB；suite02独立PASS |
| `two_fields` | A初始`项目：Coloop / 计划：旧版本 / 备注：保留这一行`；B初始`收件人：测试团队 / 状态：待更新`。明确要求分别替换两字段全文为`订单甲-731`、`项目乙-842`。 | 两个独立目标的`click`、`hotkey`、`paste`；字段间重新定位 | A全文为`订单甲-731`，B全文为`项目乙-842`。本case是明确全文替换，不要求保留初始行。 | `fields.a`、`fields.b`分别与manifest期望全文比较（仅规范化CRLF/LF）；两个不同control各有真实text_changed，最终内容不得相互串写；selection和输入事件辅助定位。 | suite01独立通过；suite02不重复计入 |
| `replace_undo_redo` | Revision editor初始全文`Original revision`。替换全文为`Revision Beta 中文`，撤销回原文，再重做到替换文字。 | `hotkey`选择/撤销/重做、`paste` | 最终为`Revision Beta 中文`，中间确实恢复过`Original revision`。 | `fields.revision`最终等于新全文；事件时间序列依次出现新文→原文→新文，且存在CTRL+Z/CTRL+Y相关undo/redo key事件。只看最终新文不能证明撤销和重做发生。 | suite01失败；suite02多轮纠正后独立PASS |

## 结果记录约定

实际驱动为`tests/action-taskset-live.mjs`及`tests/action-taskset-live-worker.mjs`，任务定义`tests/action-taskset.json`；启动前设置`COLOOP_ACTION_OUTPUT`为新的唯一输出目录。已核对源码及suite01实际文件：suite级`manifest.json`、`results.json`、`cloud.json`，各case目录记录identity、初末fixture、观察、events、input、clipboard及result；实验窗自身另写`state.json`。manifest固定源码/fixture/driver/capture/taskset摘要、所选case及云调用预算。本套上限40次云调用、每case最多8次；所有运行使用新目录，不覆盖先前结果。

suite manifest至少记录route=`cloud_actions_rk_usb`、实验窗源码及RK脚本摘要、观察模式、六个case的目标和完整预期文本、执行顺序。每个case保留独立PID/HWND、开始前/结束后实验窗状态、Agent事件与回执、云调用/动作组、本地模型调用阶段及实测耗时；涉及paste保留租约回执与恢复判断，不保存原剪贴板正文。记录云错误时避免包含Key。

| Run / Case | 固定证据目录 | Agent终态 | 独立业务判据 | 云调用/动作组 | 本地classify / translate | USB已发送动作 | 剪贴板恢复 | 耗时与计时范围 | 结果/失败原因 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 / checkbox | `D:/RK/logs/coloop-action-taskset-20261103-01/checkbox/` | failed | 未勾选/无鼠标事件 | 1 / 0已发送组 | 0 / 0 | 0 | true | 4.867秒，case准备→终态及判据读取 | FAIL invalid_cloud_text |
| 01 / double_click | 同suite `double_click/` | failed | 无双击/无按下释放 | 1 / 0 | 0 / 0 | 0 | true | 4.205秒 | FAIL invalid_cloud_text |
| 01 / hover | 同suite `hover/` | failed | 无新移入 | 1 / 0 | 0 / 0 | 0 | true | 3.649秒 | FAIL invalid_cloud_text |
| 01 / scroll | 同suite `scroll/` | failed | 未到底/无滚动事件 | 1 / 0 | 0 / 0 | 0 | true | 7.179秒 | FAIL invalid_cloud_text |
| 01 / two_fields | 同suite `two_fields/` | completed | A/B全文分别正确，独立passed | 4 / 2 | 0 / 0 | click2、hotkey2、paste2 | true | 16.246秒 | PASS |
| 01 / replace_undo_redo | 同suite `replace_undo_redo/` | failed | 仅新文，缺Undo/Redo与三阶段序列 | 2 / 1 | 0 / 0 | hotkey CTRL+A1、paste1 | true | 9.463秒 | FAIL invalid_cloud_text，非0输入失败 |
| 02 / checkbox | `D:/RK/logs/coloop-action-taskset-20261103-02/checkbox/` | completed | checked=true，按下/释放各1 | 3 / 1 | 0 / 0 | click1 | true | 13.347秒 | PASS |
| 02 / double_click | 同suite `double_click/` | completed | 双击1，按下/释放各2 | 3 / 1 | 0 / 0 | double_click1 | true | 12.539秒 | PASS |
| 02 / hover | 同suite `hover/` | completed | mouse_enter=1，按下/释放0 | 3 / 1 | 0 / 0 | move1 | true | 10.655秒 | PASS |
| 02 / scroll | 同suite `scroll/` | completed | first_visible_line=82，last=101/102行，bottom=true；原生滚动事件4 | 3 / 1 | 0 / 0 | scroll1，steps=-32 | true | 22.006秒 | PASS |
| 02 / replace_undo_redo | 同suite `replace_undo_redo/` | completed | 真实text事件新文→原文→新文及Undo/Redo键；最终全文正确 | 8 / 7 | 0 / 0 | click3、hotkey7、paste2，共12动作 | true | 43.707秒 | PASS业务，memorySaved=false |

### suite01结果与修复后的重跑

固定结果`D:/RK/logs/coloop-action-taskset-20261103-01/results.json`：整套ok=false，1/6通过，10次真实云调用。所有case无本地模型调用、translate=0；没有input_unknown。总已发送动作覆盖click2、hotkey3、paste3，其中revision的hotkey/paste来自失败case，只能计为实际发生的动作，不能计为撤销/重做任务通过。

此表`elapsed_ms`沿driver实际口径：在启动该case实验窗前取单调时钟，至终态后的独立状态、动作与剪贴板检查结束，不含后续finally关闭实验窗；包括fixture/通道准备，不能当纯推理或纯USB耗时。

五项失败共用协议原因：云端为不含paste的动作计划返回`text:""`，旧程序将空字符串当invalid_cloud_text拒绝。checkbox/double_click/hover/scroll在任何USB发送之前被拒；revision首次替换已实际发出，后续CTRL+Z计划因空text被拒，所以不能写成全部五项0USB，也不能宣称已覆盖撤销/重做。

root已修正仅在动作组不含paste时将空text视为缺省，含paste仍按原文要求严格校验；当时35项行为单元测试通过。suite02使用新RK源码摘要、新窗口和独立目录仅重跑五个失败项，不覆盖suite01或重用fixture。**suite02五项全部独立通过；完整覆盖必须表述为“suite01通过two_fields＋suite02五项复测”，不是单次六项全通过。**

### 最终覆盖与限制

suite02固定结果`D:/RK/logs/coloop-action-taskset-20261103-02/results.json`为ok=true，20次云调用；与suite01的10次合计30次。汇总`D:/RK/logs/coloop-action-taskset-20261103-summary.json`明确列出两个source_runs、六项通过与五项历史失败。全部case本地模型调用为0，没有unknown输入重放，结束后释放前台与剪贴板租约。

revision实际经过7个动作组/12个动作、8次云调用纠正；独立事件确实出现替换、撤销、重做序列，但不是一次规划无误。该case实际付费8次正好触及per-case上限，第9个REVIEW cloud_transport请求在网络wrapper发出前被预算拒绝，因此业务已核验完成但memorySaved=false，未重做业务；不是云模型主动选择放弃保存。hover及two_fields的复盘返回nothing reusable，没有新增记忆；不能写所有case都保存记忆成功。checkbox、double_click、scroll的memorySaved=true只表示本轮QA隔离记忆写入。

本次生产观察扩展严格只读Button/ListItem/RichEdit等目标适配和非编辑freshOCR完成核验；不含paste的空text兼容不放宽粘贴原文校验。最终603项Vitest、60项RK Python、类型检查与build通过；新独立构建`release/proactive-actions-0.13.0-20261103/`已生成，`start-proactive.cmd`已指向此目录，旧cloud-direct目录保留历史回退。新`verification.json`确认包main/RK/clipboard资源与编译/源文件一致，且最新suite02的Agent及capture摘要匹配；`.qa/proactive-package-1793673381605/report.json`隔离包启动smoke通过。首次切换需从托盘退出旧版再运行入口。

每case仅当Agent完成、独立业务判据通过、输入路线确认为RK原生USB且translate=0时计PASS；paste case还要求恢复剪贴板或明确记录用户主动更改后的保留行为。一个case多次尝试分开记录，首次失败不被后续通过覆盖。未生成或未执行的case是NOT_RUN，不能算失败或通过；真实尝试已开始但被前台守卫拒绝单列BLOCKED。

## 范围与解释

这是独立原生WinForms动作验收，不替代实际Notepad、浏览器、跨应用、多屏或物理手机验证；不能将一个控件适配的成功推广到所有Windows应用。撤销/重做特别依赖控件自身undo栈，不用测试代码直接调用Undo/Redo替代USB快捷键。

计时以各主机单调时钟为准，记录任务开始→终态及云端、观察、校验、USB、复盘收尾等阶段；包含关系不重复相加，失败耗时保留。六类任务目标不同，不汇总成统一速度SLA；与上轮中文追加任务不作固定倍数比较。
