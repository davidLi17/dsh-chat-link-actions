#!/usr/bin/env node
// 在常开的 Windows 节点上跑测试与 PowerShell 场景。配置放本机，不进仓库。
// 用法：node scripts/win-node.mjs <test|pwsh|sh|info> [-- <参数>]
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG = join(homedir(), '.dsh', 'windows-node.json')

function loadConfig() {
  const fromEnv = {
    host: process.env.WIN_NODE_HOST,
    user: process.env.WIN_NODE_USER,
    port: process.env.WIN_NODE_PORT,
    identityFile: process.env.WIN_NODE_KEY,
    workdir: process.env.WIN_NODE_WORKDIR,
  }
  let fromFile = {}
  if (existsSync(CONFIG)) {
    try { fromFile = JSON.parse(readFileSync(CONFIG, 'utf8')) } catch { /* 配置坏了按缺失处理 */ }
  }
  const merged = { ...fromFile }
  for (const [k, v] of Object.entries(fromEnv)) if (v) merged[k] = v
  if (!merged.host) {
    console.error(`缺少 Windows 节点配置：写 ${CONFIG} 或设 WIN_NODE_HOST / WIN_NODE_USER / WIN_NODE_KEY`)
    process.exit(2)
  }
  return { port: 22, workdir: 'C:\\dev\\dsh-chat-link-actions', ...merged }
}

function ssh(config, remoteCommand) {
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15']
  if (config.port) args.push('-p', String(config.port))
  if (config.identityFile) args.push('-i', config.identityFile)
  args.push(config.user ? `${config.user}@${config.host}` : config.host, remoteCommand)
  const result = spawnSync('ssh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  return result.status ?? 1
}

const [verb, ...rest] = process.argv.slice(2)
const passthrough = rest[0] === '--' ? rest.slice(1) : rest
const config = loadConfig()
const dir = config.workdir

function ps(command) {
  // -Command 里双引号要转义，避免 cmd 层吞引号
  const escaped = command.replace(/"/g, '\\"')
  return `powershell -NoProfile -NonInteractive -Command "${escaped}"`
}

const verbs = {
  info: () => ssh(config, ps('$PSVersionTable.PSVersion.ToString(); (Get-Command pwsh -ErrorAction SilentlyContinue).Source; node -v; node -p process.arch')),
  test: () => ssh(config, ps(`cd '${dir}'; node --test test/index.test.js test/client-paths.test.js test/client-menu.test.js`)),
  pwsh: () => ssh(config, ps(passthrough.join(' ') || '$PSVersionTable.PSVersion.ToString()')),
  sh: () => ssh(config, passthrough.join(' ')),
}

if (!verbs[verb]) {
  console.error(`用法：node scripts/win-node.mjs <${Object.keys(verbs).join('|')}> [-- <命令>]`)
  process.exit(2)
}
process.exit(verbs[verb]())
