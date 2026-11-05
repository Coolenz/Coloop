# Isolated real WinForms observation regression. No model calls or desktop input.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$testOutput = Join-Path $repoRoot ('.qa/native-checkbox-state-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
[IO.Directory]::CreateDirectory($testOutput) | Out-Null
$source = [IO.File]::ReadAllText((Join-Path $repoRoot 'src/main/infrastructure/foreground-observation.ts'))
$embedded = [regex]::Match($source, "Add-Type -ReferencedAssemblies[^\r\n]+@'\r?\n([\s\S]*?)\r?\n'@")
if (!$embedded.Success) { throw 'Production native observation bridge not found' }
Add-Type -AssemblyName Accessibility
Add-Type -ReferencedAssemblies ([Accessibility.IAccessible].Assembly.Location) -TypeDefinition $embedded.Groups[1].Value
$fixtureSource = @'
using System;
using System.IO;
using System.Drawing;
using System.Windows.Forms;
class NativeCheckboxStateLab : Form {
 public NativeCheckboxStateLab(string output) {
  Text="Coloop isolated checkbox state regression";Width=560;Height=620;
  var panel=new FlowLayoutPanel {Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown};Controls.Add(panel);
  foreach(var native in new[]{false,true})foreach(var state in new[]{CheckState.Unchecked,CheckState.Checked,CheckState.Indeterminate}) {
   panel.Controls.Add(new CheckBox {Text=(native?"system_":"owner_")+state,ThreeState=true,CheckState=state,Width=480,Height=65,FlatStyle=native?FlatStyle.System:FlatStyle.Standard});
  }
  panel.Controls.Add(new Button {Text="plain_button",Width=480,Height=50,FlatStyle=FlatStyle.Standard});
  panel.Controls.Add(new CheckBox {Text="disabled_checkbox",Checked=true,Enabled=false,Width=480,Height=50});
  Shown+=delegate {File.WriteAllText(output,Handle.ToInt64()+"\n"+System.Diagnostics.Process.GetCurrentProcess().Id);};
 }
 [STAThread] static void Main(string[] args) {Application.EnableVisualStyles();Application.Run(new NativeCheckboxStateLab(args[0]));}
}
'@
$fixturePath = Join-Path $testOutput 'NativeCheckboxStateLab.cs'
$fixtureExe = Join-Path $testOutput 'NativeCheckboxStateLab.exe'
$identityPath = Join-Path $testOutput 'identity.txt'
[IO.File]::WriteAllText($fixturePath,$fixtureSource)
& "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo /target:winexe "/out:$fixtureExe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll $fixturePath
if ($LASTEXITCODE -ne 0) { throw 'Fixture compilation failed' }
$fixtureProcess = Start-Process -FilePath $fixtureExe -ArgumentList ('"'+$identityPath+'"') -PassThru -WindowStyle Hidden
try {
 for($i=0;$i -lt 80;$i++) {if(Test-Path -LiteralPath $identityPath){break};Start-Sleep -Milliseconds 100}
 $identity = [IO.File]::ReadAllLines($identityPath)
 if([int]$identity[1] -ne $fixtureProcess.Id) {throw 'Fixture process mismatch'}
 $window = [IntPtr]::new([long]$identity[0])
 [void][ColoopForeground]::ShowWindowAsync($window,9)
 Start-Sleep -Milliseconds 250
 $targets = @([ColoopForeground]::NativeControlTargets($window,[uint32]$fixtureProcess.Id))
 $targets | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $testOutput 'targets.json')
 foreach($prefix in @('owner_','system_')) {
  foreach($state in @('Unchecked','Checked','Indeterminate')) {
   $matches = @($targets | Where-Object {$_.name -eq ($prefix+$state)})
   if($matches.Count -ne 1 -or $matches[0].type -ne 'CheckBox') {throw "Missing real checkbox $prefix$state"}
   $target = $matches[0]
   if($state -eq 'Indeterminate') {if($target.ContainsKey('checked')){throw 'Mixed state must remain unknown'}}
   elseif(!$target.ContainsKey('checked') -or $target.checked -ne ($state -eq 'Checked')) {throw "Wrong checked state $prefix$state"}
   if($target.source -ne 'win32' -or $target.runtime_id.Length -ne 2) {throw 'Native identity changed'}
  }
 }
 $button = @($targets | Where-Object {$_.name -eq 'plain_button'})
 if($button.Count -ne 1 -or $button[0].type -ne 'Button' -or $button[0].ContainsKey('checked')) {throw 'Ordinary owner-drawn button misclassified'}
 if(@($targets | Where-Object {$_.name -eq 'disabled_checkbox'}).Count) {throw 'Disabled control accepted'}
 if(@([ColoopForeground]::NativeControlTargets($window,[uint32]($fixtureProcess.Id+1))).Count) {throw 'Wrong PID accepted'}
 $report = @{passed=$true;scope='Production native bridge; isolated real WinForms; no input or model calls';targets=$targets;cases=9}
 $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $testOutput 'verification.json')
 @{passed=$true;cases=9;output=$testOutput} | ConvertTo-Json -Compress
} finally {if(!$fixtureProcess.HasExited){$fixtureProcess.Kill();$fixtureProcess.WaitForExit()}}
