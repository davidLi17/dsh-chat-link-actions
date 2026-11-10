> **Windows 自用 Fork：26.11.10-lhg** — 系统分享、发送到服务、Windows 工作流与安全应用打开。安装及具体操作见 [Windows 说明](./WINDOWS.md)。下方保留上游说明，其中 macOS 服务/快捷指令名称不能直接移植到 Windows。

# dsh-chat-link-actions

## DSH 0.2.2-rc.1 兼容性

`26.11.10-lhg` 已对照官方源码 `66491b05`，通过官方 CLI 隔离安装、真实 Web 宿主与客户端资源组合检查。HTTP 实测保留 cookie 鉴权、跨来源拒绝、方法限制、路径拒绝与配置读取；Windows 分享、SendTo、工作流及安全边界未改。

```bash
DSH_CLI=/path/to/@deepseek-ai/dsh/lib/bin.js node scripts/check-dsh-host.mjs /path/to/dsh-chat-link-actions-26.11.10-lhg.tgz
```

当前 Linux 回归 115 项通过、4 项 Windows/PowerShell 测试跳过。沙箱内 Chromium 因 socket 权限无法启动，未宣称桌面菜单视觉、真实系统分享或收件人送达已验证。脚本只操作临时 HOME，不启动应用或分享文件。

**对话里的附件和路径，右键就是你自己的入口。** 发给微信好友、用谷歌浏览器打开，或者你想到的任何处理——一个右键，做你想做的任何事。

<p align="center">
  <img src="https://raw.githubusercontent.com/regrevia/dsh-chat-link-actions/main/assets/context-menu.png" width="360" alt="对话里右键文件路径，弹出菜单：引用到对话、在文件管理器中查看、复制路径、发送到…、用 WPS 打开、自定义入口…">
</p>

<p align="center"><sub>右键菜单：引用回输入框、定位文件、复制路径、发送到…，以及你自己加的入口</sub></p>

长任务跑完，记录里一串路径和附件；想引用回去得手打，想在文件管理器里找到又是另一回事，想发给别人还得先记住文件在哪。这个插件把这些都收进同一个右键：菜单由 App 自己画，跟着深浅色和圆角走，不是系统弹窗。

## 默认预设

装上就有的四项：

| 右键文件链接 | 做什么 |
| --- | --- |
| **引用到对话** | 插成输入框里的引用芯片（`(</> 文件名)`），和拖文件、`@` 选文件的结果一样 |
| **在文件管理器中查看** | 打开所在目录并选中这个文件；macOS 是访达、Windows 是资源管理器、Linux 是文件管理器，菜单文字三端一致 |
| **复制路径** | 绝对路径进剪贴板，直接粘给别的窗口 |
| **发送到…** | 弹系统选择框，你在里面挑要发去的 App：微信、隔空投送、邮件，装了什么就有什么 |

## 自定义配置

菜单最下面能加自己的条目，保存后立刻出现；每条自己决定给谁看：

- **通用**：所有文件和链接都出现。
- **限定到一类**：只在那类文件上出现。视频（mp4/mkv/mov…）、音频、图片、文档、压缩包、代码各算一类，同一个入口管一整类，不用按后缀一条条配。

两种入口都在同一个编辑器里：右键任意文件点「自定义入口…」配通用入口，右键一个视频点「新增视频入口…」直接配只对视频生效的。编辑器里也列出本机能用的一键项（发送到…、已装的 App、快捷指令），点一下就是一条，不用自己敲。

清单存在 `~/.dsh/chat-link-actions/custom-actions.json`，也可以用命令行配：

```sh
dsh-chat-link-actions add --label 发到微信好友 --kind share
dsh-chat-link-actions add --label 用谷歌浏览器打开 --kind app --value "Google Chrome"
dsh-chat-link-actions add --label 用 VLC 打开 --kind app --value VLC --scope video
dsh-chat-link-actions list
dsh-chat-link-actions protocol   # 全部类型、占位符、类别、HTTP 路由
```

`--scope` 不写就是通用（`all`），旧清单里的条目也按通用算。

脚本类的入口分两种：`shell` 走默认 shell，`powershell` / `pwsh` 走 PowerShell 5.1 / 7+。占位符在 PowerShell 里是单引号字面量，含 `$`、空格、中文、逗号的路径都不需要自己转义。

协议细节见 [PROTOCOL.md](PROTOCOL.md)。

## 认哪些链接

右键不是只认一种写法，常见渲染都走同一条解析：`href` / `src` 里的 `?path=`（图片、附件卡片）、`data-path` 之类的绝对路径属性、`title` 里的路径（宿主自绘的文件链接、文件夹链接）、以及直接写在正文里的绝对路径（光标落在路径上才算），包括代码块里的 `file.cjs#L12`、`#L12-L20` 这类带行号的写法（行号不进路径）。只显示「图标 + 文件名」、DOM 里没有路径的芯片（图片链接、Markdown 图片）也能认：路径从渲染它的组件属性里取。Windows 的 `C:\...`、`C:/...`、UNC 共享路径、含空格与中文的路径同样能认；正文里带空格的路径整条引用，芯片写作 `@"…"`。网页链接和 `./` 开头的相对路径不当成本机文件；明确本地来源的 `~`、`~/...` 或 `~\...` 路径在取得宿主用户目录后展开，目录尚未就绪时不会猜测路径；正文里单独一个词（`/help` 这类斜杠命令）不弹菜单，带扩展名或带层级的路径才算。目录链接插入后是文件夹芯片（名字以 `/` 收尾），即使链接末尾没有斜杠。

## 安装自用 Fork

DSH 桌面版请在插件管理的 Git 来源输入：

```text
github:davidLi17/dsh-chat-link-actions#main
```

安装后确认版本为 `26.11.10-lhg`。仅用包名会解析到 npm 上游，不能保证包含本 Fork 的 Windows 分享、SendTo 和本地工作流适配；本 Fork 不发布 npm 安装包。完整的 Windows 操作和限制见 [Windows 说明](./WINDOWS.md)。

使用官方 DSH CLI 管理 web 配置时，命令为：

```sh
dsh plugin --profile web add github:davidLi17/dsh-chat-link-actions#main
```

桌面版的 desktop 配置由桌面应用管理，不要把上面的 web 命令当成桌面版安装步骤。包内已包含可直接运行的 JavaScript 和 Windows helper，无需单独编译或移动 `.tgz`。

## 用

鼠标停在对话里的文件链接或附件上，右键。菜单跟着 App 的深浅色和圆角走；Esc 或点别处关掉。

点下菜单之后，如果你又改了输入框或换了会话，插入会停下来不覆盖已写的内容——重新右键一次即可。

芯片由宿主渲染：图和视频进的是附件，文件夹显示成 `文件夹名/`，其他文件按扩展名走同一个芯片。

## 让 agent 帮你配

用户不用自己写 JSON。把要求说给 agent，它按 [AGENTS.md](AGENTS.md) 的协议用三条命令写完；写完最多 5 秒菜单自己跟上，不用刷新页面：

```sh
node <插件目录>/cli.js detect        # 本机有哪些 App、快捷指令，拿现成的 value
node <插件目录>/cli.js apply --json '[{"label":"用谷歌浏览器打开","kind":"app","value":"Google Chrome"}]'
node <插件目录>/cli.js list          # 确认
```

用户怎么说，对应哪种配置：

| 用户说 | kind | value |
| --- | --- | --- |
| 「用 WPS 打开」「用 VS Code 看」 | `app` | App 名字或 `.app` 路径 |
| 「发送到…」「发给别人」「发给微信好友」 | `share` | 空字符串（弹系统面板，用户在面板里挑） |
| 「压缩」「转 PNG」「传到服务器」 | `shell` | 命令模板，占位符 `{path}` `{dir}` `{name}` `{url}` |
| 「用 PowerShell 处理一下」 | `powershell` / `pwsh` | PowerShell 脚本（5.1 / 7+） |
| 「跑某个快捷指令」 | `shortcut` | 快捷指令名字（仅 macOS） |
| 「用某 App 的协议打开」 | `url` | 带占位符的链接 |

一次配 1–3 条，菜单堆满反而难用；`label` 用用户自己的话（「用 WPS 打开」，不要「入口A」）。
