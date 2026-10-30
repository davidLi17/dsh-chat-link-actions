/** Windows counterparts to macOS sharing services and Shortcuts.
 * Only user-installed SendTo links and explicitly configured local workflows run.
 * No cmd.exe interpolation and no execution-policy override.
 */
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'

export function windowsActionDirectories(home = homedir(), appData = process.env.APPDATA) {
  return {
    services: join(appData || join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'SendTo'),
    shortcuts: join(home, '.dsh', 'chat-link-actions', 'shortcuts'),
  }
}

async function listEntries(directory, extensions) {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.filter(entry => entry.isFile() && extensions.includes(win32.extname(entry.name).toLowerCase()))
      .map(entry => entry.name).sort((a, b) => a.localeCompare(b))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}
export function listWindowsServices(directory = windowsActionDirectories().services) {
  return listEntries(directory, ['.lnk'])
}
export function listWindowsShortcuts(directory = windowsActionDirectories().shortcuts) {
  return listEntries(directory, ['.lnk', '.ps1'])
}

export function windowsLiteral(value) {
  if (String(value).includes('\0')) throw new Error('invalid-windows-argument')
  return `'${String(value).replace(/'/g, "''")}'`
}
/** Microsoft CRT command-line quoting, not cmd.exe escaping. */
export function windowsArg(value) {
  return '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
}
export function windowsPowerShellCommand(script) {
  return {
    executable: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  }
}
export function executeWindowsScript(script, runner = execFile) {
  const { executable, args } = windowsPowerShellCommand(`$ErrorActionPreference = 'Stop';\n${script}`)
  return new Promise((resolve, reject) => {
    runner(executable, args, { windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`windows-action-failed: ${String(stderr || error.message).trim().slice(0, 1000)}`))
      else resolve(stdout)
    })
  })
}

export function windowsLinkScript(link, file) {
  return `$link = (New-Object -ComObject WScript.Shell).CreateShortcut(${windowsLiteral(link)})
$target = [Environment]::ExpandEnvironmentVariables($link.TargetPath)
if ([IO.Path]::GetExtension($target) -ine '.exe' -or [IO.Path]::GetFileName($target) -imatch '^(cmd|powershell|pwsh|wscript|cscript|mshta)\\.exe$') { throw 'Link must target an application exe, not a command interpreter. Use a .ps1 workflow for scripts.' }
$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = $target
$info.UseShellExecute = $true
$info.Arguments = (($link.Arguments + ' ' + ${windowsLiteral(windowsArg(file))}).Trim())
if ($link.WorkingDirectory) { $info.WorkingDirectory = $link.WorkingDirectory }
$null = [Diagnostics.Process]::Start($info)`
}

async function namedEntry(name, directory, list) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name.includes('\0') || !(await list(directory)).includes(name)) {
    throw new Error('windows-action-not-found')
  }
  const full = join(directory, name)
  if (!(await stat(full)).isFile()) throw new Error('windows-action-not-found')
  return full
}
function requireFile(file) {
  if (!win32.isAbsolute(file) || file.includes('\0')) throw new Error('windows-action-needs-absolute-file')
}
export async function runWindowsService(name, file, options = {}) {
  requireFile(file)
  const directory = options.directory ?? windowsActionDirectories().services
  const link = await namedEntry(name, directory, listWindowsServices)
  return executeWindowsScript(windowsLinkScript(link, file), options.runner)
}
export async function runWindowsShortcut(name, file, options = {}) {
  requireFile(file)
  const directory = options.directory ?? windowsActionDirectories().shortcuts
  const workflow = await namedEntry(name, directory, listWindowsShortcuts)
  if (win32.extname(workflow).toLowerCase() === '.lnk') {
    return executeWindowsScript(windowsLinkScript(workflow, file), options.runner)
  }
  // Start an independent child: long workflows outlive the HTTP request. -File
  // retains the machine/user policy (including signature requirements).
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', workflow, file].map(windowsArg).join(' ')
  return executeWindowsScript(`$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = (Get-Command powershell.exe -ErrorAction Stop).Source
$info.UseShellExecute = $true
$info.Arguments = ${windowsLiteral(args)}
$child = [Diagnostics.Process]::Start($info)
if ($child.WaitForExit(1000) -and $child.ExitCode -ne 0) { throw ('Workflow failed during startup (exit ' + $child.ExitCode + '). Check the script and PowerShell execution policy; no policy override was applied.') }`, options.runner)
}

/** Open a configured exe or URL through Windows Shell without cmd interpolation. */
export function runWindowsOpen(application, target, runner) {
  if (application) {
    if (!/\.exe$/i.test(application) || /^(?:cmd|powershell|pwsh|wscript|cscript|mshta)(?:\.exe)?$/i.test(win32.basename(application))) throw new Error('windows-app-needs-application-exe')
    return executeWindowsScript(`$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = ${windowsLiteral(application)}
$info.UseShellExecute = $true
$info.Arguments = ${windowsLiteral(windowsArg(target))}
$null = [Diagnostics.Process]::Start($info)`, runner)
  }
  return executeWindowsScript(`$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = ${windowsLiteral(target)}
$info.UseShellExecute = $true
$null = [Diagnostics.Process]::Start($info)`, runner)
}
