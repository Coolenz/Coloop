# Actual cross-process native readback. No model, keyboard, mouse or clipboard input.
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$testOutput=Join-Path $repoRoot ('.qa/native-editor-state-'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
[IO.Directory]::CreateDirectory($testOutput)|Out-Null
$source=[IO.File]::ReadAllText((Join-Path $repoRoot 'src/main/infrastructure/foreground-observation.ts'))
$embedded=[regex]::Match($source,"Add-Type -ReferencedAssemblies[^\r\n]+@'\r?\n([\s\S]*?)\r?\n'@")
if(!$embedded.Success){throw 'Production native bridge missing'}
Add-Type -AssemblyName Accessibility
Add-Type -ReferencedAssemblies ([Accessibility.IAccessible].Assembly.Location) -TypeDefinition $embedded.Groups[1].Value
$fixtureSource=@'
using System;using System.IO;using System.Collections.Generic;using System.Windows.Forms;using System.Web.Script.Serialization;
class EditorStateLab:Form {
 public EditorStateLab(string path) {
  Text="Coloop isolated editor index regression";Width=640;Height=740;
  var panel=new FlowLayoutPanel{Dock=DockStyle.Fill,AutoScroll=true,FlowDirection=FlowDirection.TopDown,WrapContents=false};Controls.Add(panel);
  var cases=new List<TextBoxBase>();
  foreach(bool rich in new[]{false,true})foreach(string mode in new[]{"all","middle","caret","wrap","empty"}) {
   TextBoxBase e=rich?(TextBoxBase)new RichTextBox{DetectUrls=false,WordWrap=true}:new TextBox{Multiline=true,WordWrap=true};
   e.Name=(rich?"rich_":"edit_")+mode;e.Width=530;e.Height=55;
   e.Text=mode=="empty"?"":"\u9879\u76ee\uff1aColoop\r\n\u72b6\u6001\uff1a\u5f85\u5904\u7406\r\n\u5907\u6ce8\uff1a\u4fdd\u7559 \U0001f600\r\n"+(mode=="wrap"?new string('\u957f',220):"");
   cases.Add(e);panel.Controls.Add(e);
  }
  Shown+=delegate {
   var records=new List<object>();
   foreach(var e in cases) {
    if(e.Name.EndsWith("middle"))e.Select(e.Text.IndexOf("\u72b6\u6001"),6);
    else if(e.Name.EndsWith("caret"))e.Select(e.TextLength,0);
    else e.Select(0,e.TextLength);
    records.Add(new{name=e.Name,handle=e.Handle.ToInt64(),text=e.Text,selected=e.SelectedText,start=e.SelectionStart,end=e.SelectionStart+e.SelectionLength});
   }
   File.WriteAllText(path,new JavaScriptSerializer().Serialize(new{pid=System.Diagnostics.Process.GetCurrentProcess().Id,window=Handle.ToInt64(),controls=records}));
  };
 }
 [STAThread] static void Main(string[] args){Application.EnableVisualStyles();Application.Run(new EditorStateLab(args[0]));}
}
'@
$fixturePath=Join-Path $testOutput 'EditorStateLab.cs'
$fixtureExe=Join-Path $testOutput 'EditorStateLab.exe'
$identityPath=Join-Path $testOutput 'identity.json'
[IO.File]::WriteAllText($fixturePath,$fixtureSource)
& "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo /codepage:65001 /target:winexe "/out:$fixtureExe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll $fixturePath
if($LASTEXITCODE -ne 0){throw 'Fixture compilation failed'}
$fixtureProcess=Start-Process -FilePath $fixtureExe -ArgumentList ('"'+$identityPath+'"') -PassThru -WindowStyle Hidden
try {
 for($i=0;$i -lt 80;$i++){if(Test-Path -LiteralPath $identityPath){break};Start-Sleep -Milliseconds 100}
 $identity=[IO.File]::ReadAllText($identityPath)|ConvertFrom-Json
 if($identity.pid -ne $fixtureProcess.Id){throw 'Fixture identity mismatch'}
 $window=[IntPtr]::new([long]$identity.window)
 [void][ColoopForeground]::ShowWindowAsync($window,9)
 Start-Sleep -Milliseconds 250
 $results=@()
 foreach($control in $identity.controls) {
  $handle=[IntPtr]::new([long]$control.handle)
  if(![ColoopForeground]::IsNativeEdit($handle,$window,[uint32]$identity.pid)){throw 'Native editor binding rejected'}
  $text=[ColoopForeground]::ReadEditText($handle)
  $selection=[ColoopForeground]::ReadEditSelection($handle)
  if($selection[0] -ne $control.start -or $selection[1] -ne $control.end){throw ('Selection changed: '+$control.name)}
  if($selection[1] -gt $text.Length){throw 'Selection exceeds native text'}
  $selected=$text.Substring($selection[0],$selection[1]-$selection[0])
  $normalize={param($value) $value.Replace("`r`n","`n").Replace("`r","`n")}
  if((& $normalize $text) -cne (& $normalize $control.text)){throw ('Text changed: '+$control.name)}
  if((& $normalize $selected) -cne (& $normalize $control.selected)){throw ('Selection text misaligned: '+$control.name)}
  if($control.name -match '_(all|wrap|empty)$' -and $selection[1] -ne $text.Length){throw ('Full selection misaligned: '+$control.name)}
  if($control.name -eq 'edit_all' -and !$text.Contains("`r`n")){throw 'Ordinary Edit line endings changed'}
  $results+=[pscustomobject]@{name=$control.name;length=$text.Length;selection=@($selection);passed=$true}
 }
 [pscustomobject]@{passed=$true;cases=$results.Count;scope='Actual production C# bridge across processes; Edit/RichEdit, CRLF, emoji, partial/all/caret/wrapped/empty; no input or model calls';results=$results}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $testOutput 'verification.json')
 [pscustomobject]@{passed=$true;cases=$results.Count;output=$testOutput}|ConvertTo-Json -Compress
}finally{if(!$fixtureProcess.HasExited){$fixtureProcess.Kill();$fixtureProcess.WaitForExit()}}
