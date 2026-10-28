/**
 * dsh-chat-link-actions — 服务端半：按请求在系统文件管理器里定位文件。
 *
 * 只做一件事：在文件管理器里选中文件本身。界面由 client.js 绘制。
 *
 * Security posture mirrors the other installed bundles: the connection's own
 * request fence rejects cross-origin callers, the path must be absolute, and
 * the argv is never shell-interpolated.
 */

import { execFile, spawn } from 'node:child_process'
import { appendFile, lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dirname, isAbsolute, win32 as pathWin32 } from 'node:path'

/** Services required before mounting: route registration + the web runtime fence. */
export const inject = ['webServer', 'connection']

/** A launcher that hangs must not keep the route open. */
const LAUNCH_TIMEOUT_MS = 3000

/** Absolute on the target platform: POSIX here, drives and UNC on Windows. */
function isAbsoluteFor(path, platform = process.platform) {
  return platform === 'win32' ? pathWin32.isAbsolute(path) : isAbsolute(path)
}

/** Paths that are not a local file on this machine cannot be revealed. */
export function requireAbsolute(path, platform = process.platform) {
  if (typeof path !== 'string' || path === '' || path.includes('\0')) {
    throw new Error('absolute path required')
  }
  if (!isAbsoluteFor(path, platform)) throw new Error('absolute path required')
  return path
}

/**
 * `open -R /a/b/` and `open -R /a/b` are not treated the same by Finder, and a
 * trailing separator makes lstat resolve through a symlink. One canonical form
 * reaches every launcher. Roots (`/`, `C:\`) keep their separator.
 *
 * Only Windows treats `\` as a separator; on POSIX it is an ordinary filename
 * character, so a trailing backslash there is part of the name.
 */
function trimTrailingSeparators(path, platform = process.platform) {
  const pattern = platform === 'win32' ? /[/\\]+$/ : /\/+$/
  const trimmed = path.replace(pattern, '')
  if (trimmed === '') return path
  if (platform === 'win32' && /^[a-z]:$/i.test(trimmed)) return `${trimmed}\\`
  /* `\\?\C:` 少一个分隔符就不再是盘根，verbatim 形式不认这种写法。 */
  if (platform === 'win32' && /^\\\\\?\\[a-z]:$/i.test(trimmed)) return `${trimmed}\\`
  return trimmed
}

/** Containing directory, with the separator rules of the target platform. */
function directoryOf(path, platform = process.platform) {
  return platform === 'win32' ? pathWin32.dirname(path) : dirname(path)
}

/**
 * One canonical Windows spelling: forward slashes become backslashes, duplicate
 * separators collapse, and the drive letter is upper-cased. An existing UNC or
 * `\\?\` prefix keeps its leading pair.
 */
export function normalizeWindowsPath(path) {
  const slashed = trimTrailingSeparators(path, 'win32').replace(/\//g, '\\')
  let prefix = ''
  let rest = slashed
  if (rest.startsWith('\\\\?\\')) {
    prefix = '\\\\?\\'
    rest = rest.slice(4)
  } else if (rest.startsWith('\\\\')) {
    prefix = '\\\\'
    rest = rest.slice(2)
  }
  const joined = `${prefix}${rest.replace(/\\{2,}/g, '\\')}`
  return joined.replace(/^([a-z]):/, (_match, drive) => `${drive.toUpperCase()}:`)
}

/**
 * Windows still caps ordinary paths at MAX_PATH (260) and silently drops
 * trailing spaces and dots, so those targets only resolve through the verbatim
 * form: `\\?\C:\…`, or `\\?\UNC\server\share\…` for UNC shares.
 */
export function extendedWindowsPath(path) {
  if (path.startsWith('\\\\?\\')) return path
  const isUnc = path.startsWith('\\\\')
  /* 盘符形式必须是「盘根 + 绝对路径」，`C:relative` 没有可扩展的根。 */
  if (!isUnc && !/^[A-Za-z]:\\/.test(path)) return path
  /* verbatim 形式不再解释 `.`/`..`：这两段保持原样交给 Shell 解析。 */
  const segments = path.split('\\')
  if (segments.some((segment) => segment === '.' || segment === '..')) return path
  const touchesLimit = path.length > 255
  const awkward = segments.some((segment) => /[ .]$/.test(segment))
  if (!touchesLimit && !awkward) return path
  if (isUnc) return `\\\\?\\UNC\\${path.slice(2)}`
  return `\\\\?\\${path}`
}

/** The exact Windows string the file manager receives. */
function windowsTarget(path) {
  return extendedWindowsPath(normalizeWindowsPath(path))
}

/**
 * Build the single argv element `explorer.exe` expects for a selection.
 *
 * explorer parses its own command line and splits on commas, so a path that
 * itself contains a comma must be quoted as a whole or explorer truncates it
 * (`/select,C:\a,b\c d.md` → `C:\a`). Whitespace is quoted for the same reason.
 * Ordinary paths keep the historical unquoted form.
 */
export function encodeExplorerSelect(path) {
  if (/[",\s]/.test(path)) return `/select,"${path}"`
  return `/select,${path}`
}

/**
 * Quote one bare argument for explorer's own parser.
 *
 * The launcher passes Windows arguments verbatim (see `run`), so this is the
 * only layer that adds quotes — never Node, never cmd.
 */
export function encodeWindowsArgument(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * The argv that selects `path` in the platform's file manager.
 *
 * `facts.isDirectory` / `facts.isSymbolicLink` come from stat/lstat: macOS opens
 * a directory directly instead of using `-R` (Finder behaves inconsistently for
 * directories), and a symlink is always selected as the link itself — never with
 * `-L`, which would reveal the resolved target instead.
 */
export function revealCommand(path, platform = process.platform, facts = {}) {
  const target = trimTrailingSeparators(path, platform)
  const isDirectory = facts?.isDirectory === true
  const isSymbolicLink = facts?.isSymbolicLink === true
  switch (platform) {
    case 'darwin':
      if (isDirectory && !isSymbolicLink) return { command: 'open', args: [target] }
      return { command: 'open', args: ['-R', target] }
    case 'win32': {
      const spelled = windowsTarget(target)
      /* 目录自己就是目标：让资源管理器打开它，而不是在父目录里选中它。 */
      if (isDirectory && !isSymbolicLink) return { command: 'explorer.exe', args: [encodeWindowsArgument(spelled)] }
      /* explorer cannot /select a drive root; open the drive itself instead. */
      if (/^(?:[A-Za-z]:\\|\\\\\?\\[A-Za-z]:\\)$/u.test(spelled)) {
        return { command: 'explorer.exe', args: [encodeWindowsArgument(spelled)] }
      }
      return { command: 'explorer.exe', args: [encodeExplorerSelect(spelled)] }
    }
    case 'android':
      return { command: 'termux-open', args: [isDirectory ? target : directoryOf(target, platform)] }
    default:
      return { command: 'xdg-open', args: [isDirectory ? target : directoryOf(target, platform)] }
  }
}

/** The argv that only opens the containing directory, used when selection fails. */
/** 探测超时：网络盘/断连的共享目录 lstat 可能挂住几分钟，超时后按"未知"继续尝试打开。 */
const PROBE_TIMEOUT_MS = 1500

/**
 * 文件系统探测，带超时上界。
 * @param {string} target 绝对路径
 * @returns {Promise<{state: 'file'|'directory'|'missing'|'unknown', facts: {isDirectory?: boolean, isSymbolicLink?: boolean}}>}
 */
export async function probePath(target) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS)
    timer.unref?.()
  })
  const looked = (async () => {
    const link = await lstat(target).catch(() => null)
    const info = link === null ? null : await stat(target).catch(() => null)
    return { link, info }
  })()
  const raced = await Promise.race([looked, timeout])
  clearTimeout(timer)
  if (raced === null) return { state: 'unknown', facts: {} }
  const { link, info } = raced
  if (link === null && info === null) return { state: 'missing', facts: {} }
  const isDirectory = info !== null && info.isDirectory()
  return {
    state: isDirectory ? 'directory' : 'file',
    facts: { isDirectory, isSymbolicLink: link !== null && link.isSymbolicLink() },
  }
}

export function openDirectoryCommand(path, platform = process.platform) {
  const target = trimTrailingSeparators(path, platform)
  const directory = platform === 'win32'
    ? extendedWindowsPath(directoryOf(normalizeWindowsPath(target), platform))
    : directoryOf(target, platform)
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [directory] }
    case 'win32':
      return { command: 'explorer.exe', args: [directory] }
    case 'android':
      return { command: 'termux-open', args: [directory] }
    default:
      return { command: 'xdg-open', args: [directory] }
  }
}

/**
 * explorer.exe exits with 1 even when it opened the window, so a non-zero exit
 * code from it is not proof of failure — only a spawn error (ENOENT) is.
 */
export function succeeded(result, command) {
  if (result?.ok === true) return true
  if (command !== 'explorer.exe') return false
  const code = result?.error?.code
  return code === 1 || code === '1'
}

/** One line of failure context for the log, never echoed to the caller. */
function describeFailure(result) {
  const detail = result?.stderr || result?.error?.message || result?.error
  return detail === undefined || detail === null || detail === '' ? 'unknown error' : String(detail)
}

/** Run one launcher and resolve its outcome instead of throwing. */
function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: LAUNCH_TIMEOUT_MS,
      /* explorer 解析的是自己那一层命令行：参数已按它的规则拼好，
         再让 Node 加一层引号会变成 `\"`，路径就被截断。 */
      windowsVerbatimArguments: process.platform === 'win32',
      windowsHide: false
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ ok: true })
        return
      }
      resolve({ ok: false, error, stderr: String(stderr ?? '') })
    })
  })
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * Read a property the plugin did not declare in `inject`.
 *
 * A Cordis context throws on a plain `ctx.name` access for anything outside
 * `inject`, so the optional test seam must be read defensively: a real context
 * answers nothing, while a test context that carries the value directly or as
 * a service still gets it.
 */
/* ── 自定义入口：用户自己加的菜单项 ───────────────────────────────────── */

/** Where the user's own menu entries live; one small JSON file in the profile. */
export function customActionsFile(home = homedir()) {
  return join(home, '.dsh', 'chat-link-actions', 'custom-actions.json')
}

/** POSIX single quotes survive every shell; Windows gets double quotes. */
export function quoteArgument(value, platform = process.platform) {
  const text = String(value ?? '')
  if (platform === 'win32') return `"${text.replace(/"/gu, '""')}"`
  return `'${text.replace(/'/gu, `'\\''`)}'`
}

/** One user entry names the command it runs; never more than these limits. */
const CUSTOM_LIMITS = { entries: 20, label: 40, command: 400 }

/** Reject anything that is not a small list of `{ label, command }` pairs. */
export function sanitizeCustomActions(value) {
  const list = Array.isArray(value) ? value : []
  if (list.length > CUSTOM_LIMITS.entries) throw new Error('too-many-entries')
  const kept = []
  for (const entry of list) {
    const label = String(entry?.label ?? '').trim()
    const command = String(entry?.command ?? '').trim()
    if (label === '' || command === '') continue
    if (label.length > CUSTOM_LIMITS.label) throw new Error('label-too-long')
    if (command.length > CUSTOM_LIMITS.command) throw new Error('command-too-long')
    if (/[\u0000-\u001f]/u.test(label + command)) throw new Error('control-character')
    kept.push({ label, command })
  }
  return kept
}

/** Fill the placeholders the user may put in a command. */
export function customCommand(template, target = {}, platform = process.platform) {
  const path = String(target.path ?? '')
  const values = {
    path: quoteArgument(path, platform),
    dir: quoteArgument(dirname(path), platform),
    name: quoteArgument(path === '' ? '' : (path.split(/[\\/]/u).pop() ?? ''), platform),
    url: quoteArgument(target.url ?? '', platform),
  }
  return String(template ?? '').replace(/\{(path|dir|name|url)\}/gu, (match, key) => values[key] ?? match)
}

/** Read one JSON body; the route only ever accepts small payloads. */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function loadCustomActions(file) {
  try {
    const text = await readFile(file, 'utf8')
    return sanitizeCustomActions(JSON.parse(text))
  } catch {
    return []
  }
}

async function saveCustomActions(file, actions) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(actions, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

export function optionalMember(ctx, name) {
  try {
    const direct = ctx[name]
    if (direct !== undefined) return direct
  } catch (ignored) {
    /* not injected: resolved below without the guard */
  }
  try {
    return typeof ctx.get === 'function' ? ctx.get(name, false) : undefined
  } catch (ignored) {
    return undefined
  }
}

/**
 * One line per reveal attempt on disk, so a report of "nothing happened" can be
 * told apart from "never reached the plugin". Kept out of the UI on purpose.
 */
async function trace(line) {
  try {
    const file = join(homedir(), '.dsh', 'logs', 'chat-link-actions.log')
    const info = await stat(file).catch(() => null)
    if (info !== null && info.size > 131072) return
    await appendFile(file, `${new Date().toISOString()} ${line}\n`)
  } catch (ignored) {
    /* diagnostics must never take the plugin down */
  }
}

export function apply(ctx) {
  trace('host 0.3.4 ready')
  const fence = (req) => ctx.connection.requestRejection(req) === undefined
  const warn = (message) => {
    try {
      const logger = optionalMember(ctx, 'logger')
      logger?.warn?.(message)
    } catch (ignored) {
      /* logging must never take the plugin down */
    }
  }
  /** Test seam: a context may replace the process launcher with a recorder. */
  const seam = optionalMember(ctx, 'runLauncher')
  const execute = typeof seam === 'function' ? seam : run

  /** Select the target; when selection is refused, at least open its directory. */
  const launch = async (path, facts = {}) => {
    const select = revealCommand(path, process.platform, facts)
    const selected = await execute(select.command, select.args)
    if (succeeded(selected, select.command)) return { ok: true }
    warn(`chat-link-actions: select via ${select.command} failed: ${describeFailure(selected)}`)
    const open = openDirectoryCommand(path, process.platform)
    const opened = await execute(open.command, open.args)
    if (succeeded(opened, open.command)) return { ok: true }
    warn(`chat-link-actions: open ${directoryOf(path)} failed: ${describeFailure(opened)}`)
    return { ok: false }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/chat-link-actions',
    handler: async (req, res) => {
      const described = `${req.method ?? '?'} ${String(req.url ?? '/')}`
      if (!fence(req)) {
        trace(`fence-refused ${described}`)
        warn('chat-link-actions: reveal request rejected by the connection fence')
        return reply(res, 403, { ok: false, error: 'forbidden' })
      }
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method' })
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const action = url.searchParams.get('action')
        if (action === 'trace') {
          trace(`client ${String(url.searchParams.get('note') ?? '').slice(0, 400)}`)
          return reply(res, 200, { ok: true })
        }
        if (action === 'actions-get') {
          return reply(res, 200, { ok: true, actions: await loadCustomActions(customActionsFile()) })
        }
        if (action === 'actions-save') {
          const body = await readJsonBody(req)
          const saved = sanitizeCustomActions(body?.actions)
          await saveCustomActions(customActionsFile(), saved)
          trace(`actions-saved ${saved.length}`)
          return reply(res, 200, { ok: true, actions: saved })
        }
        if (action === 'actions-run') {
          const body = await readJsonBody(req)
          const label = String(body?.label ?? '')
          const actions = await loadCustomActions(customActionsFile())
          const chosen = actions.find((entry) => entry.label === label)
          if (chosen === undefined) return reply(res, 404, { ok: false, error: 'not-configured' })
          const command = customCommand(chosen.command, { path: body?.path, url: body?.url })
          const child = spawn(command, { shell: true, detached: true, stdio: 'ignore', windowsHide: false })
          child.unref()
          trace(`action-ran ${chosen.label}`)
          return reply(res, 200, { ok: true })
        }
        if (action !== 'reveal') {
          return reply(res, 400, { ok: false, error: 'unknown action' })
        }
        const target = trimTrailingSeparators(requireAbsolute(url.searchParams.get('path')))
        const probed = await probePath(target)
        if (probed.state === 'missing') return reply(res, 404, { ok: false, error: 'not-found' })
        const outcome = await launch(target, probed.facts)
        trace(`${outcome.ok ? 'opened' : 'launch-failed'} ${target}`)
        if (!outcome.ok) return reply(res, 500, { ok: false, error: 'launch-failed' })
        return reply(res, 200, { ok: true })
      } catch (error) {
        return reply(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-chat-link-actions: reveal route')
}
