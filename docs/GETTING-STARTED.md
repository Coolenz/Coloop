# 首次配置

以下命令以仓库根目录为当前目录。仓库中的 `RK` 是独立运行工作区；不要复制旧机器的虚拟环境。

## Windows 本地 OCR

安装 Python 3.12 后，在 PowerShell 中执行：

```powershell
py -3.12 -m venv RK/deployment/screen-ocr/.venv
& ./RK/deployment/screen-ocr/.venv/Scripts/python.exe -m pip install -r RK/requirements-screen-ocr.lock.txt
& ./RK/deployment/screen-ocr/.venv/Scripts/python.exe RK/tools/prepare_screen_ocr.py
& ./RK/deployment/screen-ocr/.venv/Scripts/python.exe RK/tools/smoke_screen_ocr.py
```

首次准备需要联网，实际 OCR 使用本地文件。模型生成在 `RK/deployment/screen-ocr/models/`，校验来源见 [OCR manifest](model-manifests/ocr.json)。这部分文件被 Git 忽略。

启动 Coloop 后，在「模型连接」底部将 RK 项目路径设置为当前克隆的 `RK` 目录的绝对路径。默认 `D:/RK` 仅为原开发机示例，需要手动更新。

## 开发板身份与主机环境

```powershell
py -3.12 -m venv RK/.venv
& ./RK/.venv/Scripts/python.exe -m pip install -r RK/requirements-host.lock.txt
Copy-Item RK/config/board.example.json RK/config/board.json
```

编辑 `board.json` 中的真实地址、用户、工程目录和通过可信渠道核对的 SSH SHA256 指纹。Coloop 源码默认值使用文档示例地址 `192.0.2.2` 和全 A 示例指纹，必须导入自己的配置。连接密码由界面或终端临时输入，配置模板中没有密码。

`ssh_config` / `known_hosts` 也需按自己的设备配置；Python 部署工具使用 `board.json` 的指纹校验。不要关闭主机身份验证。

## 已部署服务与首次部署

若板端已有兼容服务，Coloop 可直接导入配置并访问它。默认目录 `~/rk-opencode`，端口 `8088`；界面的启动按钮只启动已经部署的服务。

首次部署请先阅读 [4B 部署说明](../RK/docs/11-qwen35-4b.md) 和 [模型服务说明](../RK/rk-opencode/README.md)。脚本以下列目录结构运行：

```text
Windows clone/RK/rk-opencode/host.py
Windows clone/RK/config/board.json
板端 ~/rk-edge-ai/qwen35-4b/     权重、匹配头文件与应用私有运行库
板端 ~/rk-opencode/              HTTP 桥接和 worker
```

4B 下载工具是 `RK/tools/prepare_qwen35_4b.py`；部署工具是 `RK/tools/deploy_qwen35_4b.py`，其 `--stage dependencies` 会安装依赖，`--stage runtime` 会上传、构建应用，默认 `all` 会执行完整部署。模型服务部署使用 `RK/rk-opencode/host.py`，先运行 `--help` 检查实际命令。板端操作使用进程环境变量 `RK_BOARD_PASSWORD`，结束后清除变量。

不要同时运行多个板端大模型任务；开始前检查驻留模型和资源。模型、运行库、环境、内核和 USB 配置应按专题说明分别准备，克隆源码不会自动部署设备。

## 应用构建

```powershell
cd Coloop
npm ci
npm run typecheck
npm test
npm run build
npm run dev
# 可选：生成本机 Windows portable 程序
npm run package:win
```

默认 CI 运行应用单元测试、格式检查、构建和 Windows 打包，不访问开发板或云端账户。真实 OCR/USB/NPU 的端到端验证需本地环境，见 [应用验收记录](../Coloop/docs/verification.md)。
