$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$archive = $null
$stage = 'request'
try {
  $request = [Console]::ReadLine() | ConvertFrom-Json
  if ($request.operation -ne 'create_zip') { throw 'FILE_OPERATION_UNSUPPORTED' }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $stage = 'compress'
  $stream = [IO.File]::Open([string]$request.path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false, [Text.Encoding]::UTF8)
  foreach ($entry in $request.entries) {
    $name = [string]$entry.name
    if ($name -match '(^/|(^|/)\.\.(/|$)|\\|:)' -or [string]::IsNullOrWhiteSpace($name)) { throw 'ARCHIVE_ENTRY_INVALID' }
    if ($entry.type -eq 'directory') { [void]$archive.CreateEntry($name.TrimEnd('/') + '/') }
    elseif ($entry.type -eq 'file') {
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, [string]$entry.path, $name, [IO.Compression.CompressionLevel]::Optimal)
    } else { throw 'ARCHIVE_ENTRY_INVALID' }
  }
  $archive.Dispose()
  $archive = $null
  $stage = 'readback'
  $archive = [IO.Compression.ZipFile]::OpenRead([string]$request.path)
  if ($archive.Entries.Count -ne $request.entries.Count) { throw 'ARCHIVE_ENTRY_COUNT_MISMATCH' }
  foreach ($entry in $request.entries) {
    $name = [string]$entry.name
    if ($entry.type -eq 'directory') { $name = $name.TrimEnd('/') + '/' }
    $stored = $archive.GetEntry($name)
    if ($null -eq $stored) { throw 'ARCHIVE_ENTRY_MISSING' }
    if ($entry.type -eq 'file') {
      $payload = $stored.Open()
      $hash = [Security.Cryptography.SHA256]::Create()
      try { $digest = [BitConverter]::ToString($hash.ComputeHash($payload)).Replace('-', '').ToLowerInvariant() }
      finally { $payload.Dispose(); $hash.Dispose() }
      if ($digest -cne [string]$entry.sha256 -or $stored.Length -ne $entry.bytes) { throw 'ARCHIVE_PAYLOAD_MISMATCH' }
    }
  }
  $result = @{ ok = $true; reopened = $true; verified = $true; entries = $archive.Entries.Count }
} catch {
  $exception = $_.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  $code = [string]$exception.Message
  if ($code -notmatch '^[A-Z_]{1,100}$') { $code = 'FILE_OPERATION_FAILED' }
  $result = @{ ok = $false; error = $code; stage = $stage }
} finally {
  if ($null -ne $archive) { $archive.Dispose() }
  if ($null -ne $stream) { $stream.Dispose() }
}
[Console]::WriteLine(($result | ConvertTo-Json -Compress -Depth 8))
