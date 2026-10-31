import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { showWindowsShare } from '../windows-share.js'

function mockChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => { child.killed = true }
  return child
}
test('Windows share transports paths as data, waits for actual UI readiness', async () => {
  const child = mockChild()
  const path = "\\\\server\\share\\中文 & ' $() %PATH% !.txt"
  const result = showWindowsShare(path, { spawnImpl(exe, args, opts) {
    assert.equal(exe, 'powershell.exe')
    assert.equal(opts.env.DSH_SHARE_PATH, path)
    assert.equal(opts.env.DSH_SHARE_CHECK, '0')
    assert.ok(!args.includes('-ExecutionPolicy'))
    assert.ok(!args.some(arg => arg.includes(path)))
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
    assert.ok(script.includes('ShowShareUIForWindow'))
    assert.ok(script.includes('manager.add_DataRequested(requested)'))
    return child
  } })
  assert.equal(result.child, child)
  child.stdout.emit('data', 'DSH_SHARE_')
  child.stdout.emit('data', 'READY\n')
  assert.equal(await result.ready, child)
  child.emit('exit', 0)
})
test('Windows share reports preparation failures instead of success', async () => {
  const child = mockChild()
  const { ready } = showWindowsShare('C:\\missing.txt', { spawnImpl: () => child })
  child.stderr.emit('data', 'DSH_SHARE_ERROR:share-file-not-found')
  child.emit('exit', 1)
  await assert.rejects(ready, /share-file-not-found/)
})
test('Windows share self-check never opens the Share UI or sends a file', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-share-check-'))
  try {
    const path = join(dir, "中文 & ' $() %PATH% !.txt")
    await writeFile(path, 'Local self-check fixture; do not share.')
    const { child, ready } = showWindowsShare(path, { checkOnly: true })
    const exited = once(child, 'exit')
    await ready
    const [code] = await exited
    assert.equal(code, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('Windows share validates missing/null/NUL paths before starting a process', () => {
  for (const path of [null, undefined, '', '  ', 'C:\\bad\0.txt']) {
    assert.throws(() => showWindowsShare(path, { spawnImpl() { assert.fail('must not spawn') } }), /share-needs-file/)
  }
})
test('Windows share can be cancelled through the returned process', async () => {
  const child = mockChild()
  const { child: running, ready } = showWindowsShare('C:\\fixture.txt', { spawnImpl: () => child })
  running.kill()
  child.emit('exit', null)
  await assert.rejects(ready, /windows-share-exited/)
  assert.equal(child.killed, true)
})
