# 对外协议

菜单里的每条入口都是一行 JSON。人和 agent 写同一个文件，写完立即生效，不用重启。

```json
{ "version": 1, "actions": [ { "label": "发送到微信", "kind": "service", "value": "发送到微信" } ] }
```

文件：`~/.dsh/chat-link-actions/actions.json`
上限：20 条；`label` 40 字；`value` 400 字。

## 入口类型

| kind | value 写什么 | 交出去的方式 |
| --- | --- | --- |
| `service` | 原生分享服务的标题，例如 `发送到微信` | 直接把文件交给那个 App 的分享扩展，不弹面板（macOS） |
| `share` | 空 | 弹系统分享面板，让用户在里面选（macOS） |
| `app` | App 名称，例如 `Preview`；Windows 写 exe 路径 | 用这个 App 打开文件 |
| `shortcut` | 快捷指令名称 | 用文件当输入跑一遍快捷指令（macOS） |
| `url` | 带占位符的链接，例如 `mi://send?p={path}` | 替换占位符并编码后打开链接，交给注册了该协议的 App |
| `shell` | 命令行模板，例如 `scp {path} phone:/tmp/` | 跑这条命令 |

占位符：`{path}` 文件绝对路径、`{dir}` 所在目录、`{name}` 文件名、`{url}` 引用链接。`shell` 里会被正确加引号，`url` 里会被百分号编码。

## 先看本机有什么

```bash
node ~/.dsh/profiles/desktop/node_modules/dsh-chat-link-actions/cli.js detect
```

返回 `[{ "label": "发送到微信", "kind": "service", "value": "发送到微信" }]` 这样的清单，加进去就行：

```bash
node <plugin>/cli.js add --label 发送到微信 --kind service --value 发送到微信
node <plugin>/cli.js add --label 存到手机 --kind shortcut --value 存到手机
node <plugin>/cli.js add --label 发送到小米手机 --kind url --value 'mi://send?p={path}'
node <plugin>/cli.js list
node <plugin>/cli.js remove 发送到微信
node <plugin>/cli.js run 发送到微信 --path /tmp/a.png
```

`actions-run` 的请求体带 `{"label":"","kind":"share","path":"/abs/file"}` 时，不必先存清单，直接弹系统选择框。

## HTTP

同一个插件进程还开着一组接口，前缀 `/chat-link-actions`，只接受 DSH 页面发起的请求（外部用上面的 CLI 或直接改文件）。

`POST /chat-link-actions?action=…`

- `protocol` → 这份约定的机器可读版
- `actions-get` → `{ actions }`
- `actions-detect` → `{ targets }`
- `actions-add` body `{ actions: entry[], replace?: boolean }` → 按 `label` 合并，同名的替换
- `actions-remove` body `{ labels: string[] }`
- `actions-save` body `{ actions: entry[] }` → 整份替换
- `actions-run` body `{ label, path?, url? }`

其余 action 是菜单自己的：`reveal`、`trace`。
