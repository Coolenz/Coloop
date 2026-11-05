$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$application = $null
$book = $null
$cleanInstance = $false
$leaveOpen = $false
$stage = 'request'
$numberFormats = @{ money = '0.00'; integer = '0'; percent = '0.00%'; text = '@' }

function Release-Com($value) {
  if ($null -ne $value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($value)
  }
}
function Find-Sheet($workbook, [string]$name) {
  foreach ($worksheet in $workbook.Worksheets) {
    if ($worksheet.Name -ceq $name) { return $worksheet }
    Release-Com $worksheet
  }
  return $null
}
function Read-Workbook($workbook, [int]$maxRows) {
  $sheets = [Collections.Generic.List[object]]::new()
  foreach ($worksheet in $workbook.Worksheets) {
    $used = $worksheet.UsedRange
    $rowCount = [Math]::Min([int]$used.Rows.Count, $maxRows)
    $columnCount = [Math]::Min([int]$used.Columns.Count, 256)
    $rows = [Collections.Generic.List[object]]::new()
    for ($row = 1; $row -le $rowCount; $row++) {
      $values = [Collections.Generic.List[object]]::new()
      for ($column = 1; $column -le $columnCount; $column++) {
        $cell = $used.Cells.Item($row, $column)
        $values.Add($cell.Value2)
        Release-Com $cell
      }
      $rows.Add($values.ToArray())
    }
    $sheets.Add(@{ name = [string]$worksheet.Name; rows = $rows.ToArray();
      first_row = [int]$used.Row; first_column = [int]$used.Column;
      truncated = ($used.Rows.Count -gt $maxRows -or $used.Columns.Count -gt 256);
      chart_count = [int]$worksheet.ChartObjects().Count })
    Release-Com $used
    Release-Com $worksheet
  }
  return ,$sheets.ToArray()
}
function Check-Workbook($workbook, $request) {
  foreach ($specification in $request.sheets) {
    $worksheet = Find-Sheet $workbook $specification.name
    if ($null -eq $worksheet) { throw 'WORKBOOK_SHEET_MISSING' }
    for ($row = 0; $row -lt $specification.rows.Count; $row++) {
      $values = $specification.rows[$row]
      for ($column = 0; $column -lt $values.Count; $column++) {
        $cell = $worksheet.Cells.Item($row + 1, $column + 1)
        $expected = $values[$column]
        if ($null -ne $expected -and $expected -is [pscustomobject]) {
          if (-not $cell.HasFormula -or [string]$cell.Text -match '^#(DIV/0!|VALUE!|REF!|NAME\?|NUM!|N/A|NULL!)$') {
            throw 'WORKBOOK_FORMULA_ERROR'
          }
        } elseif ($expected -is [long] -or $expected -is [double] -or $expected -is [decimal]) {
          if ($null -eq $cell.Value2 -or [Math]::Abs([double]$cell.Value2 - [double]$expected) -gt 0.000000001) {
            throw 'WORKBOOK_VALUE_MISMATCH'
          }
        } elseif ([string]$cell.Value2 -cne [string]$expected) {
          throw 'WORKBOOK_VALUE_MISMATCH'
        }
        Release-Com $cell
      }
    }
    foreach ($format in $specification.formats) {
      $range = $worksheet.Range([string]$format.range)
      if ([string]$range.NumberFormat -cne $numberFormats[[string]$format.format]) { throw 'WORKBOOK_NUMBER_FORMAT_MISMATCH' }
      Release-Com $range
    }
    Release-Com $worksheet
  }
  $chartIndexes = @{}
  foreach ($specification in $request.charts) {
    $worksheet = Find-Sheet $workbook $specification.sheet
    if ($null -eq $worksheet -or $worksheet.ChartObjects().Count -lt 1) { throw 'WORKBOOK_CHART_MISSING' }
    if (-not $chartIndexes.ContainsKey($specification.sheet)) { $chartIndexes[$specification.sheet] = 0 }
    $chartIndexes[$specification.sheet]++
    $chart = $worksheet.ChartObjects().Item($chartIndexes[$specification.sheet]).Chart
    if (-not $chart.HasTitle -or $chart.ChartTitle.Text -cne $specification.title -or $chart.SeriesCollection().Count -lt 1) {
      throw 'WORKBOOK_CHART_MISMATCH'
    }
    Release-Com $chart
    Release-Com $worksheet
  }
}
try {
  $request = [Console]::ReadLine() | ConvertFrom-Json
  if ($request.operation -notin @('read_workbook', 'write_workbook', 'show_workbook', 'export_workbook_pdf')) { throw 'OFFICE_OPERATION_UNSUPPORTED' }
  $stage = 'connect'
  $application = New-Object -ComObject KET.Application
  $cleanInstance = ($application.Workbooks.Count -eq 0)
  if ($cleanInstance) { $application.Visible = $false }
  $stage = 'open'
  if ($request.operation -eq 'export_workbook_pdf') {
    $book = $application.Workbooks.Open([string]$request.source, 0, $true)
    foreach ($worksheet in $book.Worksheets) {
      $printRange = $worksheet.UsedRange
      $lastRow = [int]$printRange.Row + [int]$printRange.Rows.Count - 1
      $lastColumn = [int]$printRange.Column + [int]$printRange.Columns.Count - 1
      foreach ($chartObject in $worksheet.ChartObjects()) {
        $corner = $chartObject.BottomRightCell
        $lastRow = [Math]::Max($lastRow, [int]$corner.Row)
        $lastColumn = [Math]::Max($lastColumn, [int]$corner.Column)
        Release-Com $corner
        Release-Com $chartObject
      }
      $firstCell = $worksheet.Cells.Item([int]$printRange.Row, [int]$printRange.Column)
      $lastCell = $worksheet.Cells.Item($lastRow, $lastColumn)
      $expandedRange = $worksheet.Range($firstCell, $lastCell)
      Release-Com $printRange
      Release-Com $firstCell
      Release-Com $lastCell
      $printRange = $expandedRange
      $worksheet.PageSetup.PrintArea = [string]$printRange.Address()
      $worksheet.PageSetup.PaperSize = 9
      $worksheet.PageSetup.LeftMargin = 36
      $worksheet.PageSetup.RightMargin = 36
      if ([double]$printRange.Width -le 523) {
        $worksheet.PageSetup.Zoom = 100
      } else {
        $worksheet.PageSetup.Zoom = $false
        $worksheet.PageSetup.FitToPagesWide = 1
        $worksheet.PageSetup.FitToPagesTall = $false
      }
      Release-Com $printRange
      Release-Com $worksheet
    }
    $stage = 'export_pdf'
    [void]$book.ExportAsFixedFormat(0, [string]$request.path)
    if (-not [IO.File]::Exists([string]$request.path) -or (Get-Item -LiteralPath $request.path).Length -lt 5) { throw 'WORKBOOK_PDF_MISSING' }
    $result = @{ ok = $true; exported = $true }
  } elseif ($request.operation -eq 'show_workbook') {
    $book = $application.Workbooks.Open([string]$request.path, 0, $true)
    $application.Visible = $true
    [void]$book.Activate()
    $bookWindow = $book.Windows.Item(1)
    $bookWindow.Visible = $true
    [void]$bookWindow.Activate()
    $leaveOpen = $true
    . (Join-Path $PSScriptRoot 'office-window.ps1')
    $result = Show-ColoopOfficeWindow ([int64]$application.Hwnd)
    $result.ok = $true; $result.opened = $true; $result.name = [string]$book.Name; $result.channel = 'host_wps_com'
    Release-Com $bookWindow
  } elseif ($request.operation -eq 'read_workbook') {
    $book = $application.Workbooks.Open([string]$request.path, 0, $true)
    $result = @{ ok = $true; sheets = (Read-Workbook $book ([int]$request.max_rows)) }
  } else {
    $book = if ($request.template) {
      $application.Workbooks.Open([string]$request.template, 0, $true)
    } else { $application.Workbooks.Add(-4167) }
    # Resolve every sheet name before formulas can reference later sheets.
    $stage = 'create_sheets'
    for ($sheetIndex = 0; $sheetIndex -lt $request.sheets.Count; $sheetIndex++) {
      $specification = $request.sheets[$sheetIndex]
      $worksheet = Find-Sheet $book $specification.name
      if ($null -eq $worksheet) {
        if (-not $request.template -and $sheetIndex -eq 0) { $worksheet = $book.Worksheets.Item(1) }
        else { $worksheet = $book.Worksheets.Add([Type]::Missing, $book.Worksheets.Item($book.Worksheets.Count)) }
        $worksheet.Name = [string]$specification.name
      }
      Release-Com $worksheet
    }
    $stage = 'write_cells'
    foreach ($specification in $request.sheets) {
      $worksheet = Find-Sheet $book $specification.name
      [void]$worksheet.UsedRange.ClearContents()
      $rowCount = [int]$specification.rows.Count
      $columnCount = 1
      foreach ($row in $specification.rows) { $columnCount = [Math]::Max($columnCount, $row.Count) }
      $matrix = [object[,]]::new($rowCount, $columnCount)
      for ($row = 0; $row -lt $rowCount; $row++) {
        for ($column = 0; $column -lt $specification.rows[$row].Count; $column++) {
          $value = $specification.rows[$row][$column]
          if ($value -is [pscustomobject]) { $matrix[$row, $column] = '' }
          elseif ($value -is [long] -or $value -is [decimal]) { $matrix[$row, $column] = [double]$value }
          elseif ($value -is [string]) { $matrix[$row, $column] = "'" + $value }
          else { $matrix[$row, $column] = $value }
        }
      }
      $range = $worksheet.Range('A1').Resize($rowCount, $columnCount)
      $range.Value2 = $matrix
      Release-Com $range
      for ($row = 0; $row -lt $rowCount; $row++) {
        for ($column = 0; $column -lt $specification.rows[$row].Count; $column++) {
          $value = $specification.rows[$row][$column]
          if ($value -is [pscustomobject]) { $worksheet.Cells.Item($row + 1, $column + 1).Formula = [string]$value.formula }
        }
      }
      foreach ($format in $specification.formats) {
        $range = $worksheet.Range([string]$format.range)
        $range.NumberFormat = $numberFormats[[string]$format.format]
        Release-Com $range
      }
      Release-Com $worksheet
    }
    $stage = 'calculate'
    foreach ($specification in $request.sheets) {
      $worksheet = Find-Sheet $book $specification.name
      [void]$worksheet.Calculate()
      [void]$worksheet.UsedRange.Columns.AutoFit()
      Release-Com $worksheet
    }
    $stage = 'charts'
    foreach ($specification in $request.charts) {
      $worksheet = Find-Sheet $book $specification.sheet
      $source = Find-Sheet $book $specification.source_sheet
      if ($null -eq $worksheet -or $null -eq $source) { throw 'WORKBOOK_CHART_SOURCE_MISSING' }
      $used = $worksheet.UsedRange
      $chartTop = [double]$used.Top + [double]$used.Height + 20
      Release-Com $used
      foreach ($existingChart in $worksheet.ChartObjects()) {
        $chartTop = [Math]::Max($chartTop, [double]$existingChart.Top + [double]$existingChart.Height + 20)
        Release-Com $existingChart
      }
      $chartObject = $worksheet.ChartObjects().Add(0, $chartTop, 480, 270)
      $chart = $chartObject.Chart
      $chart.ChartType = 51
      [void]$chart.SetSourceData($source.Range([string]$specification.range), 2)
      $chart.HasTitle = $true
      $chart.ChartTitle.Text = [string]$specification.title
      Release-Com $chart
      Release-Com $chartObject
      Release-Com $source
      Release-Com $worksheet
    }
    $stage = 'save'
    [void]$book.SaveAs([string]$request.path, 51)
    [void]$book.Close($false)
    Release-Com $book
    $book = $null
    $stage = 'reopen_verify'
    $book = $application.Workbooks.Open([string]$request.path, 0, $true)
    Check-Workbook $book $request
    $result = @{ ok = $true; reopened = $true; verified = $true; sheets = (Read-Workbook $book 1000) }
  }
} catch {
  $exception = $_.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  $code = [string]$exception.Message
  if ($code -notmatch '^[A-Z_]{1,100}$') { $code = 'OFFICE_API_ERROR' }
  $result = @{ ok = $false; error = $code; stage = $stage; hresult = $exception.HResult }
} finally {
  if ($null -ne $book) {
    if (-not $leaveOpen) { try { [void]$book.Close($false) } catch {} }
    Release-Com $book
  }
  if ($null -ne $application) {
    if (-not $leaveOpen -and $cleanInstance -and $application.Workbooks.Count -eq 0) { try { [void]$application.Quit() } catch {} }
    Release-Com $application
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
[Console]::WriteLine(($result | ConvertTo-Json -Compress -Depth 14))
