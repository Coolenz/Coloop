---
name: Coloop
description: 石墨黑导航、白色任务工作区与浅灰设备栏组成的 Windows 桌面工作台。
colors:
  canvas: '#ffffff'
  surface: '#ffffff'
  sidebar: '#202124'
  ink: '#26282c'
  muted: '#666666'
  subtle: '#707070'
  line: '#e3e3e3'
  accent: '#202124'
  accent-soft: '#eeeeee'
  green: '#333333'
  red: '#333333'
  inspector: '#f7f7f7'
  accent-hover: '#383c43'
  context: '#f0f0f0'
  selected-surface: '#f6f6f6'
typography:
  wordmark:
    fontFamily: 'Sora, sans-serif'
    fontSize: '25px'
    fontWeight: 650
    lineHeight: 1
    letterSpacing: '-0.9px'
  headline:
    fontFamily: "'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', sans-serif"
    fontSize: '27px'
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: '-0.6px'
  composer-title:
    fontFamily: "'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', sans-serif"
    fontSize: '21px'
    fontWeight: 600
    letterSpacing: '-0.4px'
  title:
    fontFamily: "'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', sans-serif"
    fontSize: '16px'
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', sans-serif"
    fontSize: '13px'
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', sans-serif"
    fontSize: '12px'
    fontWeight: 500
    lineHeight: 1.6
  mono:
    fontFamily: 'Consolas, monospace'
    fontSize: '11px'
rounded:
  label: '6px'
  control: '10px'
  panel: '18px'
  container: '16px'
  provider: '14px'
  composer: '20px'
spacing:
  '1': '4px'
  '2': '8px'
  '3': '12px'
  '4': '16px'
  '6': '24px'
  '8': '32px'
components:
  button-primary:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.surface}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: '8px 14px'
  button-primary-hover:
    backgroundColor: '{colors.accent-hover}'
  button-secondary:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.green}'
    rounded: '{rounded.control}'
    typography: '{typography.label}'
    padding: '8px 14px'
  input:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '8px 12px'
  panel:
    backgroundColor: '{colors.surface}'
    rounded: '{rounded.container}'
  context-chip:
    backgroundColor: '{colors.context}'
    textColor: '{colors.muted}'
    rounded: '{rounded.label}'
    padding: '6px 8px'
  task-composer:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.composer}'
  navigation-selected:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.accent}'
    rounded: '{rounded.control}'
    padding: '10px 12px'
---

# Design System: Coloop

## Overview

**Creative North Star: "连接回路"**

0.6.0 采用用户最新确认的黑白方向：石墨黑导航、白色任务工作区、浅灰设备栏。轻重不同的闭合圆弧是品牌的识别核心，界面通过圆角、线条轻重和留白延续同一语言，功能控件保持水平。

本规范从已实现的 `src/renderer/src/system.css`、React 组件与 `resources/brand.svg` 提取，覆盖此前蓝色界面与竖直标志的描述。七个页面共享文字、状态和控件体系；Agent 协调沿用同一灰阶语言，以状态、数据路径和审计列表组织内容。产品的设备、OCR、模型及任务行为以实际实现为准。

**Key Characteristics:**

- 石墨黑导航以白底黑字明确标示当前页面。
- 白色内容与浅灰设备栏通过细边界和留白分层。
- 黑色主操作、灰阶反馈与清楚的状态文字。
- 倾斜双闭合半圆、水平功能控件与紧凑快捷操作行。

## Colors

主深色使用近中性的石墨黑 #202124；抬升表面 #2b2e33、悬停 #383c43、边界 #484c53。通过表面亮度区分层级，避免纯黑导航的生硬感。

### Primary

石墨黑（`accent`）用于主操作、链接与输入光标；悬停使用深灰（`accent-hover`）。当前导航反白显示，内容中的选中服务采用浅灰表面与深色边框。

### Neutral

纯白（`canvas` / `surface`）承载工作区和字段；石墨黑（`sidebar`）承载导航；浅灰（`inspector`）承载连接信息。正文（`ink`）、辅助文字（`muted`）、占位文字（`subtle`）与细边界（`line`）形成可读层级。上下文标签使用 `context`，其颜色不同于 `accent-soft`。

源码保留 `green` / `red` 语义变量名，但当前两者均为深灰。连接、成功、失败与运行状态依靠文字和图标区分，不增加彩色状态体系。

**The Monochrome Rule.** 新页面沿用黑白与灰阶；连接、错误和运行状态同时提供明确文字或图标。

## Typography

Sora Variable 随应用本地分发，只用于 Coloop 字标。功能文字使用前置 tokens 中的 Windows 字体栈；Consolas 用于设备指纹等需要逐字核对的信息。字标在黑色导航中为白色，其余位置采用正文色。

页面主标题对应 `headline`，区域标题对应 `title`；正文对应 `body`，常规按钮对应 `label`。任务输入标题对应 `composer-title`，紧凑桌面（≤1240px）降至（18px）。任务输入正文采用（14px，行高 1.8）；辅助说明通常为（11px）。设备信息与状态栏采用等宽数字对齐。

**The Wordmark Rule.** Sora 保留给字标；新增功能标题和操作标签沿用 Windows 文字栈。

## Layout

Electron 最小窗口为（1060 × 720px）。默认导航（212px）、连接侧栏（276px）；中央内容弹性伸缩并独立滚动。顶栏高（56px），底栏高（28px）。默认页面内边距（32px）；工作台最大宽（1040px），一般页面最大宽（1280px），设置页最大宽（1152px）。连接侧栏用于工作台与工作流页面。

间距使用前置 spacing tokens。任务输入是工作台视觉核心，快捷操作采用三条紧凑列表行：左侧线条图标、中间标题和说明、右侧标记及箭头，下方细分隔线。历史同样以行和分隔线组织。

紧凑桌面（≤1240px）导航缩为（192px）、连接侧栏缩为（248px）、页面边距降为（24px）。连接侧栏在（≤1120px）隐藏，工作台最大宽改为（900px）；此宽度下工作台最终边距仍为（24px），由后置紧凑规则决定。大桌面（≥1550px）两栏为（216 / 296px），页面边距（40px），输入文本区高度（160px）。

源码另有防御性适配：在（≤1050px）工作台最大宽（880px）、边距（32px），OCR 改为单列；在（≤760px）导航收成（64px）图标栏，页面边距（24px 20px）、表单和服务列表改为单列。它们不改变当前 Windows 桌面产品边界。长设置页与紧凑窗口内容允许纵向滚动。

## Elevation & Depth

常驻内容主要依靠表面明度、细边界和间距分层；任务输入、设置容器与选中服务保持平面。提示消息使用投影（`0 8px 32px #3333331a`），模态框使用投影（`0 24px 100px #23232324`）。模态背板为半透明灰（`#2828284d`），背景模糊（3px）。

**The Surface Rule.** 常驻内容用表面与边界表达层级，浮层才使用对应投影。

## Shapes

圆弧语言通过控件、导航与面板的圆角表达：常规按钮与字段使用 `control`，标签使用 `label`，一般设置容器使用 `container`，服务卡使用 `provider`，任务输入和模态框使用 `composer`。`panel` 是通用面板 token，当前用于提示消息。快捷操作行、历史空态与设备栏分段保持平直边界。

品牌源为 `resources/brand.svg`：石墨黑圆角底、白色对称双闭合半圆，整体绕中心倾斜（−35°）。每段圆弧由直边闭合，外弧名义厚度（9.5）、直边（7.3），在（128 单位）网格内保留平滑肩部与柔和内接角；右半圆由镜像生成。连续填充轮廓表达轻重变化。界面标志、反白版、PNG 与 ICO 均从同源几何生成。

## Components

### Buttons

主按钮黑底白字，悬停为深灰；次按钮白底、细灰边框与深灰文字，悬停浅灰。常规按钮最小高度（36px）；图标按钮点击区域（36 × 36px）。禁用按钮不透明度（0.45）；运行按钮独立使用浅灰底与灰字，保留不透明度（1）。设备栏按钮默认白底黑字，悬停反白。

通用键盘焦点为灰色外描边（3px solid #666666，偏移 2px）。按钮背景与边框过渡为（0.12s）。

### Inputs / Fields

常规字段白底、细边框、控件圆角，最小高度（40px）；设置表单字段采用近白底（#fbfbfb）。标签可见，辅助说明置于下方。任务输入标题绑定文本区；容器聚焦时边框变黑，文本区保留向内的灰色焦点描边（2px solid #666，偏移 −4px），不增加额外光晕。OCR 编辑区同样保留单一向内焦点描边。

### Navigation

黑底导航的普通项使用灰字，悬停深灰底、白字；当前项白底、黑字、较粗字重，并设置 `aria-current="page"`。每项最小高度（42px），图标（17px）与文字同行，使用控件圆角。

### Chips / Status

上下文标签使用浅灰填充，可移除；屏幕上下文开关通过深边框、灰底和文字表达开启状态。连接标签包含圆点和文字；任务状态明确写出完成、运行、失败或取消。灰阶状态始终与真实数据一致。

### Cards / Containers

设置容器纯白、细灰边界，无投影。选中服务卡为浅灰底、深边框与勾选图标。快捷操作采用列表行，悬停浅灰；历史任务行以细分隔线连接。硬件图为灰阶设备连接示意，不代表某一具体板卡版本；OCR 文字框采用灰色描边、淡灰填充与中心点，展示识别区域而非按钮边界。

### Task Composer / Connection Map

任务输入、可移除上下文和底部操作栏共用一个圆角边界。输入区默认高度（100px），最小（90px），最大（300px），允许纵向调整；操作栏浅灰底、高度至少（66px），运行按钮位于右侧。空输入、提交中或已有运行任务时禁用运行按钮。

设备连接图使用本机、Coloop、RK 三节点：节点（42px），本机路径为实线，设备路径为虚线并随连接状态变化。功能图标使用线条 SVG。运行指示线性旋转（1s）；减少动态效果偏好下关闭过渡，动画缩为一次极短执行。

## Do's and Don'ts

### 顶部控制提示

控制提示沿用石墨黑 #202124、白色主文字与灰色辅助文字，使用独立的系统置顶窗口，按整个主显示器 `screen.bounds` 固定在屏幕顶部中央，距屏幕顶端约 8 DIP；不嵌入或跟随主窗口，主窗口移动、缩小或最小化不影响提示。按用户最新要求收窄至最大 373 × 76 DIP（原宽 560 的约 2/3），内容条高 60px、圆角 14px。品牌文字仅保留「Coloop」，不显示 OpenCode、项目名或工作区；状态、按钮、提示及辅助标签全部使用英文。正常状态为「Controlling your computer」，白底深字「Stop」为主要操作。默认宽度保留计时，仅 ≤330px 时隐藏计时。仅预览允许关闭，副文为「Preview · No actions running」；实际控制持续到源端确认结束。不抢焦点，不使用脉冲或装饰性颜色。

### Do:

- **Do** 复用石墨黑导航、白色工作区与浅灰设备栏。
- **Do** 保留倾斜双闭合半圆与轻重不同的轮廓，使用同源 SVG 生成品牌资产。
- **Do** 保留 Windows 功能字体、可见标签和清楚的键盘焦点。
- **Do** 使用紧凑列表行组织快捷操作，并让状态文字对应真实数据。

### Don't:

- **Don't** 将此前蓝色界面或竖直标志偏好覆盖到 0.6.0。
- **Don't** 倾斜按钮、字段或其他功能控件。
- **Don't** 将 Sora 扩展为功能正文或表单字体。
- **Don't** 给常驻内容添加浮层投影，或用颜色替代状态文字。
