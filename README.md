# dsh-chat-link-actions（对话里的文件链接，右键就有动作）

**对话里的文件路径，右键就能引用回输入框，也能在文件管理器里直接定位。菜单是 App 自己画的，不是系统弹窗。**

长任务跑完，记录里一串路径；想引用回去得手打，想在文件管理器里找到又是另一回事。这个插件把右键菜单接到对话里的文件链接上。

## 四个动作

| 右键文件链接 | 做什么 |
| --- | --- |
| **引用到对话** | 插成输入框里的引用芯片（`(</> 文件名)`），和拖文件、`@` 选文件的结果一样 |
| **在文件管理器中查看** | 打开所在目录并选中这个文件；macOS 是访达、Windows 是资源管理器、Linux 是文件管理器，菜单文字三端一致 |
| **复制路径** | 绝对路径进剪贴板，直接粘给别的窗口 |
| **发送到…** | 弹系统选择框，你在里面挑要发去的 App：微信、隔空投送、邮件，装了什么就有什么 |

## 自定义入口

右键菜单最下面能加自己的条目，保存后立刻出现。一条一行：

```
发到微信 | 系统分享
截图存档 | 命令 = cp {path} ~/Pictures/inbox/
```

写「系统分享」就是弹同一个系统选择框，只是换个叫法好认；写「命令」「打开方式」「快捷指令」「链接」就直接执行那件事。编辑器里也列出本机能用的一键项（发送到…、已装的 App、快捷指令），点一下就是一行，不用自己敲。

清单存在 `~/.dsh/chat-link-actions/custom-actions.json`，也可以用命令行让 agent 配：

```sh
dsh-chat-link-actions add --label 发到微信 --kind share
dsh-chat-link-actions list
dsh-chat-link-actions protocol   # 全部类型、占位符、HTTP 路由
```

脚本类的入口分两种：`shell` 走默认 shell，`powershell` / `pwsh` 走 PowerShell 5.1 / 7+。占位符在 PowerShell 里是单引号字面量，含 `$`、空格、中文、逗号的路径都不需要自己转义。

协议细节见 [PROTOCOL.md](PROTOCOL.md)。

## Windows 节点与 CI

Windows 上的行为靠一台常开的 Windows 机器验，本机不用再备第二台开发机。

- **CI 两头都跑**：`ci.yml` 在 `ubuntu-latest` / `macos-latest` / `windows-2022` 上跑同一套测试，Windows 上另有 5.1 与 7 两遍 PowerShell 场景；`windows-node.yml` 用自托管 runner（标签 `self-hosted, Windows, X64`）在你自己的节点上跑同一套。
- **本机直连节点**：把连接信息写进 `~/.dsh/windows-node.json`（不进仓库），然后 `npm run win:info` 或 `npm run win:test` 就在节点上跑；`npm run win:pwsh -- 'Get-Item -LiteralPath {path}'` 临时试一段脚本。

```json
{ "host": "节点地址", "user": "登录名", "port": 22, "identityFile": "/Users/you/.ssh/id_ed25519", "workdir": "C:\\dev\\dsh-chat-link-actions" }
```

自托管 runner 注册（在节点上以管理员 PowerShell 执行，token 从仓库 Settings → Actions → Runners 取）：

```powershell
mkdir C:\actions-runner; cd C:\actions-runner
Invoke-WebRequest -Uri https://github.com/actions/runner/releases/latest/download/actions-runner-win-x64.zip -OutFile runner.zip
Expand-Archive runner.zip -DestinationPath .
.\config.cmd --url https://github.com/regrevia/dsh-chat-link-actions --token <TOKEN> --labels windows-node --unattended
.\run.cmd   # 或用 .\svc.cmd install 装成服务
```

SSH 只能验命令行；菜单、资源管理器定位、原生气泡这些要在 RDP 的桌面会话里看，别拿 SSH 退出码当窗口证据。

## 认哪些链接

右键不是只认一种写法，常见渲染都走同一条解析：`href` / `src` 里的 `?path=`（图片、附件卡片）、`data-path` 之类的绝对路径属性、`title` 里的路径（宿主自绘的文件链接、文件夹链接）、以及直接写在正文里的绝对路径（光标落在路径上才算），包括代码块里的 `file.cjs#L12`、`#L12-L20` 这类带行号的写法（行号不进路径）。只显示「图标 + 文件名」、DOM 里没有路径的芯片（图片链接、Markdown 图片）也能认：路径从渲染它的组件属性里取。Windows 的 `C:\...`、`C:/...`、UNC 共享路径、含空格与中文的路径同样能认；正文里带空格的路径整条引用，芯片写作 `@"…"`。网页链接、`~` 和 `./` 开头的相对路径不当成本机文件；正文里单独一个词（`/help` 这类斜杠命令）不弹菜单，带扩展名或带层级的路径才算。目录链接插入后是文件夹芯片（名字以 `/` 收尾），即使链接末尾没有斜杠。

## 装

```sh
dsh plugin install dsh-chat-link-actions
```

## 用

鼠标停在对话里的文件链接上，右键。菜单跟着 App 的深浅色和圆角走；Esc 或点别处关掉。

点下菜单之后，如果你又改了输入框或换了会话，插入会停下来不覆盖已写的内容——重新右键一次即可。

芯片由宿主渲染：图和视频进的是附件，文件夹显示成 `文件夹名/`，其他文件按扩展名走同一个芯片。

## 不做什么

- 只认本机存在的绝对路径：网络路径、已删掉的文件，会直接说找不到。
- 不上传、不打开编辑器；「在文件管理器中查看」只让系统文件管理器选中文件，不修改它。
- 不改对话内容：插入是一次正常的输入框编辑，可以撤销，也会进草稿。

## 给 agent 的话

要用户引用文件时，照常写绝对路径即可；用户可以用右键引用，不需要另换写法。

用户说「把这个发到某个 App」时，不用自己拼 `open -a`：`dsh-chat-link-actions add --label 名称 --kind share` 加一条，右键里点它就会弹系统选择框，让用户自己挑。
