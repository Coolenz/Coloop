$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$application = $null
$document = $null
$cleanInstance = $false
$leaveOpen = $false
$stage = 'request'
function Release-Com($value) {
  if ($null -ne $value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($value)
  }
}
function Normalize-Body([string]$value) {
  return [regex]::Replace($value.Replace([string][char]7, ' '), '\s+', ' ').Trim()
}
try {
  $request = [Console]::ReadLine() | ConvertFrom-Json
  if ($request.operation -notin @('write_document', 'read_document', 'export_document_pdf', 'show_document')) { throw 'DOCUMENT_OPERATION_UNSUPPORTED' }
  $stage = 'connect'
  $application = New-Object -ComObject KWPS.Application
  $cleanInstance = ($application.Documents.Count -eq 0)
  if ($cleanInstance) { $application.Visible = $false }
  if ($request.operation -eq 'write_document') {
    $stage = 'write'
    $document = $application.Documents.Add()
    $document.PageSetup.TopMargin = 56.7
    $document.PageSetup.BottomMargin = 56.7
    $document.PageSetup.LeftMargin = 56.7
    $document.PageSetup.RightMargin = 56.7
    $document.Content.Font.Name = 'Microsoft YaHei'
    $document.Content.Font.Size = 11
    $document.Content.ParagraphFormat.LineSpacingRule = 0
    $document.Content.ParagraphFormat.SpaceBefore = 0
    $document.Content.ParagraphFormat.SpaceAfter = 6
    $expected = [Collections.Generic.List[string]]::new()
    foreach ($block in $request.blocks) {
      $position = $document.Content.End - 1
      $range = $document.Range($position, $position)
      if ($block.type -eq 'paragraph') {
        $text = ([string]$block.text).Replace("`r`n", "`n").Replace("`n", "`r")
        $range.InsertAfter($text + "`r")
        $written = $document.Range($position, $document.Content.End - 1)
        $written.Font.Size = if ($block.role -eq 'title') { 18 } elseif ($block.role -eq 'heading') { 13 } else { 11 }
        $written.Font.Bold = if ($block.role -in @('title', 'heading')) { 1 } else { 0 }
        $written.ParagraphFormat.SpaceAfter = 6
        $written.ParagraphFormat.KeepWithNext = if ($block.role -in @('title', 'heading')) { -1 } else { 0 }
        $expected.Add([string]$block.text)
        Release-Com $written
      } else {
        $columns = [int]$block.rows[0].Count
        $table = $document.Tables.Add($range, [int]$block.rows.Count, $columns)
        $table.Borders.Enable = 1
        [void]$table.AutoFitBehavior(2)
        $table.Range.Font.Size = 10
        $table.Range.Font.Bold = 0
        $table.Range.ParagraphFormat.SpaceAfter = 2
        $table.Range.ParagraphFormat.KeepWithNext = 0
        $table.Rows.AllowBreakAcrossPages = 0
        for ($row = 0; $row -lt $block.rows.Count; $row++) {
          for ($column = 0; $column -lt $columns; $column++) {
            $cell = $table.Cell($row + 1, $column + 1)
            $cell.Range.Text = [string]$block.rows[$row][$column]
            $expected.Add([string]$block.rows[$row][$column])
            Release-Com $cell
          }
        }
        if ($block.header) { $table.Rows.Item(1).Range.Font.Bold = 1; $table.Rows.Item(1).HeadingFormat = 1 }
        Release-Com $table
      }
      Release-Com $range
    }
    $stage = 'save'
    [void]$document.SaveAs([string]$request.path, 12)
    [void]$document.Close($false)
    Release-Com $document
    $document = $null
    $stage = 'reopen_verify'
    $document = $application.Documents.Open([string]$request.path, $false, $true)
    $actual = [string]$document.Content.Text
    if ((Normalize-Body $actual) -cne (Normalize-Body ($expected -join ' '))) { throw 'DOCUMENT_BODY_MISMATCH' }
    $tableIndex = 0
    foreach ($block in $request.blocks) {
      if ($block.type -ne 'table') { continue }
      $tableIndex++
      $table = $document.Tables.Item($tableIndex)
      if ($table.Rows.Count -ne $block.rows.Count -or $table.Columns.Count -ne $block.rows[0].Count) { throw 'DOCUMENT_TABLE_DIMENSIONS_MISMATCH' }
      for ($row = 0; $row -lt $block.rows.Count; $row++) {
        for ($column = 0; $column -lt $block.rows[$row].Count; $column++) {
          $cell = $table.Cell($row + 1, $column + 1)
          if ((Normalize-Body ([string]$cell.Range.Text)) -cne (Normalize-Body ([string]$block.rows[$row][$column]))) { throw 'DOCUMENT_TABLE_VALUE_MISMATCH' }
          Release-Com $cell
        }
      }
      Release-Com $table
    }
    if ($tableIndex -ne $document.Tables.Count) { throw 'DOCUMENT_TABLE_COUNT_MISMATCH' }
    $result = @{ ok = $true; reopened = $true; verified = $true; text = $actual; tables = [int]$document.Tables.Count }
  } else {
    $stage = 'open'
    $source = if ($request.operation -eq 'show_document') { $request.path } else { $request.source }
    $document = $application.Documents.Open([string]$source, $false, $true)
    if ($request.operation -eq 'read_document') {
      $result = @{ ok = $true; text = [string]$document.Content.Text; tables = [int]$document.Tables.Count }
    } elseif ($request.operation -eq 'show_document') {
      $application.Visible = $true
      [void]$document.Activate()
      . (Join-Path $PSScriptRoot 'office-window.ps1')
      $result = Show-ColoopOfficeWindow ([int64]$application.ActiveWindow.Hwnd)
      $result.ok = $true; $result.opened = $true; $result.name = [string]$document.Name; $result.channel = 'host_wps_com'
      $leaveOpen = $true
    } else {
      $stage = 'export_pdf'
      if (Test-Path -LiteralPath $request.path) { throw 'OUTPUT_ALREADY_EXISTS' }
      try { [void]$document.ExportAsFixedFormat([string]$request.path, 17) }
      catch {
        if (Test-Path -LiteralPath $request.path) { Remove-Item -LiteralPath $request.path -Force }
        [void]$document.SaveAs([string]$request.path, 17)
      }
      if (-not [IO.File]::Exists([string]$request.path) -or (Get-Item -LiteralPath $request.path).Length -lt 5) { throw 'DOCUMENT_PDF_MISSING' }
      $result = @{ ok = $true; exported = $true; source_text = [string]$document.Content.Text }
    }
  }
} catch {
  $exception = $_.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  $code = [string]$exception.Message
  if ($code -notmatch '^[A-Z_]{1,100}$') { $code = 'DOCUMENT_API_ERROR' }
  $result = @{ ok = $false; error = $code; stage = $stage; hresult = $exception.HResult }
} finally {
  if ($null -ne $document) {
    if (-not $leaveOpen) { try { [void]$document.Close($false) } catch {} }
    Release-Com $document
  }
  if ($null -ne $application) {
    if (-not $leaveOpen -and $cleanInstance -and $application.Documents.Count -eq 0) { try { [void]$application.Quit() } catch {} }
    Release-Com $application
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
[Console]::WriteLine(($result | ConvertTo-Json -Compress -Depth 10))
