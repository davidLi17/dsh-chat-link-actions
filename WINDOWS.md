# Windows 自用版：26.10.31-lhg

基于 regrevia/dsh-chat-link-actions 0.6.13（`0e045e2801ad310d70f5a1d3ce9e96b3d2af4f6d`），保留 MIT 许可证和 macOS 实现。另选择性吸收上游 0.6.14（`90bd5607f1da1c8fe60c7a2eeaba1ad2839b8251`）的波浪号路径与诊断修复，属于功能等价吸收。

| 操作 | Windows 对应实现 |
| --- | --- |
| 系统分享 | Windows 原生分享面板。选择目标应用与接收人仍由你完成 |
| 指定分享服务 | Windows「发送到」目录中的应用快捷方式 |
| 快捷指令 | 本机 PowerShell `.ps1` 或应用 `.lnk` 工作流，文件作为输入 |
| 指定应用打开 | 使用 Windows ProcessStartInfo 启动，保留中文、空格、引号、`%` 等，不经过 cmd 拼接 |
| 文件定位、复制路径、引用、网页链接 | 保留原有实现 |

## 安装

在 DSH 插件管理的 Git 来源输入：

```
github:davidLi17/dsh-chat-link-actions#main
```

包内直接包含 JavaScript 和 Windows helper，不需要下载或移动 `.tgz`，无需另外编译。安装后确认版本为 `26.10.31-lhg`。此处不是 npm 发布。

## 系统分享

在文件上右键选「发送到…」。插件创建一个小型 DSH 分享窗口，并打开 Windows 系统分享面板。窗口关闭或最长 5 分钟后辅助进程退出；回到 DSH 点击也会关闭它。

需要 Windows 桌面交互会话和系统自带 Windows PowerShell 5.1。系统管理员的受限语言/应用控制可能阻止 Windows API helper，此时会报错，不修改执行策略。

面板只显示 Windows 注册的分享目标。安装了微信并不等于该版本微信提供 Windows 分享目标；插件不会自动选联系人或代发消息。未提供分享目标的应用，可使用下方「发送到」/工作流，是否接受文件由应用决定。macOS 隔空投送不在 Windows 提供同名功能；使用 Windows 分享面板中本机支持的近距离共享等目标。

## 配置「发送到」

1. 按 `Win+R`，输入 `shell:sendto` 并回车。
2. 把支持“文件路径参数”的应用快捷方式放进去，例如一个指向编辑器 `.exe` 的 `.lnk`。
3. 回到插件的配置/检测入口，选择「发送到：名称.lnk」。也可配置 `kind=service`，`value` 填该完整文件名。

保留快捷方式原有参数与工作目录，将选中文件作为末尾参数。为防止路径被当命令解释，只接受应用 `.exe`，拒绝 cmd/PowerShell 等命令解释器快捷方式；脚本请使用下面的工作流。系统的“压缩文件夹”特殊 `.ZFSendToTarget` 不当作 `.lnk` 冒充支持。

## 配置文件工作流

目录：`%USERPROFILE%\.dsh\chat-link-actions\shortcuts`，没有就创建。放入 `.ps1` 或应用 `.lnk`。配置 `kind=shortcut`，`value` 填完整文件名，例如 `查看文件.ps1`。

一个不改动文件的脚本示例：

```powershell
param([string]$Path)
Get-Item -LiteralPath $Path | Format-List FullName,Length,LastWriteTime
```

PowerShell 通过 `-File` 接收选中文件参数，遵守本机脚本执行策略/签名要求。不会添加 `ExecutionPolicy Bypass`；若被组织策略阻止，请使用已允许的签名脚本或应用入口。后台工作流“已启动”不表示后续处理已完成。macOS 快捷指令需自行改成对应 Windows 脚本，不能直接执行苹果快捷指令名称。

## 验证

`npm run check`、`npm test`、`npm pack --dry-run`。既有 GitHub Actions 覆盖 Node 20、Linux/macOS/Windows，Windows 回归使用无敏感内容本地临时文件，分享 self-check 不弹分享 UI、不发送文件。交互式 Windows 11 DSH 内分享与真实第三方目标仍需本机验收，不把 API 自检冒充真实收件成功。

Windows Server 2022 原生回归：107 项全部通过、0 跳过，PowerShell 5.1 / 7 各额外 9 项通过；Linux/macOS 条件检查通过。原生辅助代码只使用系统自带 .NET / WinRT 元数据，无需 Windows SDK。CI 记录：https://github.com/davidLi17/dsh-chat-link-actions/actions/runs/41180863972 。
