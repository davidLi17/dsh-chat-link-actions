// Install the packed plugin with the official CLI, then test its real HTTP boundary.
// Uses a disposable HOME and DSH_HOME. Never launches an app or sends a shared file.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const cli = process.env.DSH_CLI
const tarball = process.argv[2]
assert.ok(cli && tarball, 'Usage: DSH_CLI=/path/to/dsh/lib/bin.js node scripts/check-dsh-host.mjs plugin.tgz')
assert.equal(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim(), '0.2.2-rc.1')
const root = await mkdtemp(join(tmpdir(), 'dsh-link-host-'))
const env = { ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), DSH_HOME: join(root, 'dsh'),
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
  npm_config_cache: process.env.npm_config_cache || join(root, 'cache') }
let server
let logs = ''
try {
  await mkdir(env.HOME, { recursive: true })
  const args = ['plugin', '--profile', 'web', 'add', `file:${resolve(tarball)}`, '--ignore-scripts']
  if (process.env.PNPM_STORE_DIR) args.push('--store-dir', process.env.PNPM_STORE_DIR)
  execFileSync(process.execPath, [cli, ...args], { env, stdio: 'pipe', timeout: 120_000 })
  const profile = join(env.DSH_HOME, 'profiles/web')
  const config = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.ok(config.dsh.profile.bundles.includes('dsh-chat-link-actions'))
  const installed = JSON.parse(await readFile(join(profile, 'node_modules/dsh-chat-link-actions/package.json'), 'utf8'))
  const expected = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(installed.version, expected.version)
  assert.equal(installed.dsh.compatibility.dsh, '0.2.2-rc.1')
  server = spawn(process.execPath, [cli, 'web', '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', chunk => { logs += chunk })
  server.stderr.on('data', chunk => { logs += chunk })
  let url
  for (let i = 0; i < 240; i++) {
    url = logs.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]
    if (url) break
    assert.equal(server.exitCode, null, 'Host exited before readiness')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(url, 'Host readiness timed out')
  const request = (path, options = {}) => fetch(new URL(path, url), { ...options, redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  const login = await request(url)
  assert.equal(login.status, 303)
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie, 'Official launch token must exchange for an auth cookie')
  const index = await request('/', { headers: { cookie } })
  assert.equal(index.status, 200)
  const html = await index.text()
  const clientUrl = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)]
    .map(match => match[1].replaceAll('&amp;', '&')).find(path => path.includes('dsh-chat-link-actions/client.js'))
  assert.ok(clientUrl, 'Official client graph must include this bundle')
  assert.equal(new URL(clientUrl, url).origin, new URL(url).origin)
  const client = await request(clientUrl, { headers: { cookie } })
  assert.equal(client.status, 200)
  assert.match(await client.text(), /id: "dsh-chat-link-actions"/)
  const route = '/chat-link-actions'
  assert.equal((await request(`${route}?action=actions-get`, { method: 'POST' })).status, 403)
  assert.equal((await request(route, { headers: { cookie } })).status, 405)
  const post = (action, extraHeaders = {}) => request(`${route}?${action}`, { method: 'POST', headers: { cookie, ...extraHeaders } })
  assert.equal((await post('action=actions-get', { origin: 'https://untrusted.example' })).status, 403)
  const actions = await post('action=actions-get')
  assert.equal(actions.status, 200)
  const value = await actions.json()
  assert.equal(value.ok, true)
  assert.deepEqual(value.actions, [])
  assert.equal(value.home, env.HOME)
  const protocol = await post('action=protocol')
  assert.equal(protocol.status, 200)
  assert.equal((await protocol.json()).ok, true)
  const invalid = await post('action=reveal&path=relative')
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error, 'absolute path required')
  assert.doesNotMatch(logs, /(?:incompatible|skipping profile bundle).*chat-link-actions/i)
  console.log(JSON.stringify({ host: '0.2.2-rc.1', version: installed.version, bundleRegistered: true, clientServed: true,
    authenticatedRead: true, unauthenticatedRejected: true, foreignOriginRejected: true,
    invalidPathRejected: true, methodRestricted: true, osLauncherInvoked: false, browserVisualsTested: false }))
} finally {
  if (server && server.exitCode === null) {
    const exit = new Promise(resolve => server.once('exit', resolve))
    server.kill('SIGTERM')
    const timer = setTimeout(() => server.kill('SIGKILL'), 5000)
    await exit
    clearTimeout(timer)
  }
  await rm(root, { recursive: true, force: true })
}
