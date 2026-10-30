# 给 agent 的配置协议

这个插件往 DSH 对话里的文件链接上加了一个右键菜单。用户可以自己决定菜单里有哪些入口。
你的活：听他说要哪种操作，把它配成一条入口，写完就好。

## 三条命令就够

```bash
node <plugin>/cli.js detect          # 本机有哪些 App / 快捷指令，拿现成的 value
node <plugin>/cli.js apply --json '[{"label":"用 WPS 打开","kind":"app","value":"WPS"}]'
node <plugin>/cli.js list            # 确认
```

`<plugin>` 是插件目录，通常 `~/.dsh/profiles/desktop/node_modules/dsh-chat-link-actions`。
一次 `apply` 可以写多条；同名 `label` 覆盖，重跑安全。

## 按用户说法选 kind

| 用户说 | kind | value |
| --- | --- | --- |
| 「用 WPS 打开」「用 VS Code 看」 | `app` | App 名字或 `.app` 路径；Windows 用 exe 路径 |
| 「发送到…」「发给别人」「分享」 | `share` | 空字符串（弹系统面板，用户在面板里挑） |
| 「压缩」「转 PNG」「传到服务器」 | `shell` | 命令模板，占位符 `{path}` `{dir}` `{name}` `{url}` |
| 「用 PowerShell 处理一下」 | `powershell` | PowerShell 脚本，Windows PowerShell 5.1 跑 |
| 「用 PowerShell 7 / pwsh」 | `pwsh` | 同一份脚本，PowerShell 7+ 跑 |
| 「存到手机」「用某 App 的协议打开」 | `url` | 带占位符的链接 |
| 「跑某个快捷指令」 | `shortcut` | macOS 快捷指令名；Windows shortcuts 目录中的 .ps1/.lnk 文件名 |

## 入口给谁看（scope）

用户说「只对视频/图片/文档…生效」时加 `scope`；不说就是通用 `all`。
可用值：`all`、`video`、`audio`、`image`、`document`、`archive`、`code`——按文件类别，一类管一批后缀（mkv 和 mp4 都是 `video`）。

```bash
node <plugin>/cli.js add --label 用 VLC 打开 --kind app --value VLC --scope video
node <plugin>/cli.js apply --json '[{"label":"用 VLC 打开","kind":"app","value":"VLC","scope":"video"}]'
```

## 约束

- `label` ≤ 40 字，`value` ≤ 400 字，总条目 ≤ 20；超了写入被拒绝并发错，不会截断。
- `label` 写用户会照着他自己的话认出来的动词短语：「用 WPS 打开」，不要写「app1」「入口A」。
- `share` 的 `value` 必须是空字符串。
- `shell` 里不要硬编码路径，用占位符。
- `powershell` / `pwsh` 的占位符会变成单引号字面量（`$` 不展开），脚本里不用再自己加引号。
- 拿不准节点上是 5.1 还是 7 就写 `powershell`；两个都要支持就配两条，脚本内容一样。
- 一次配 1–3 条。菜单是给人快速点的，堆满反而难用。
- 不认识的 `kind` 会被当成 `shell`，别依赖这个兜底。
- 不认识的 `scope` 会被当成 `all`；认不出的后缀只给 `all` 的入口，不要为单个后缀另配一条。
- 写完不要说「请重启」「请刷新页面」——界面最多 5 秒自己跟上。

## 完整字段与错误码

`node <plugin>/cli.js protocol` 输出机器可读的那份（存储路径、上限、每种 kind 的语义、HTTP 路由、错误码）。
人也读得懂的版本在同目录 `PROTOCOL.md`。

## Windows 自用版

- `share` 弹 Windows 系统分享面板，由用户选目标；不保证微信等桌面应用注册为系统分享目标，不自动选联系人。
- `service` 使用 `%APPDATA%\Microsoft\Windows\SendTo` 中的 `.lnk` 完整文件名；用 `detect` 读取实际可用项。
- `shortcut` 使用 `~/.dsh/chat-link-actions/shortcuts` 中的 `.ps1` / `.lnk` 完整文件名。PowerShell 脚本第一个参数是文件路径，不修改 ExecutionPolicy。
- 不复制 macOS 快捷指令名称到 Windows；先配置对应 Windows 脚本或快捷方式。
