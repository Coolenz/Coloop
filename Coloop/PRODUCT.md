# Coloop

<!-- impeccable:product-schema 1 -->

## Platform

web

Electron 桌面应用，运行于 Windows；React 前端通过隔离的 preload API 连接本机服务。

## Product Purpose

连接 RK 设备，在本机识别屏幕文字，再通过云端或端侧模型理解内容。名称保持 Coloop。

## Capabilities and Constraints

六个页面：工作台、屏幕理解、工作流、模型连接、设备管理、运行历史。保留文字任务、流式回答、取消、OCR 坐标编辑、模型配置、设备连接与历史导出等已有行为。设备健康信息以实际返回值为准；没有 HID 跨应用操控能力。

## Operating Context

本机 OCR；云端任务发送相关文本；API Key 使用 Windows 加密存储。桌面窗口最小 1060 × 720。

## Brand Commitments

用户当前确认的方向（0.6.1）：名称保持 Coloop；使用黑白双闭合半圆标志，保留外弧略厚、竖边较轻与平滑连接处，整体恢复倾斜。前端按同一风格统一为石墨黑导航、白色任务区、浅灰设备栏与灰阶控件。

两片之间保持对称关系，不恢复被否定的独立错位、反向旋转或尖角处理。此前蓝色 UI 与竖直 Logo 的偏好已被最新明确要求覆盖。六个页面、工作流、数据行为与实际设备状态保留。设计演变见 docs/verification.md。

## Users

根据 README 与已有界面推断：在 Windows 上使用 RK 智能设备、处理屏幕信息的用户。更具体的用户画像尚未确认。

## Evidence on Hand

README.md、docs/architecture.md、现有六个页面与 tests/e2e.mjs。不存在可用于声称设备已连接或模型已配置的演示数据。

用户要求缓和纯黑，当前使用 #202124 石墨黑，辅以炭灰悬停与抬升表面；Logo 几何和界面布局保持。
