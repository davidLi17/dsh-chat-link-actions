import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

/** Opens the native Windows Share sheet. No recipient is chosen or message sent. */
export function showWindowsShare(path, { checkOnly = false, spawnImpl = spawn } = {}) {
  if (typeof path !== 'string' || path.trim() === '' || path.includes('\0')) throw new Error('share-needs-file')
  const source = readFileSync(new URL('./windows-share.ps1', import.meta.url), 'utf8')
  // This is a bundled command, not a user script. No execution-policy setting is
  // changed. Enterprise language restrictions remain in force and may deny Add-Type.
  const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_SHARE_PATH: path, DSH_SHARE_CHECK: checkOnly ? '1' : '0' },
  })
  const ready = new Promise((resolve, reject) => {
    let output = ''
    let errorText = ''
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(child)
    }
    const timer = setTimeout(() => { child.kill(); finish(new Error('windows-share-start-timeout')) }, 60000)
    child.stdout.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-4096)
      if (output.includes(checkOnly ? 'DSH_SHARE_CHECK_OK' : 'DSH_SHARE_READY')) finish()
    })
    child.stderr.on('data', (chunk) => { errorText = (errorText + String(chunk)).slice(-4096) })
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => finish(new Error(`windows-share-exited:${code}${errorText ? `: ${errorText.trim()}` : ''}`)))
  })
  return { child, ready }
}
