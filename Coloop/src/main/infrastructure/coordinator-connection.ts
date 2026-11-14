import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Session credential discovery for local adapters; never exposed to the renderer. */
export function publishConnection(
  directory: string,
  url: string,
  token: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
    throw new Error('协调凭据目录无效')
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop';
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl=New-Object System.Security.AccessControl.DirectorySecurity;
$acl.SetAccessRuleProtection($true,$false);
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
$acl.AddAccessRule($rule);
[System.IO.Directory]::SetAccessControl($env:COLOOP_CONNECTION_DIRECTORY,$acl);`
    execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        timeout: 10_000,
        stdio: 'pipe',
        env: { ...environment, COLOOP_CONNECTION_DIRECTORY: directory },
      },
    )
  } else chmodSync(directory, 0o700)
  const path = join(directory, 'connection.json')
  const pending = join(directory, `${randomUUID()}.pending`)
  try {
    writeFileSync(pending, JSON.stringify({ url, token }), { mode: 0o600, flag: 'wx' })
    renameSync(pending, path)
  } finally {
    try {
      unlinkSync(pending)
    } catch {
      /* Already renamed, or write failed. */
    }
  }
  return {
    path,
    remove() {
      try {
        if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path)
      } catch {
        /* A stale credential cannot authenticate to the stopped session. */
      }
    },
  }
}
