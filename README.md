# dsh-chat-link-actions

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

菜单最下面能加自己的条目，保存后立刻出现。一条一行，左边是你想要的叫法，右边是它实际做的事：

```
发到微信好友 | 系统分享
用谷歌浏览器打开 | 打开方式 = Google Chrome
用 VS Code 看 | 打开方式 = Visual Studio Code
截图存档 | 命令 = cp {path} ~/Pictures/inbox/
用 PowerShell 转个格式 | powershell = Add-Type -AssemblyName System.Drawing; …
```

写「系统分享」就是弹同一个系统选择框，只是换个叫法好认；写「命令」「打开方式」「快捷指令」「链接」就直接执行那件事。编辑器里也列出本机能用的一键项（发送到…、已装的 App、快捷指令），点一下就是一行，不用自己敲。

清单存在 `~/.dsh/chat-link-actions/custom-actions.json`，也可以用命令行配：

```sh
dsh-chat-link-actions add --label 发到微信好友 --kind share
dsh-chat-link-actions add --label 用谷歌浏览器打开 --kind app --value "Google Chrome"
dsh-chat-link-actions list
dsh-chat-link-actions protocol   # 全部类型、占位符、HTTP 路由
```

脚本类的入口分两种：`shell` 走默认 shell，`powershell` / `pwsh` 走 PowerShell 5.1 / 7+。占位符在 PowerShell 里是单引号字面量，含 `$`、空格、中文、逗号的路径都不需要自己转义。

协议细节见 [PROTOCOL.md](PROTOCOL.md)。

## 认哪些链接

右键不是只认一种写法，常见渲染都走同一条解析：`href` / `src` 里的 `?path=`（图片、附件卡片）、`data-path` 之类的绝对路径属性、`title` 里的路径（宿主自绘的文件链接、文件夹链接）、以及直接写在正文里的绝对路径（光标落在路径上才算），包括代码块里的 `file.cjs#L12`、`#L12-L20` 这类带行号的写法（行号不进路径）。只显示「图标 + 文件名」、DOM 里没有路径的芯片（图片链接、Markdown 图片）也能认：路径从渲染它的组件属性里取。Windows 的 `C:\...`、`C:/...`、UNC 共享路径、含空格与中文的路径同样能认；正文里带空格的路径整条引用，芯片写作 `@"…"`。网页链接、`~` 和 `./` 开头的相对路径不当成本机文件；正文里单独一个词（`/help` 这类斜杠命令）不弹菜单，带扩展名或带层级的路径才算。目录链接插入后是文件夹芯片（名字以 `/` 收尾），即使链接末尾没有斜杠。

## 装

```sh
dsh plugin install dsh-chat-link-actions
```

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
