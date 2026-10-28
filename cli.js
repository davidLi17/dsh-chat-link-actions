#!/usr/bin/env node
/**
 * 命令行入口：给 agent 用的那份接口，和菜单读写同一份文件。
 * 用法见 `node cli.js protocol`。
 */
import {
  ACTION_PROTOCOL,
  customActionsFile,
  detectTargets,
  loadCustomActions,
  runCustomAction,
  sanitizeCustomActions,
  saveCustomActions
} from './index.js'

function parse(argv) {
  const [command = 'protocol', ...rest] = argv
  const flags = {}
  const words = []
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]  // ui-copy-ignore
    if (token.startsWith('--')) {  // ui-copy-ignore
      const key = token.slice(2)  // ui-copy-ignore
      const value = rest[index + 1] !== undefined && !rest[index + 1].startsWith('--') ? rest[++index] : ''
      flags[key] = value
    } else {
      words.push(token)  // ui-copy-ignore
    }
  }
  return { command, flags, words }
}

async function read() {
  return loadCustomActions(customActionsFile())
}

async function write(actions) {
  const saved = sanitizeCustomActions(actions)
  await saveCustomActions(customActionsFile(), saved)
  return saved
}

const { command, flags, words } = parse(process.argv.slice(2))

try {
  if (command === 'protocol') {
    console.log(JSON.stringify(ACTION_PROTOCOL, null, 2))
  } else if (command === 'list') {
    console.log(JSON.stringify(await read(), null, 2))
  } else if (command === 'detect') {
    console.log(JSON.stringify(await detectTargets(), null, 2))
  } else if (command === 'add') {
    const label = flags.label ?? words[0]
    const kind = flags.kind ?? words[1] ?? 'shell'
    const value = flags.value ?? words.slice(2).join(' ') ?? ''
    if (label === undefined || label === '') throw new Error('缺少 --label')
    const current = await read()
    const index = current.findIndex((entry) => entry.label === label)
    const entry = { label, kind, value }
    if (index >= 0) current[index] = entry
    else current.push(entry)
    console.log(JSON.stringify(await write(current), null, 2))
  } else if (command === 'remove') {
    const labels = new Set(words.length > 0 ? words : [flags.label ?? ''])
    const kept = (await read()).filter((entry) => !labels.has(entry.label))
    console.log(JSON.stringify(await write(kept), null, 2))
  } else if (command === 'run') {
    const label = flags.label ?? words[0]
    const actions = await read()
    const chosen = actions.find((entry) => entry.label === label)
    if (chosen === undefined) throw new Error(`没有这条入口：${String(label)}`)
    await runCustomAction(chosen, { path: flags.path, url: flags.url })
    console.log(`已执行 ${chosen.label}（${chosen.kind}）`)
  } else {
    throw new Error(`不认识的命令：${command}。可用：protocol / list / detect / add / remove / run`)
  }
} catch (error) {
  console.error(String(error?.message ?? error))
  process.exitCode = 1
}
