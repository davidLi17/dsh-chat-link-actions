/**
 * dsh-chat-link-actions — 服务端半：按请求在系统文件管理器里定位文件。
 *
 * 只做一件事：在文件管理器里选中文件本身。界面由 client.js 绘制。
 *
 * Security posture mirrors the other installed bundles: the connection's own
 * request fence rejects cross-origin callers, the path must be absolute, and
 * the argv is never shell-interpolated.
 */

import { execFile } from 'node:child_process'
import { lstat, stat } from 'node:fs/promises'
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
  const touchesLimit = path.length > 255
  const awkward = path.split('\\').some((segment) => /[ .]$/.test(segment))
  if (!touchesLimit && !awkward) return path
  if (path.startsWith('\\\\')) return `\\\\?\\UNC\\${path.slice(2)}`
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
      if (isDirectory && !isSymbolicLink) return { command: 'explorer.exe', args: [spelled] }
      /* explorer cannot /select a drive root; open the drive itself instead. */
      if (/^[A-Za-z]:\\$/u.test(spelled)) return { command: 'explorer.exe', args: [spelled] }
      return { command: 'explorer.exe', args: [encodeExplorerSelect(spelled)] }
    }
    case 'android':
      return { command: 'termux-open', args: [isDirectory ? target : directoryOf(target, platform)] }
    default:
      return { command: 'xdg-open', args: [isDirectory ? target : directoryOf(target, platform)] }
  }
}

/** The argv that only opens the containing directory, used when selection fails. */
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
    execFile(command, args, { timeout: LAUNCH_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
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

export function apply(ctx) {
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
      if (!fence(req)) {
        warn('chat-link-actions: reveal request rejected by the connection fence')
        return reply(res, 403, { ok: false, error: 'forbidden' })
      }
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method' })
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        if (url.searchParams.get('action') !== 'reveal') {
          return reply(res, 400, { ok: false, error: 'unknown action' })
        }
        const target = trimTrailingSeparators(requireAbsolute(url.searchParams.get('path')))
        const link = await lstat(target).catch(() => null)
        const info = link === null ? null : await stat(target).catch(() => null)
        if (link === null && info === null) return reply(res, 404, { ok: false, error: 'not-found' })
        const facts = {
          isDirectory: info !== null && info.isDirectory(),
          isSymbolicLink: link !== null && link.isSymbolicLink(),
        }
        const outcome = await launch(target, facts)
        if (!outcome.ok) return reply(res, 500, { ok: false, error: 'launch-failed' })
        return reply(res, 200, { ok: true })
      } catch (error) {
        return reply(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-chat-link-actions: reveal route')
}
