function Get-ColoopFileHash([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { [BitConverter]::ToString($algorithm.ComputeHash($stream)) }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Assert-ColoopPlainTree([string]$Path) {
  # Reject junctions/symlinks before a mirror can remove anything through them.
  $absolute = [IO.Path]::GetFullPath($Path)
  $ancestor = $absolute
  while ($ancestor) {
    if (Test-Path -LiteralPath $ancestor) {
      if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Linked installation path: $ancestor"
      }
    }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
  }
  if (!(Test-Path -LiteralPath $absolute)) { return }
  $pending = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()
  $pending.Push([IO.DirectoryInfo]::new($absolute))
  while ($pending.Count -gt 0) {
    foreach ($entry in $pending.Pop().EnumerateFileSystemInfos()) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked installation entry: $($entry.FullName)" }
      if ($entry -is [IO.DirectoryInfo]) { $pending.Push($entry) }
    }
  }
}

function Copy-ColoopInstallation([string]$Source, [string]$Programs, [string]$NodeExecutable) {
  $sourcePath = (Resolve-Path -LiteralPath $Source).Path.TrimEnd('\')
  $programsPath = [IO.Path]::GetFullPath($Programs).TrimEnd('\')
  $target = [IO.Path]::GetFullPath((Join-Path $programsPath 'Coloop'))
  if ([IO.Path]::GetDirectoryName($target) -ne $programsPath) { throw 'Installation escaped Programs' }
  if ($sourcePath -eq $target -or $sourcePath.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) -or
      $target.StartsWith($sourcePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Source and installation must be separate' }
  if (!(Test-Path -LiteralPath (Join-Path $sourcePath 'Coloop.exe') -PathType Leaf)) { throw 'Package executable missing' }
  Assert-ColoopPlainTree $sourcePath
  Assert-ColoopPlainTree $target
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  # The user explicitly requires no installation backups or second C: copy.
  # Mirror only this checked Coloop directory, never Programs or user data.
  & robocopy.exe $sourcePath $target /MIR /COPY:DAT /DCOPY:DAT /R:1 /W:1 /MT:16 /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Installation copy failed ($LASTEXITCODE); source package remains available. Installation is not verified." }
  $verify = @'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [source, target] = process.argv.slice(1);
let count = 0;
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function walk(relative = '') {
  const from = path.join(source, relative), to = path.join(target, relative);
  const names = fs.readdirSync(from).sort();
  if (JSON.stringify(names) !== JSON.stringify(fs.readdirSync(to).sort())) throw Error('Installed entries differ: ' + relative);
  for (const name of names) {
    const a = path.join(from, name), b = path.join(to, name), entry = fs.lstatSync(a), installed = fs.lstatSync(b);
    if (entry.isSymbolicLink() || installed.isSymbolicLink() || entry.isDirectory() !== installed.isDirectory()) throw Error('Installed entry type differs: ' + name);
    if (entry.isDirectory()) walk(path.join(relative, name));
    else { if (digest(a) !== digest(b)) throw Error('Installed file hash differs: ' + name); count++; }
  }
}
walk(); console.log(count);
'@
  $count = & $NodeExecutable -e $verify $sourcePath $target
  if ($LASTEXITCODE -ne 0) { throw 'Installed package verification failed; do not launch this installation. Source package remains available.' }
  [pscustomobject]@{ installed=$target; backup=$null; source=$sourcePath; verifiedFiles=[int]$count }
}
