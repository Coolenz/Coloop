$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$page = $null
$memory = $null
$reader = $null
try {
  $request = [Console]::ReadLine() | ConvertFrom-Json
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
  [void][Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime]
  [void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
  [void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]
  function Await-Result($operation, [Type]$type) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and
      $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    $task = $method.MakeGenericMethod($type).Invoke($null, @($operation))
    $task.GetAwaiter().GetResult()
  }
  $file = Await-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync([string]$request.path)) ([Windows.Storage.StorageFile])
  $document = Await-Result ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  $index = [int]$request.page - 1
  if ($index -lt 0 -or $index -ge $document.PageCount) { throw 'PDF_PAGE_OUT_OF_RANGE' }
  $page = $document.GetPage($index)
  $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $options.DestinationWidth = 1600
  $memory = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $action = $page.RenderToStreamAsync($memory, $options)
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
  } | Select-Object -First 1
  [void]$method.Invoke($null, @($action)).GetAwaiter().GetResult()
  if ($memory.Size -gt 700000) { throw 'PDF_PAGE_IMAGE_TOO_LARGE' }
  $reader = [Windows.Storage.Streams.DataReader]::new($memory.GetInputStreamAt(0))
  [void](Await-Result ($reader.LoadAsync([uint32]$memory.Size)) ([uint32]))
  $bytes = New-Object byte[] ([int]$memory.Size)
  $reader.ReadBytes($bytes)
  $result = @{ ok = $true; page = $index + 1; page_count = [int]$document.PageCount; image = [Convert]::ToBase64String($bytes) }
} catch {
  $exception = $_.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  $code = [string]$exception.Message
  if ($code -notmatch '^[A-Z_]{1,100}$') { $code = 'PDF_RENDER_FAILED' }
  $result = @{ ok = $false; error = $code }
} finally {
  if ($null -ne $reader) { $reader.Dispose() }
  if ($null -ne $memory) { $memory.Dispose() }
  if ($null -ne $page) { $page.Dispose() }
}
[Console]::WriteLine(($result | ConvertTo-Json -Compress -Depth 8))
