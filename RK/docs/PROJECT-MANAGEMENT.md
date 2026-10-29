# 项目管理：代码用 Git，大文件单独保存

这个项目目前采用本地 Git 管理版本，目录为 `D:\RK`，主分支为 `main`。
以后需要换电脑、备份或协作时，再连接你自己的私有 GitHub/Gitee 仓库。
本次初始化没有上传文件，也没有建立云端仓库。

## 直接打开图形界面

在项目文件夹中双击 **打开Git管理.cmd**，会打开 Git Gui 并自动进入这个仓库。
窗口标题应显示 `Git Gui (RK) D:/RK`，顶部当前分支为 `main`。
`.git` 是隐藏的数据目录，日常不需要进入或修改它。

1. 左上 **Unstaged Changes**：尚未加入本次提交的修改，点击文件可在右侧查看差异。
2. 点 **Stage Changed** 将修改加入本次提交；只提交部分文件时，可点击对应文件左侧的小图标暂存。
3. 在 **Commit Message** 中写清这次做了什么，点 **Commit** 保存本地版本。
4. 通过 **Repository → Visualize All Branch History** 查看历史版本。

**Rescan** 用于刷新文件状态；**Push** 用于向已配置的远程仓库上传，目前还没有配置远程仓库。
想在 PowerShell 中直接打开，同样可以运行 `git -C D:\RK gui`。

## 哪些东西放在哪里

| 内容 | 保存方式 |
|---|---|
| Python、PowerShell、Bash、CMake、启动入口 | Git，记录修改并可以找回旧版本 |
| 依赖清单、配置模板、使用说明 | Git，方便重建环境 |
| 系统镜像、WSL 虚拟磁盘、下载资料 | 保留原目录，独立备份，不提交 Git |
| ONNX、RKNN、RKLLM、GGUF 等模型和数据集 | 保留本机文件，用来源、版本和 SHA256 记录对应关系 |
| 板子实际 IP、SSH 配置、密钥、环境变量文件 | 本机配置，Git 忽略；仓库保留配置示例 |
| 实验结果 | 将重要结论整理成文档提交；原始运行日志留在 logs |

Git 忽略的文件仍在电脑上，并没有删除。克隆代码不能自动恢复这些文件。
WSL 和 Python 环境可按脚本重建；不能重新下载的模型、数据和资料应单独备份。
本地 Git 也不等于异地备份，电脑磁盘损坏仍会丢失本地仓库。

## 每次完成一件事，保存一个版本

在 PowerShell 中：

```powershell
cd D:\RK
git status
git diff
```

确认本次修改后，只添加相关文件，再提交。例如：

```powershell
git add scripts/board.ps1 docs/START-HERE.md
git diff --cached
git commit -m "fix: improve board connection instructions"
```

`commit` 是在本机保存一份版本记录，不会上传。
一次提交尽量对应一件事，例如“增加摄像头采集”“修复模型预处理”，不要攒很多不相关修改。
VS Code 的“源代码管理”面板也可以查看差异、暂存和提交。

## 新功能用分支试验

```powershell
git switch -c feat/camera
```

在这个分支修改、测试、提交。功能验证通过且工作区已保存后：

```powershell
git switch main
git merge feat/camera
```

现在一个人开发不需要复杂的多层分支流程。保持 main 可用，大功能单独试验即可。

## 找回旧代码

查看已有版本和某个版本的文件，不会改变当前代码：

```powershell
git log --oneline --decorate -10
git show baseline-2026-10-28:README.md
```

如果某次修改需要撤销，先查看 `git status`、保存尚未提交的工作，再选择恢复方法。
已经提交的改动通常用 `git revert 提交编号` 创建一条反向修改记录。

## 给模型和实验留记录

记录模型来源、上游版本、文件 SHA256、转换工具版本、预处理方法和验证结果。
模型索引见 [models/README.md](../models/README.md)，实验记录模板见 [设备与实验记录](06-device-record.md)。

查询文件摘要：

```powershell
Get-FileHash models\your_model.rknn -Algorithm SHA256
```

以后如果确实需要协同管理大模型版本，再选择 Git LFS 或专门的模型存储；当前先保留可重建来源和摘要。

## 备份与远程仓库

后续可建立私有远程仓库，关联后用 `git push` 上传代码历史。
首次上传前确认 `.gitignore` 和待上传文件列表；忽略目录仍需另外备份。
也可先导出本地代码历史：

```powershell
New-Item -ItemType Directory -Force backups
git bundle create backups\rk-code.bundle --all
git bundle verify backups\rk-code.bundle
```

将 bundle 复制到其他磁盘才有独立备份意义；它只包含已提交的代码历史，不包含模型、资料或本机配置。
重复导出同名 bundle 会覆盖之前的备份，保留多次备份时使用不同文件名。

## 提交作者

首次提交沿用电脑已有 Git 作者配置，不修改全局设置。
查看或仅为这个项目修改作者：

```powershell
git config user.name
git config user.email
git config --local user.name "你的名字"
git config --local user.email "你的邮箱"
```

这会影响后续提交；已有提交的作者不会自动改变。

参考：[Git 官方版本控制说明](https://git-scm.com/book/en/v2/Getting-Started-About-Version-Control)、[Git LFS](https://git-lfs.com/)。
