/**
 * dsh-chat-link-actions — 服务端半：按请求在系统文件管理器里定位文件。
 *
 * 只做一件事：在文件管理器里选中文件本身。界面由 client.js 绘制。
 *
 * Security posture mirrors the other installed bundles: the connection's own
 * request fence rejects cross-origin callers, the path must be absolute, and
 * the argv is never shell-interpolated.
 */

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

/** Services required before mounting: route registration + the web runtime fence. */
export const inject = ['webServer', 'connection']

/** Paths that are not a local file on this machine cannot be revealed. */
function requireAbsolute(path) {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) {
    throw new Error('absolute path required')
  }
  return path
}

/**
 * The argv that selects `path` in the platform's file manager. Linux has no
 * select protocol, so its containing directory is opened instead.
 */
function revealCommand(path, platform = process.platform) {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: ['-R', path] }
    case 'win32':
      return { command: 'explorer.exe', args: [`/select,${path}`] }
    case 'android':
      return { command: 'termux-open', args: [dirname(path)] }
    default:
      return { command: 'xdg-open', args: [dirname(path)] }
  }
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function apply(ctx) {
  const fence = (req) => ctx.connection.requestRejection(req) === undefined

  /** Start the file manager and report whether the launcher accepted the command. */
  const launch = async (path) => {
    const { command, args } = revealCommand(path)
    return new Promise((resolve) => {
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => done('launched'), 1500)
      const child = spawn(command, args, { detached: true, stdio: 'ignore' })
      child.once('spawn', () => done('launched'))
      child.once('error', (error) => done(error))
      child.unref()
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/chat-link-actions',
    handler: async (req, res) => {
      if (!fence(req)) {
        ctx.logger?.warn?.('chat-link-actions: reveal request rejected by the connection fence')
        return reply(res, 403, { ok: false, error: 'forbidden' })
      }
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method' })
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        if (url.searchParams.get('action') !== 'reveal') {
          return reply(res, 400, { ok: false, error: 'unknown action' })
        }
        const path = requireAbsolute(url.searchParams.get('path'))
        const info = await stat(path).catch(() => null)
        if (info === null) return reply(res, 404, { ok: false, error: 'not-found' })
        const outcome = await launch(path)
        if (outcome !== 'launched') {
          ctx.logger?.warn?.(`chat-link-actions: file manager launch failed: ${String(outcome?.message ?? outcome)}`)
          return reply(res, 500, { ok: false, error: 'launch-failed' })
        }
        return reply(res, 200, { ok: true })
      } catch (error) {
        return reply(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-chat-link-actions: reveal route')
}
