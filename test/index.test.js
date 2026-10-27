/**
 * 三端一致性用例：命令行拼装、路径校验，以及路由在真实 ctx 形状下能否挂上。
 *
 * 插件在 apply() 里直接读 `ctx.runLauncher`（不在 inject 里的名字），
 * Cordis 会当场抛错，插件半身整个挂不上 —— 表现就是「点『在文件管理器中
 * 查看』没反应」。这里用会抛错的 ctx 代理把这个回归钉住。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  encodeExplorerSelect,
  openDirectoryCommand,
  optionalMember,
  requireAbsolute,
  revealCommand,
  succeeded,
} from '../index.js'

/** 一个只认 inject 的 ctx 代理：访问别的名字就像真 Cordis 那样抛错。 */
function contextWith(options = {}) {
  const routes = []
  const launches = []
  const warnings = []
  const services = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    connection: {
      requestRejection(req) {
        return req.headers.origin === 'https://evil.example' ? new Error('cross-origin') : undefined
      },
    },
    logger: {
      warn(message) {
        warnings.push(message)
      },
    },
  }
  const target = {
    effect(callback) {
      return callback()
    },
    get(name, strict = true) {
      if (Object.hasOwn(services, name)) return services[name]
      if (strict) throw new Error(`cannot get required service "${name}" in inactive context`)
      return undefined
    },
    ...services,
  }
  if (typeof options.runLauncher === 'function') target.runLauncher = options.runLauncher
  const ctx = new Proxy(target, {
    get(object, property) {
      if (typeof property === 'symbol') return object[property]
      if (Object.hasOwn(object, property)) return object[property]
      throw new Error(`cannot get property "${String(property)}" without inject`)
    },
  })
  return { ctx, routes, launches, warnings }
}

function fakeResponse() {
  const state = { status: 0, body: null }
  return {
    state,
    writeHead(status) {
      state.status = status
    },
    end(text) {
      state.body = text === undefined ? null : JSON.parse(text)
    },
  }
}

function revealRequest(path, method = 'POST') {
  return {
    method,
    url: `/chat-link-actions?action=reveal&path=${encodeURIComponent(path)}`,
    headers: { origin: 'http://127.0.0.1:49224' },
  }
}

async function withTempFile(run) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-link-actions-'))
  try {
    const file = join(directory, 'note.md')
    await writeFile(file, '# hi\n')
    await run({ directory, file })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** 启动规格展平成 [命令, ...参数]，断言里就不出现键值对。 */
function flat(spec) {
  return [spec.command, ...spec.args]
}

test('macOS：文件用 -R 选中，目录直接打开，符号链接始终指向自身', () => {
  assert.deepEqual(flat(revealCommand('/a/b.md', 'darwin')), ['open', '-R', '/a/b.md'])
  assert.deepEqual(flat(revealCommand('/a/b/', 'darwin', { isDirectory: true })), ['open', '/a/b'])
  assert.deepEqual(
    flat(revealCommand('/a/link', 'darwin', { isDirectory: true, isSymbolicLink: true })),
    ['open', '-R', '/a/link'],
  )
})

test('Windows：目录自带、逗号与空白加引号、盘符根不再 /select', () => {
  assert.deepEqual(flat(revealCommand('C:\\a\\b', 'win32', { isDirectory: true })), ['explorer.exe', 'C:\\a\\b'])
  assert.deepEqual(flat(revealCommand('C:\\a\\b.md', 'win32')), ['explorer.exe', '/select,C:\\a\\b.md'])
  assert.equal(encodeExplorerSelect('C:\\a,b\\c d.md'), '/select,"C:\\a,b\\c d.md"')
  assert.equal(encodeExplorerSelect('C:\\a\\b.md'), '/select,C:\\a\\b.md')
  assert.deepEqual(flat(revealCommand('C:\\', 'win32')), ['explorer.exe', 'C:\\'])
  assert.deepEqual(flat(revealCommand('\\\\server\\share\\x.md', 'win32')), [
    'explorer.exe',
    '/select,\\\\server\\share\\x.md',
  ])
})

test('Linux：没有选中协议，打开所在目录', () => {
  assert.deepEqual(flat(revealCommand('/a/b.md', 'linux')), ['xdg-open', '/a'])
  assert.deepEqual(flat(openDirectoryCommand('/a/b/', 'linux')), ['xdg-open', '/a'])
})

test('路径校验：只收本机绝对路径，拒绝相对路径与 NUL', () => {
  assert.equal(requireAbsolute('/a/b.md', 'darwin'), '/a/b.md')
  assert.equal(requireAbsolute('C:\\a\\b.md', 'win32'), 'C:\\a\\b.md')
  assert.throws(() => requireAbsolute('a.md', 'darwin'), /absolute path required/u)
  assert.throws(() => requireAbsolute('a/b.md', 'darwin'), /absolute path required/u)
  assert.throws(() => requireAbsolute('/a\0b.md', 'darwin'), /absolute path required/u)
})

test('explorer.exe 退出码非零不算失败，其它启动器算', () => {
  assert.equal(succeeded({ ok: true }, 'open'), true)
  assert.equal(succeeded({ ok: false, error: { code: 1 } }, 'explorer.exe'), true)
  assert.equal(succeeded({ ok: false, error: { code: 1 } }, 'open'), false)
})

test('不在 inject 里的名字读不到值，但不会炸', () => {
  const throwing = contextWith()
  assert.equal(optionalMember(throwing.ctx, 'runLauncher'), undefined)
  const plain = { get: () => undefined, runLauncher: () => 'launcher' }
  assert.equal(optionalMember(plain, 'runLauncher')(), 'launcher')
})

test('apply 在只认 inject 的 ctx 上能挂上路由', () => {
  const { ctx, routes } = contextWith()
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/chat-link-actions')
})

test('路由：跨站被拒、非 POST 与未知动作被拒', async () => {
  const { ctx, routes } = contextWith()
  apply(ctx)
  const handler = routes[0].handler

  const forbidden = fakeResponse()
  await handler({ ...revealRequest('/a/b.md'), headers: { origin: 'https://evil.example' } }, forbidden)
  assert.equal(forbidden.state.status, 403)

  const getOnly = fakeResponse()
  await handler(revealRequest('/a/b.md', 'GET'), getOnly)
  assert.equal(getOnly.state.status, 405)

  const unknown = fakeResponse()
  await handler({ ...revealRequest('/a/b.md'), url: '/chat-link-actions?action=what&path=%2Fa' }, unknown)
  assert.equal(unknown.state.status, 400)
})

test('路由：文件存在时选中它，目录用另一种拼装', async () => {
  await withTempFile(async ({ directory, file }) => {
    const { ctx, routes, launches } = contextWith({
      runLauncher: async (command, args) => {
        launches.push([command, args])
        return { ok: true }
      },
    })
    apply(ctx)
    const handler = routes[0].handler

    const fileReply = fakeResponse()
    await handler(revealRequest(file), fileReply)
    assert.equal(fileReply.state.status, 200)
    assert.deepEqual(fileReply.state.body, { ok: true })
    assert.deepEqual(launches[0], ['open', ['-R', file]])

    const directoryReply = fakeResponse()
    await handler(revealRequest(`${directory}/`), directoryReply)
    assert.equal(directoryReply.state.status, 200)
    assert.deepEqual(launches[1], ['open', [directory]])
  })
})

test('路由：路径不存在回 404，选中失败后退到打开目录', async () => {
  await withTempFile(async ({ file }) => {
    const { ctx, routes, launches } = contextWith({
      runLauncher: async (command, args) => {
        launches.push([command, args])
        if (args[0] === '-R') return { ok: false, error: new Error('no select') }
        return { ok: true }
      },
    })
    apply(ctx)
    const handler = routes[0].handler

    const missing = fakeResponse()
    await handler(revealRequest('/definitely/not/here.md'), missing)
    assert.equal(missing.state.status, 404)
    assert.deepEqual(missing.state.body, { ok: false, error: 'not-found' })

    const fallback = fakeResponse()
    await handler(revealRequest(file), fallback)
    assert.equal(fallback.state.status, 200)
    assert.equal(launches.length, 2)
    assert.deepEqual(launches[1], ['open', [join(file, '..')]])
  })
})

test('路由：两个启动器都失败时回 500 并只记日志', async () => {
  await withTempFile(async ({ file }) => {
    const { ctx, routes, warnings } = contextWith({
      runLauncher: async () => ({ ok: false, error: new Error('boom') }),
    })
    apply(ctx)
    const handler = routes[0].handler

    const failed = fakeResponse()
    await handler(revealRequest(file), failed)
    assert.equal(failed.state.status, 500)
    assert.deepEqual(failed.state.body, { ok: false, error: 'launch-failed' })
    assert.equal(warnings.length, 2)
  })
})
