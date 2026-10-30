import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listWindowsServices, listWindowsShortcuts, runWindowsService, runWindowsShortcut, windowsLiteral, windowsArg, windowsLinkScript, windowsPowerShellCommand, executeWindowsScript, runWindowsOpen } from '../windows-actions.js'

const file = "\\\\server\\share\\中文 & 100% $name's.txt"
function recordingRunner(record) {
  return (exe, args, opts, callback) => {
    record.push({ exe, args, opts, script: Buffer.from(args.at(-1), 'base64').toString('utf16le') })
    callback(null, '', '')
  }
}

test('Windows arguments retain Unicode, UNC, percent, dollar, apostrophe and trailing slashes', () => {
  assert.equal(windowsLiteral("it's $env:TEMP"), "'it''s $env:TEMP'")
  assert.equal(windowsArg('C:\\folder\\'), '"C:\\folder\\\\"')
  assert.equal(windowsArg('a"b'), '"a\\"b"')
  assert.throws(() => windowsLiteral('a\0b'))
  const command = windowsPowerShellCommand(file)
  assert.equal(Buffer.from(command.args.at(-1), 'base64').toString('utf16le'), file)
  assert.ok(!command.args.includes('-ExecutionPolicy'))
})

test('discover only supported real files; launch only exact enumerated names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'link-actions-'))
  try {
    for (const name of ['微信.lnk', '备份.ps1', 'other.bat', 'fake.LNK']) await writeFile(join(directory, name), '')
    await mkdir(join(directory, 'directory.lnk'))
    assert.deepEqual(new Set(await listWindowsServices(directory)), new Set(['微信.lnk', 'fake.LNK']))
    assert.deepEqual(new Set(await listWindowsShortcuts(directory)), new Set(['微信.lnk', 'fake.LNK', '备份.ps1']))
    const calls = []
    const runner = recordingRunner(calls)
    await runWindowsService('微信.lnk', file, { directory, runner })
    await runWindowsShortcut('备份.ps1', file, { directory, runner })
    assert.equal(calls.length, 2)
    assert.ok(calls[0].script.includes(windowsLiteral(windowsArg(file))))
    assert.ok(calls[0].script.includes('$link.Arguments'))
    assert.ok(calls[1].script.includes('-File'))
    assert.ok(!calls[1].script.includes('Bypass'))
    for (const invalid of ['../微信.lnk', '..\\微信.lnk', 'C:\\微信.lnk', 'missing.lnk', 'other.bat']) {
      await assert.rejects(runWindowsService(invalid, file, { directory, runner }), /not-found/)
    }
    await assert.rejects(runWindowsService('微信.lnk', 'relative.txt', { directory, runner }), /absolute-file/)
    assert.equal(calls.length, 2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('missing directories produce empty discovery, failures reject and are bounded', async () => {
  assert.deepEqual(await listWindowsShortcuts(join(tmpdir(), 'nonexistent-link-action-directory')), [])
  await assert.rejects(executeWindowsScript('x', (exe, args, opts, callback) => callback(new Error('ENOENT'), '', '')), /ENOENT/)
  await assert.rejects(executeWindowsScript('x', (exe, args, opts, callback) => callback(new Error('exit'), '', 'policy denied')), /policy denied/)
})

test('app and URL launch never uses cmd.exe and preserve hostile-looking text as literal data', async () => {
  const calls = []
  await runWindowsOpen('C:\\Apps\\viewer.exe', file, recordingRunner(calls))
  await runWindowsOpen('', 'https://example.org/?x=%PATH%&y=$env:TEMP', recordingRunner(calls))
  assert.ok(calls[0].script.includes(windowsLiteral(windowsArg(file))))
  assert.ok(calls[1].script.includes("'https://example.org/?x=%PATH%&y=$env:TEMP'"))
  assert.ok(calls.every(call => call.exe === 'powershell.exe' && !call.opts.shell))
  assert.ok(windowsLinkScript('test.lnk', file).includes('command interpreter'))
})

test('Windows real COM link launch preserves default arguments and selected filename', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'link-actions-native-'))
  const marker = join(directory, 'result.json')
  const script = join(directory, 'safe fixture.js')
  const chosen = join(directory, "中文 & 100% $name's.txt")
  const link = join(directory, 'local-test.lnk')
  try {
    await writeFile(chosen, 'local fixture only')
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)))`)
    await executeWindowsScript(`$link = (New-Object -ComObject WScript.Shell).CreateShortcut(${windowsLiteral(link)})
$link.TargetPath = ${windowsLiteral(process.execPath)}
$link.Arguments = ${windowsLiteral(windowsArg(script))}
$link.Save()`)
    await runWindowsService('local-test.lnk', chosen, { directory })
    const { readFile } = await import('node:fs/promises')
    let result
    for (let i = 0; i < 100; i += 1) {
      try { result = JSON.parse(await readFile(marker, 'utf8')); break } catch { await new Promise(resolve => setTimeout(resolve, 50)) }
    }
    assert.deepEqual(result, [chosen])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('app actions reject command interpreters and scripts rather than reintroducing shell expansion', () => {
  const calls = []
  for (const application of ['cmd.exe', 'C:\\Windows\\System32\\cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe', 'mshta.exe', 'C:\\run.bat', 'C:\\run.lnk']) {
    assert.throws(() => runWindowsOpen(application, file, recordingRunner(calls)), /application-exe/)
  }
  assert.equal(calls.length, 0)
})
