import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, desktopCapturer, screen, nativeImage } from 'electron'
import type { OcrResult } from '../../shared/contracts'

const foregroundScript = `
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClientsideProviders
$proxyAssembly=[AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.GetName().Name -eq 'UIAutomationClientsideProviders' } | Select-Object -First 1
[System.Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly($proxyAssembly.GetName())
Add-Type @'
using System; using System.Runtime.InteropServices;
public class ColoopForeground {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x,y; }
 [StructLayout(LayoutKind.Sequential)] public struct GUIINFO { public int cbSize; public uint flags; public IntPtr hwndActive,hwndFocus,hwndCapture,hwndMenuOwner,hwndMoveSize,hwndCaret; public RECT rcCaret; }
 [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread,ref GUIINFO info);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,System.Text.StringBuilder name,int count);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int command);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from,uint to,bool attach);
 public static void RestoreTarget(IntPtr target,uint expectedPid) {
  uint pid;GetWindowThreadProcessId(target,out pid);
  if(!IsWindow(target)||pid!=expectedPid||!IsWindowVisible(target))return;
  if(IsIconic(target))ShowWindowAsync(target,9);
  uint current=GetCurrentThreadId();
  uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out pid);
  bool attached=false;
  try {
   if(foreground!=0&&foreground!=current)attached=AttachThreadInput(current,foreground,true);
   SetForegroundWindow(target);
  } finally {
   if(attached)AttachThreadInput(current,foreground,false);
  }
 }
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h,ref POINT p);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref POINT p);
 delegate bool EnumChildProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h,EnumChildProc callback,IntPtr p);
 public static IntPtr[] NativeEditors(IntPtr top,uint pid) {
  var results=new System.Collections.Generic.List<IntPtr>();
  EnumChildWindows(top,delegate(IntPtr h,IntPtr p){if(results.Count<32&&IsWindowVisible(h)&&IsNativeEdit(h,top,pid))results.Add(h);return results.Count<32;},IntPtr.Zero);
  return results.ToArray();
 }
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] static extern IntPtr Msg(IntPtr h,uint m,IntPtr w,IntPtr l,uint f,uint t,out IntPtr result);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] static extern IntPtr TextMsg(IntPtr h,uint m,IntPtr w,System.Text.StringBuilder l,uint f,uint t,out IntPtr result);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW")] static extern IntPtr SelMsg(IntPtr h,uint m,ref uint w,ref uint l,uint f,uint t,out IntPtr result);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW")] static extern IntPtr RectMsg(IntPtr h,uint m,IntPtr w,ref RECT l,uint f,uint t,out IntPtr result);
 public static bool IsNativeEdit(IntPtr h,IntPtr top,uint expectedPid) {
  uint p;GetWindowThreadProcessId(h,out p);if(p!=expectedPid || GetAncestor(h,2)!=top || !IsWindowEnabled(h))return false;
  var c=new System.Text.StringBuilder(256);GetClassName(h,c,256);string name=c.ToString();
  if(!(name=="Edit" || name.StartsWith("WindowsForms10.EDIT.") || name.StartsWith("WindowsForms10.RichEdit20W.") || name.StartsWith("RichEdit20") || name=="RICHEDIT50W" || name=="RichEditD2DPT"))return false;
  long style=GetWindowLongPtr(h,-16).ToInt64();return (style&0x0800)==0 && (style&0x0020)==0;
 }
 public static string ReadEditText(IntPtr h) {
  IntPtr length;if(Msg(h,0xE,IntPtr.Zero,IntPtr.Zero,2,250,out length)==IntPtr.Zero)throw new Exception("EDIT_READ_TIMEOUT");
  int count=length.ToInt32();if(count<0||count>200000)throw new Exception("EDIT_TEXT_TOO_LARGE");
  var text=new System.Text.StringBuilder(count+1);IntPtr copied;
  if(TextMsg(h,0xD,new IntPtr(count+1),text,2,250,out copied)==IntPtr.Zero)throw new Exception("EDIT_READ_TIMEOUT");return text.ToString();
 }
 public static uint[] ReadEditSelection(IntPtr h) {
  uint start=0,end=0;IntPtr result;if(SelMsg(h,0xB0,ref start,ref end,2,250,out result)==IntPtr.Zero)throw new Exception("EDIT_SELECTION_TIMEOUT");return new uint[]{start,end};
 }
 public static System.Collections.Generic.Dictionary<string,object> NativePointTarget(IntPtr h,IntPtr top,uint expectedPid,int x,int y) {
  uint p;GetWindowThreadProcessId(h,out p);if(p!=expectedPid||GetAncestor(h,2)!=top||!IsWindowEnabled(h)||!IsWindowVisible(h))return null;
  var c=new System.Text.StringBuilder(256);GetClassName(h,c,256);string cls=c.ToString();string type=null,name=null;int item=-1;
  RECT rect;GetWindowRect(h,out rect);
  if(cls=="Button"||cls.StartsWith("WindowsForms10.BUTTON.")) {
   long style=GetWindowLongPtr(h,-16).ToInt64()&15;
   type=(style==2||style==3||style==5||style==6)?"CheckBox":(style==4||style==9)?"RadioButton":"Button";
   name=ReadEditText(h);if(name.Length>300)return null;
  } else if(cls=="ListBox"||cls.StartsWith("WindowsForms10.LISTBOX.")) {
   POINT point=new POINT();point.x=x;point.y=y;if(!ScreenToClient(h,ref point))return null;
   IntPtr hit;if(Msg(h,0x1A9,IntPtr.Zero,new IntPtr((point.y<<16)|(point.x&0xffff)),2,250,out hit)==IntPtr.Zero)return null;
   long packed=hit.ToInt64();if((packed>>16)!=0)return null;item=(int)(packed&0xffff);
   IntPtr length;if(Msg(h,0x18A,new IntPtr(item),IntPtr.Zero,2,250,out length)==IntPtr.Zero||length.ToInt64()<0||length.ToInt64()>300)return null;
   var text=new System.Text.StringBuilder(length.ToInt32()+1);IntPtr copied;
   if(TextMsg(h,0x189,new IntPtr(item),text,2,250,out copied)==IntPtr.Zero)return null;name=text.ToString();type="ListItem";
   RECT local=new RECT();IntPtr result;if(RectMsg(h,0x198,new IntPtr(item),ref local,2,250,out result)==IntPtr.Zero||result.ToInt64()<0)return null;
   POINT start=new POINT();start.x=local.left;start.y=local.top;POINT end=new POINT();end.x=local.right;end.y=local.bottom;
   ClientToScreen(h,ref start);ClientToScreen(h,ref end);rect.left=start.x;rect.top=start.y;rect.right=end.x;rect.bottom=end.y;
  } else return null;
  var target=new System.Collections.Generic.Dictionary<string,object>{{"name",name},{"type",type},{"source","win32"},{"rect",new int[]{rect.left,rect.top,rect.right,rect.bottom}},{"runtime_id",item<0?new long[]{42,h.ToInt64()}:new long[]{42,h.ToInt64(),item}},{"enabled",true},{"process_id",expectedPid}};
  IntPtr state;
  if((type=="CheckBox"||type=="RadioButton")&&Msg(h,0xF0,IntPtr.Zero,IntPtr.Zero,2,250,out state)!=IntPtr.Zero) {
   long check=state.ToInt64();
   if(check==0||check==1)target[type=="RadioButton"?"selected":"checked"]=check==1;
  }
  if(type=="ListItem"&&Msg(h,0x187,new IntPtr(item),IntPtr.Zero,2,250,out state)!=IntPtr.Zero&&state.ToInt64()>=0) {
   target["selected"]=state.ToInt64()>0;
  }
  return target;
 }
 public static System.Collections.Generic.Dictionary<string,object>[] NativeControlTargets(IntPtr top,uint pid) {
  var results=new System.Collections.Generic.List<System.Collections.Generic.Dictionary<string,object>>();
  EnumChildWindows(top,delegate(IntPtr h,IntPtr unused){
   if(results.Count>=32)return false;if(!IsWindowVisible(h)||!IsWindowEnabled(h))return true;
   RECT bounds;GetWindowRect(h,out bounds);var name=new System.Text.StringBuilder(256);GetClassName(h,name,256);
   bool list=name.ToString()=="ListBox"||name.ToString().StartsWith("WindowsForms10.LISTBOX.");
   if(list){
    IntPtr count;if(Msg(h,0x18B,IntPtr.Zero,IntPtr.Zero,2,250,out count)==IntPtr.Zero)return true;
    for(int item=0;item<Math.Min(32,count.ToInt32())&&results.Count<32;item++){
     RECT local=new RECT();IntPtr result;if(RectMsg(h,0x198,new IntPtr(item),ref local,2,250,out result)==IntPtr.Zero||result.ToInt64()<0)continue;
     POINT point=new POINT();point.x=(local.left+local.right)/2;point.y=(local.top+local.bottom)/2;ClientToScreen(h,ref point);
     if(point.x<bounds.left||point.x>=bounds.right||point.y<bounds.top||point.y>=bounds.bottom)continue;
     try{var target=NativePointTarget(h,top,pid,point.x,point.y);if(target!=null)results.Add(target);}catch{}
    }
   }else{try{var target=NativePointTarget(h,top,pid,(bounds.left+bounds.right)/2,(bounds.top+bounds.bottom)/2);if(target!=null)results.Add(target);}catch{}}
   return results.Count<32;
  },IntPtr.Zero);return results.ToArray();
 }
}
'@
[void][ColoopForeground]::SetProcessDPIAware()
try { [void][ColoopForeground]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) } catch {}
function Test-ColoopEditable($element) {
 try {
  if ($element.Current.IsPassword -or !$element.Current.IsEnabled) { return $false }
  if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {
   try { $valuePattern=$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); return !$valuePattern.Current.IsReadOnly } catch {}
  }
  if (@([System.Windows.Automation.ControlType]::Edit,[System.Windows.Automation.ControlType]::Document) -contains $element.Current.ControlType) {
   $textPattern=$element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
   $readOnly=$textPattern.DocumentRange.GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute)
   return ($readOnly -is [bool]) -and !$readOnly
  }
 } catch {}
 return $false
}
function Read-ColoopControlState($element,$target) {
 try {
  $toggle=$element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  $state=$toggle.Current.ToggleState
  if($state -ne [System.Windows.Automation.ToggleState]::Indeterminate) {
   $target.checked=($state -eq [System.Windows.Automation.ToggleState]::On)
  }
 } catch {}
 try {
  $selection=$element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  $target.selected=$selection.Current.IsSelected
 } catch {}
}
while ($null -ne ($line = [Console]::ReadLine())) {
 try {
 $request = $line | ConvertFrom-Json
 if ($request.activate) {
  $target=[IntPtr][Int64]::Parse($request.activate)
  [ColoopForeground]::RestoreTarget($target,[uint32]$request.activateProcess)
  Start-Sleep -Milliseconds 40
 }
 $handle = [ColoopForeground]::GetForegroundWindow(); [uint32]$processId = 0
 $threadId=[ColoopForeground]::GetWindowThreadProcessId($handle,[ref]$processId)
 $rect = New-Object ColoopForeground+RECT
 [void][ColoopForeground]::GetWindowRect($handle,[ref]$rect)
 $focusDiag=$null; $editable = $false; $editText = $null; $editRect = $null; $editRuntime = $null; $selectionStart = $null; $selectionEnd = $null; $editableSource='uia'
 try {
 $f = [System.Windows.Automation.AutomationElement]::FocusedElement
 $gui=New-Object ColoopForeground+GUIINFO;$gui.cbSize=[Runtime.InteropServices.Marshal]::SizeOf($gui)
 if([ColoopForeground]::GetGUIThreadInfo($threadId,[ref]$gui) -and $gui.hwndFocus -ne [IntPtr]::Zero) {
  $nativeFocus=[System.Windows.Automation.AutomationElement]::FromHandle($gui.hwndFocus)
  if($nativeFocus.Current.ProcessId -eq $processId -and (Test-ColoopEditable $nativeFocus)) { $f=$nativeFocus }
 }
 $focusClass=[Text.StringBuilder]::new(256);[void][ColoopForeground]::GetClassName($gui.hwndFocus,$focusClass,256)
 if ($request.enumerate) { $focusDiag=@{nativeClass=$focusClass.ToString();nativeHandle=$gui.hwndFocus.ToInt64().ToString();type=$f.Current.ControlType.ProgrammaticName;process=$f.Current.ProcessId;enabled=$f.Current.IsEnabled;password=$f.Current.IsPassword;patterns=@($f.GetSupportedPatterns()|ForEach-Object{$_.ProgrammaticName})};try{$focusDiag.valueReadOnly=$f.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.IsReadOnly}catch{$focusDiag.valueReadOnly="unsupported"};try{$focusDiag.textReadOnly=[string]$f.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute)}catch{$focusDiag.textReadOnly="unsupported"};try{$legacy=$f.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern);$focusDiag.legacyRole=$legacy.Current.Role;$focusDiag.legacyState=$legacy.Current.State}catch{} }
 $editable = (Test-ColoopEditable $f) -and $f.Current.ProcessId -eq $processId
 if ($editable) {
  $r = $f.Current.BoundingRectangle; $editRect = @($r.Left,$r.Top,$r.Right,$r.Bottom); $editRuntime = @($f.GetRuntimeId())
  try { $vp = $f.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $editText = $vp.Current.Value } catch {}
  try {
   $tp = $f.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
   if ($null -eq $editText) { $editText = $tp.DocumentRange.GetText(-1) }
   $selected = $tp.GetSelection(); if ($selected.Length -eq 1) {
    $prefix = $tp.DocumentRange.Clone()
    $prefix.MoveEndpointByRange([System.Windows.Automation.TextPatternRangeEndpoint]::End,$selected[0],[System.Windows.Automation.TextPatternRangeEndpoint]::Start)
    $selectionStart = $prefix.GetText(-1).Length; $selectionEnd = $selectionStart + $selected[0].GetText(-1).Length
   }
  } catch {}
  if ($null -ne $editText -and $editText.Length -gt 200000) { $editText = $null }
 }
 } catch {}
 if (!$editable) { try {
  $gui=New-Object ColoopForeground+GUIINFO;$gui.cbSize=[Runtime.InteropServices.Marshal]::SizeOf($gui)
  if([ColoopForeground]::GetGUIThreadInfo($threadId,[ref]$gui) -and [ColoopForeground]::IsNativeEdit($gui.hwndFocus,$handle,$processId)) {
   $editText=[ColoopForeground]::ReadEditText($gui.hwndFocus);$selection=[ColoopForeground]::ReadEditSelection($gui.hwndFocus)
   $nativeRect=New-Object ColoopForeground+RECT;[void][ColoopForeground]::GetWindowRect($gui.hwndFocus,[ref]$nativeRect)
   $editRect=@($nativeRect.left,$nativeRect.top,$nativeRect.right,$nativeRect.bottom);$editRuntime=@(42,$gui.hwndFocus.ToInt64())
   $selectionStart=$selection[0];$selectionEnd=$selection[1];$editableSource='win32';$editable=$true
  }
 } catch {} }
 $pointOwner = $handle.ToInt64()
 if ($null -ne $request.x) { $p = New-Object ColoopForeground+POINT; $p.x = $request.x; $p.y = $request.y; $hit = [ColoopForeground]::WindowFromPoint($p); $pointOwner = [ColoopForeground]::GetAncestor($hit,2).ToInt64() }
 [uint32]$pointProcessId=0;[void][ColoopForeground]::GetWindowThreadProcessId([IntPtr]::new($pointOwner),[ref]$pointProcessId)
 $pointTarget = $null
 if ($null -ne $request.x) { try {
  $hitElement = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new($request.x,$request.y))
  for ($depth=0;$depth-lt 6 -and $null-ne $hitElement;$depth++) {
   $type = $hitElement.Current.ControlType.ProgrammaticName.Replace('ControlType.','')
   if (@('Button','Edit','Document','CheckBox','RadioButton','ListItem','MenuItem','TabItem','TreeItem','Hyperlink','ScrollBar','Slider','ComboBox','SplitButton','DataItem') -contains $type) {
    if (@('Edit','Document') -contains $type -and !(Test-ColoopEditable $hitElement)) { break }
    if (!$hitElement.Current.IsPassword) { $hr=$hitElement.Current.BoundingRectangle; $pointTarget=@{name=$hitElement.Current.Name;type=$type;rect=@($hr.Left,$hr.Top,$hr.Right,$hr.Bottom);runtime_id=@($hitElement.GetRuntimeId());enabled=$hitElement.Current.IsEnabled;process_id=$hitElement.Current.ProcessId} }
    if ($null -ne $pointTarget) {
     Read-ColoopControlState $hitElement $pointTarget
    }
    break
   }
   $hitElement=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($hitElement)
  }
 } catch {} }
 if ($null -eq $pointTarget -and $null -ne $request.x -and [ColoopForeground]::IsNativeEdit($hit,$handle,$processId)) {
  $nativeRect=New-Object ColoopForeground+RECT;[void][ColoopForeground]::GetWindowRect($hit,[ref]$nativeRect)
  $pointTarget=@{name='Native text editor';type='Edit';source='win32';rect=@($nativeRect.left,$nativeRect.top,$nativeRect.right,$nativeRect.bottom);runtime_id=@(42,$hit.ToInt64());enabled=$true;process_id=$processId}
 }
 if ($null -eq $pointTarget -and $null -ne $request.x) { try { $pointTarget=[ColoopForeground]::NativePointTarget($hit,$handle,$processId,[int]$request.x,[int]$request.y) } catch {} }
 $editorTargets=@()
 $controlTargets=@()
 if($request.enumerate) {
  try {
   $windowElement=[System.Windows.Automation.AutomationElement]::FromHandle($handle)
   $condition=[System.Windows.Automation.OrCondition]::new([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit),[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Document))
   $edits=$windowElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
   for($i=0;$i-lt [Math]::Min(32,$edits.Count);$i++) {
    $e=$edits[$i];if($e.Current.ProcessId -eq $processId -and !$e.Current.IsOffscreen -and (Test-ColoopEditable $e)) {
     $er=$e.Current.BoundingRectangle;$editorTargets+=@{type=$e.Current.ControlType.ProgrammaticName.Replace('ControlType.','');name='Text editor';source='uia';runtime_id=@($e.GetRuntimeId());rect=@($er.Left,$er.Top,$er.Right,$er.Bottom)}
    }
   }
  } catch {}
  try {
   $toggleCondition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty,$true)
   $selectionCondition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty,$true)
   $stateCondition=[System.Windows.Automation.OrCondition]::new($toggleCondition,$selectionCondition)
   $controls=$windowElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,$stateCondition)
   for($i=0;$i-lt $controls.Count -and $controlTargets.Count-lt 32;$i++) {
    $e=$controls[$i]
    $type=$e.Current.ControlType.ProgrammaticName.Replace('ControlType.','')
    if($e.Current.ProcessId -ne $processId -or $e.Current.IsOffscreen -or !$e.Current.IsEnabled -or $e.Current.IsPassword){continue}
    if(@('Button','CheckBox','RadioButton','ListItem','MenuItem','TabItem','TreeItem','DataItem') -notcontains $type){continue}
    $r=$e.Current.BoundingRectangle
    if($r.Width-le 0 -or $r.Height-le 0 -or $r.Left-lt $rect.left -or $r.Top-lt $rect.top -or $r.Right-gt $rect.right -or $r.Bottom-gt $rect.bottom){continue}
    $target=@{type=$type;name=$e.Current.Name;source='uia';runtime_id=@($e.GetRuntimeId());rect=@($r.Left,$r.Top,$r.Right,$r.Bottom);enabled=$true;process_id=$processId}
    Read-ColoopControlState $e $target
    if($target.ContainsKey('checked') -or $target.ContainsKey('selected')){$controlTargets+=,$target}
   }
  } catch {}
  foreach($nativeEditor in [ColoopForeground]::NativeEditors($handle,$processId)) {
   $er=New-Object ColoopForeground+RECT;[void][ColoopForeground]::GetWindowRect($nativeEditor,[ref]$er)
   $editorName='Native text editor'
   try {$label=[System.Windows.Automation.AutomationElement]::FromHandle($nativeEditor).Current.Name;if($label -and $label.Length-le 120 -and $label-ne [ColoopForeground]::ReadEditText($nativeEditor)){$editorName=$label}}catch{}
   $editorTargets+=@{type='Edit';name=$editorName;source='win32';runtime_id=@(42,$nativeEditor.ToInt64());rect=@($er.left,$er.top,$er.right,$er.bottom)}
  }
  foreach($target in [ColoopForeground]::NativeControlTargets($handle,$processId)) {
   if($controlTargets.Count-ge 32){break}
   $bounds=$target.rect
   if($bounds[0]-lt $rect.left -or $bounds[1]-lt $rect.top -or $bounds[2]-gt $rect.right -or $bounds[3]-gt $rect.bottom){continue}
   $identity=$target.runtime_id -join ','
   if(!@($controlTargets|Where-Object{($_.runtime_id -join ',') -eq $identity}).Count){$controlTargets+=,$target}
  }
 }
 @{ window_id=$handle.ToInt64().ToString(); process_id=$processId; process_name=(Get-Process -Id $processId -ErrorAction Stop).ProcessName; window_rect=@($rect.left,$rect.top,$rect.right,$rect.bottom); point_owner=$pointOwner.ToString(); point_process_id=$pointProcessId; point_target=$pointTarget; focus_diagnostic=$focusDiag; editor_targets=$editorTargets; control_targets=$controlTargets; editable_focus=$editable; editable_rect=$editRect; editable_runtime_id=$editRuntime; editable_source=$editableSource; editable_text=$editText; selection_start=$selectionStart; selection_end=$selectionEnd; screen=@{x=[ColoopForeground]::GetSystemMetrics(76);y=[ColoopForeground]::GetSystemMetrics(77);width=[ColoopForeground]::GetSystemMetrics(78);height=[ColoopForeground]::GetSystemMetrics(79)} } | ConvertTo-Json -Compress -Depth 5 | ForEach-Object { [Console]::WriteLine($_) }
 } catch { [Console]::WriteLine('{"error":"foreground_unavailable"}') }
}
`
export interface ForegroundMetadata {
  window_id: string
  process_id: number
  process_name?: string
  window_rect: number[]
  point_owner: string
  point_process_id?: number
  editable_focus: boolean
  editable_rect?: number[]
  editable_text?: string
  editable_runtime_id?: number[]
  editable_source?: 'uia' | 'win32'
  editor_targets?: {
    type: string
    name: string
    source: 'uia' | 'win32'
    runtime_id: number[]
    rect: number[]
  }[]
  control_targets?: {
    type: string
    name: string
    source: 'uia' | 'win32'
    runtime_id: number[]
    rect: number[]
    checked?: boolean
    selected?: boolean
  }[]
  point_target?: {
    name: string
    type: string
    source?: 'uia' | 'win32'
    rect: number[]
    runtime_id: number[]
    enabled: boolean
    checked?: boolean
    selected?: boolean
    process_id: number
  }
  selection_start?: number
  selection_end?: number
  screen: { x: number; y: number; width: number; height: number }
}
export interface ForegroundFrame extends ForegroundMetadata {
  png: Buffer
  fingerprint: string
  display_id: string
  image_origin: number[]
  scale: number[]
}
export interface ForegroundObservation extends ForegroundMetadata {
  observation_id: string
  captured_at: number
  content_hash: string
  ocr_text: string
  ocr_items: { id: number; text: string; rect: number[]; center: number[]; confidence: number }[]
  targets: unknown[]
}
export type ObservationAction = {
  x?: number
  y?: number
  center?: number[]
  kind?: string
  action?: string
  type?: string
  target_id?: number
}

/** Ignore small caret/antialias changes; periodic OCR still catches small real edits. */
export function hasMeaningfulVisualChange(before: Buffer, after: Buffer) {
  if (before.length !== after.length || !before.length) return true
  let changed = 0
  const pixels = before.length / 4
  for (let at = 0; at < before.length; at += 4) {
    if (
      Math.max(
        Math.abs(before[at] - after[at]),
        Math.abs(before[at + 1] - after[at + 1]),
        Math.abs(before[at + 2] - after[at + 2]),
      ) > 24
    )
      changed++
  }
  return changed / pixels > 0.001
}

/** One read-only Windows worker; this class has no input injection API. */
export class WindowsObservationCapture {
  private child?: ChildProcessWithoutNullStreams
  private serial: Promise<unknown> = Promise.resolve()
  private pending?: { resolve(value: ForegroundMetadata): void; reject(error: Error): void }
  private textBaseline = new Map<string, ForegroundMetadata>()
  private lastExternalTarget?: { window_id: string; process_id: number }
  private inputBindings = new Map<string, ForegroundMetadata>()
  private visual?: { identity: string; sample: Buffer; fingerprint: string }
  constructor(
    private options: {
      excludedBounds?: () => Electron.Rectangle[]
      recognize: (png: Buffer, signal?: AbortSignal) => Promise<OcrResult>
    },
  ) {}
  private startWorker() {
    if (this.child) return this.child
    // Keep the static helper in a private temp file: UTF-16 base64 exceeds the
    // Windows command-line limit as native observation adapters grow.
    const directory = mkdtempSync(join(tmpdir(), 'coloop-observer-'))
    const script = join(directory, 'foreground.ps1')
    writeFileSync(script, foregroundScript, 'utf8')
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    this.child = child
    createInterface({ input: child.stdout }).on('line', (line) => {
      const pending = this.pending
      this.pending = undefined
      try {
        const row = JSON.parse(line)
        if (row.error || !row.window_id || !Array.isArray(row.window_rect)) throw Error()
        pending?.resolve(row)
      } catch {
        pending?.reject(new Error('Windows foreground metadata unavailable'))
      }
    })
    const unavailable = () => {
      if (this.child === child) {
        this.child = undefined
        this.pending?.reject(new Error('Windows foreground observer stopped'))
        this.pending = undefined
      }
    }
    child.on('error', unavailable)
    child.on('exit', unavailable)
    const cleanup = () => {
      try {
        unlinkSync(script)
        rmdirSync(directory)
      } catch {}
    }
    child.once('error', cleanup)
    child.once('exit', cleanup)
    child.stdin.on('error', unavailable)
    child.stderr.on('data', () => {})
    return child
  }
  metadata(
    point?: number[],
    activate?: string,
    enumerate = false,
    activateProcess?: number,
  ): Promise<ForegroundMetadata> {
    const run = this.serial
      .catch(() => {})
      .then(
        () =>
          new Promise<ForegroundMetadata>((resolve, reject) => {
            const timer = setTimeout(() => {
              this.dispose()
              reject(new Error('Windows foreground observation timed out'))
            }, 10000)
            this.pending = {
              resolve: (value) => {
                clearTimeout(timer)
                resolve(value)
              },
              reject: (error) => {
                clearTimeout(timer)
                reject(error)
              },
            }
            this.startWorker().stdin.write(
              JSON.stringify({
                ...(point ? { x: point[0], y: point[1] } : {}),
                ...(activate ? { activate, activateProcess } : {}),
                enumerate,
              }) + '\n',
            )
          }),
      )
    this.serial = run
    return run
  }
  async captureFrame(signal?: AbortSignal): Promise<ForegroundFrame | null> {
    signal?.throwIfAborted()
    const meta = await this.metadata()
    const own = BrowserWindow.getAllWindows().some((window) => {
      const raw = window.getNativeWindowHandle()
      return (
        raw.length >= 4 &&
        String(raw.length >= 8 ? raw.readBigUInt64LE() : raw.readUInt32LE()) === meta.window_id
      )
    })
    if (own || meta.window_id === '0') return null
    this.lastExternalTarget = { window_id: meta.window_id, process_id: meta.process_id }
    const [left, top, right, bottom] = meta.window_rect
    const dip = screen.screenToDipRect(null, {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    })
    const display = screen.getDisplayMatching(dip)
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    })
    const source = sources.find((s) => s.display_id === String(display.id))
    if (!source || source.thumbnail.isEmpty()) throw new Error('Screen capture unavailable')
    const bounds = screen.dipToScreenRect(null, display.bounds)
    const size = source.thumbnail.getSize()
    const sx = size.width / bounds.width,
      sy = size.height / bounds.height
    const rect = {
      x: Math.max(0, Math.round((left - bounds.x) * sx)),
      y: Math.max(0, Math.round((top - bounds.y) * sy)),
      width: 0,
      height: 0,
    }
    rect.width = Math.min(size.width, Math.round((right - bounds.x) * sx)) - rect.x
    rect.height = Math.min(size.height, Math.round((bottom - bounds.y) * sy)) - rect.y
    if (rect.width <= 0 || rect.height <= 0) return null
    let image = await source.thumbnail.crop(rect)
    const bitmap = await image.toBitmap()
    if (!Buffer.isBuffer(bitmap)) throw new Error('Screen bitmap is unavailable')
    const imageOrigin = [bounds.x + rect.x / sx, bounds.y + rect.y / sy]
    for (const excluded of this.options.excludedBounds?.() || []) {
      const physical = screen.dipToScreenRect(null, excluded)
      const x1 = Math.max(0, Math.floor((physical.x - imageOrigin[0]) * sx)),
        y1 = Math.max(0, Math.floor((physical.y - imageOrigin[1]) * sy))
      const x2 = Math.min(
          rect.width,
          Math.ceil((physical.x + physical.width - imageOrigin[0]) * sx),
        ),
        y2 = Math.min(rect.height, Math.ceil((physical.y + physical.height - imageOrigin[1]) * sy))
      for (let y = y1; y < y2; y++)
        for (let x = x1; x < x2; x++) {
          const at = (y * rect.width + x) * 4
          bitmap[at] = bitmap[at + 1] = bitmap[at + 2] = 0
          bitmap[at + 3] = 255
        }
    }
    image = await nativeImage.createFromBitmap(bitmap, {
      width: rect.width,
      height: rect.height,
      scaleFactor: 1,
    })
    signal?.throwIfAborted()
    const live = await this.metadata()
    if (live.window_id !== meta.window_id || live.window_rect.join() !== meta.window_rect.join())
      return null
    const reduced = await image.resize({ width: 320 })
    const sample = await reduced.toBitmap()
    const png = await image.toPNG()
    if (!Buffer.isBuffer(sample) || !Buffer.isBuffer(png))
      throw new Error('Screen image is unavailable')
    const identity = meta.window_id + ':' + meta.window_rect.join()
    if (
      !this.visual ||
      this.visual.identity !== identity ||
      hasMeaningfulVisualChange(this.visual.sample, sample)
    ) {
      this.visual = {
        identity,
        sample,
        fingerprint: createHash('sha256').update(identity).update(sample).digest('hex'),
      }
    }
    return {
      ...meta,
      png,
      fingerprint: this.visual.fingerprint,
      display_id: String(display.id),
      image_origin: imageOrigin,
      scale: [sx, sy],
    }
  }
  async recognize(frame: ForegroundFrame, signal?: AbortSignal): Promise<ForegroundObservation> {
    const ocr = await this.options.recognize(frame.png, signal)
    signal?.throwIfAborted()
    const live = await this.metadata(undefined, undefined, true)
    if (live.window_id !== frame.window_id || live.window_rect.join() !== frame.window_rect.join())
      throw new Error('Foreground changed during OCR')
    if (
      typeof frame.editable_text === 'string' &&
      typeof live.editable_text === 'string' &&
      frame.editable_text !== live.editable_text
    )
      throw new Error('Foreground text changed during OCR')
    const {
      png: _png,
      fingerprint: _fingerprint,
      display_id: _display,
      image_origin: origin,
      scale,
      editable_text: _text,
      selection_start: _start,
      selection_end: _end,
      ...meta
    } = frame
    const editors = [...(live.editor_targets ?? []), ...(live.control_targets ?? [])]
    if (
      live.editable_focus &&
      live.editable_rect &&
      live.editable_runtime_id &&
      !editors.some((editor) => editor.runtime_id.join() === live.editable_runtime_id!.join())
    ) {
      editors.unshift({
        type: 'Edit',
        name: 'Focused text editor',
        source: live.editable_source ?? 'uia',
        runtime_id: live.editable_runtime_id,
        rect: live.editable_rect,
      })
    }
    const distinctEditors = editors.filter(
      (editor, index) =>
        editors.findIndex((other) => other.runtime_id.join() === editor.runtime_id.join()) ===
        index,
    )
    const ocrItems = ocr.items.map((item, id) => ({
      id,
      text: item.text,
      rect: item.rect.map((v, i) => v / scale[i % 2] + origin[i % 2]),
      center: item.center.map((v, i) => v / scale[i] + origin[i]),
      confidence: item.confidence,
    }))
    const editor = live.editable_rect
    const outsideEditor = ocrItems.filter(
      (item) =>
        !editor ||
        item.center[0] < editor[0] ||
        item.center[0] >= editor[2] ||
        item.center[1] < editor[1] ||
        item.center[1] >= editor[3],
    )
    const editorCoversDocument =
      !!editor &&
      (editor[2] - editor[0]) * (editor[3] - editor[1]) >=
        (frame.window_rect[2] - frame.window_rect[0]) *
          (frame.window_rect[3] - frame.window_rect[1]) *
          0.5
    const semanticText =
      live.editable_focus && typeof live.editable_text === 'string'
        ? live.editable_text +
          '\n' +
          (ocrItems.length
            ? outsideEditor.map((item) => item.text).join('\n')
            : editorCoversDocument
              ? ''
              : ocr.text)
        : ocr.text
    return {
      ...meta,
      observation_id: randomUUID(),
      captured_at: Date.now(),
      // A caret may be OCR'd as I/|. UIA text is used only as a local dedup key;
      // the context sent to RK/cloud remains the original OCR text and boxes.
      content_hash: createHash('sha256')
        .update(frame.window_id + '\n' + semanticText)
        .update(
          JSON.stringify(
            distinctEditors
              .filter((target) => 'checked' in target || 'selected' in target)
              .map((target) => ({
                runtime_id: target.runtime_id,
                checked: 'checked' in target ? target.checked : undefined,
                selected: 'selected' in target ? target.selected : undefined,
              })),
          ),
        )
        .digest('hex'),
      ocr_text: ocr.text,
      ocr_items: ocrItems,
      targets: distinctEditors.map((editor, index) => {
        const label = ['Native text editor', 'Focused text editor'].includes(editor.name)
          ? ocrItems
              .filter(
                (item) =>
                  item.text.length <= 120 &&
                  item.rect[3] <= editor.rect[1] + 3 &&
                  editor.rect[1] - item.rect[3] < 60 &&
                  item.center[0] >= editor.rect[0] &&
                  item.center[0] <= editor.rect[2],
              )
              .sort((a, b) => b.rect[3] - a.rect[3])[0]
          : undefined
        return {
          ...editor,
          name: label?.text ?? editor.name,
          id: ocr.items.length + index,
          center: [(editor.rect[0] + editor.rect[2]) / 2, (editor.rect[1] + editor.rect[3]) / 2],
        }
      }),
    }
  }
  async capture(signal?: AbortSignal) {
    const frame = await this.captureFrame(signal)
    return frame ? this.recognize(frame, signal) : null
  }
  async rememberTarget() {
    const live = await this.metadata()
    const own = BrowserWindow.getAllWindows().some((window) => {
      const raw = window.getNativeWindowHandle()
      return String(raw.length >= 8 ? raw.readBigUInt64LE() : raw.readUInt32LE()) === live.window_id
    })
    if (!own && live.window_id !== '0')
      this.lastExternalTarget = { window_id: live.window_id, process_id: live.process_id }
  }
  async restoreTarget() {
    const target = this.lastExternalTarget
    if (!target) return false
    try {
      const live = await this.metadata(undefined, target.window_id, false, target.process_id)
      return live.window_id === target.window_id && live.process_id === target.process_id
    } catch {
      // Restoration is best effort. The task observes whichever external window
      // is available next instead of aborting submission or a user answer.
      return false
    }
  }
  private async inspectInput(
    snapshot: ForegroundObservation,
    action: ObservationAction,
    guard: boolean,
  ) {
    const target =
      action.target_id === undefined
        ? undefined
        : [
            ...snapshot.ocr_items,
            ...(snapshot.targets as {
              id: number
              center: number[]
              runtime_id?: number[]
              text?: string
            }[]),
          ].find((item) => item.id === action.target_id)
    const center =
      action.center ||
      (Number.isFinite(action.x) && Number.isFinite(action.y)
        ? [action.x!, action.y!]
        : target?.center)
    const live = await this.metadata(center)
    const same =
      live.window_id === snapshot.window_id &&
      live.process_id === snapshot.process_id &&
      live.window_rect.join() === snapshot.window_rect.join()
    const kind = action.kind || action.action || action.type || ''
    const needsEdit = ['paste', 'type', 'fill', 'paste_text', 'type_text', 'hotkey'].includes(kind)
    if (needsEdit && kind !== 'hotkey' && same && live.editable_focus && !guard) {
      this.textBaseline.clear()
      this.textBaseline.set(snapshot.observation_id, live)
    }
    const needsPoint = ['click', 'double_click', 'move', 'move_to', 'scroll'].includes(kind)
    const inside =
      (!center && !needsPoint) ||
      (!!center &&
        center.length === 2 &&
        center.every(Number.isFinite) &&
        center[0] >= live.window_rect[0] &&
        center[0] < live.window_rect[2] &&
        center[1] >= live.window_rect[1] &&
        center[1] < live.window_rect[3] &&
        live.point_owner === live.window_id)
    const bindingKey =
      snapshot.observation_id +
      ':' +
      (needsEdit ? 'edit' : kind) +
      ':' +
      (action.target_id ?? center?.join() ?? 'focus')
    const baseline = this.inputBindings.get(bindingKey)
    const element = live.point_target
    const elementValid =
      !needsPoint ||
      (!!element &&
        element.enabled &&
        element.process_id === snapshot.process_id &&
        element.runtime_id?.length > 0 &&
        !!center &&
        center[0] >= element.rect[0] &&
        center[0] < element.rect[2] &&
        center[1] >= element.rect[1] &&
        center[1] < element.rect[3])
    const focusValid = !needsEdit || (live.editable_focus && !!live.editable_runtime_id?.length)
    const expected = target as { runtime_id?: number[]; text?: string } | undefined
    const literal = (value: string) => value.replace(/\s+/g, '').toLocaleLowerCase()
    const observedPointMatches =
      !needsPoint ||
      (!!expected &&
        !!element &&
        (expected.runtime_id?.length
          ? expected.runtime_id.join() === element.runtime_id.join()
          : !!expected.text &&
            (['Edit', 'Document'].includes(element.type) ||
              (!!element.name && literal(element.name).includes(literal(expected.text))))))
    const observedFocusMatches =
      !needsEdit ||
      (!!expected?.runtime_id?.length &&
        expected.runtime_id.join() === live.editable_runtime_id?.join())
    const identityMatches =
      !guard ||
      (!!baseline &&
        (!needsPoint ||
          (!!baseline.point_target &&
            JSON.stringify(baseline.point_target) === JSON.stringify(element))) &&
        (!needsEdit ||
          (baseline.editable_runtime_id?.join() === live.editable_runtime_id?.join() &&
            baseline.editable_rect?.join() === live.editable_rect?.join())))
    const allowed = !!(
      same &&
      inside &&
      elementValid &&
      focusValid &&
      observedPointMatches &&
      observedFocusMatches &&
      identityMatches
    )
    if (allowed && !guard) {
      if (this.inputBindings.size > 64) this.inputBindings.clear()
      this.inputBindings.set(bindingKey, live)
    }
    return {
      allowed,
      center,
      screen: [live.screen.x, live.screen.y, live.screen.width, live.screen.height],
      editable_focus: live.editable_focus,
    }
  }
  validate(snapshot: ForegroundObservation, action: ObservationAction) {
    return this.inspectInput(snapshot, action, false)
  }
  async verifyText(snapshot: ForegroundObservation, text: string) {
    const live = await this.metadata(),
      baseline = this.textBaseline.get(snapshot.observation_id)
    const normalize = (value: string) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const same =
      live.window_id === snapshot.window_id &&
      live.process_id === snapshot.process_id &&
      live.editable_focus &&
      baseline?.editable_runtime_id?.join() === live.editable_runtime_id?.join() &&
      baseline?.editable_rect?.join() === live.editable_rect?.join()
    let verified = false
    if (
      same &&
      typeof live.editable_text === 'string' &&
      typeof baseline?.editable_text === 'string'
    ) {
      const before = baseline.editable_text,
        after = normalize(live.editable_text),
        inserted = normalize(text)
      if (Number.isInteger(baseline.selection_start) && Number.isInteger(baseline.selection_end)) {
        verified =
          after ===
          normalize(
            before.slice(0, baseline.selection_start) + text + before.slice(baseline.selection_end),
          )
      } else {
        verified = inserted.length > 0 && after.includes(inserted) && after !== normalize(before)
      }
    }
    // Keep the baseline across transient focus/render delays so a later read can verify
    // the original insertion without sending the text a second time.
    if (verified) this.textBaseline.delete(snapshot.observation_id)
    return {
      verified,
      evidence:
        verified &&
        Number.isInteger(baseline?.selection_start) &&
        Number.isInteger(baseline?.selection_end)
          ? 'exact_insertion'
          : verified
            ? 'text_change'
            : 'none',
      allowed: !!same,
      source: live.editable_source ?? 'uia',
      observation_id: snapshot.observation_id,
    }
  }
  async verifyCurrentText(snapshot: ForegroundObservation, expectedText: string) {
    const live = await this.metadata()
    const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const verified =
      expectedText.length > 0 &&
      live.window_id === snapshot.window_id &&
      live.process_id === snapshot.process_id &&
      live.editable_focus &&
      !!live.editable_runtime_id?.length &&
      typeof live.editable_text === 'string' &&
      normalize(live.editable_text).includes(normalize(expectedText))
    return { verified, source: live.editable_source ?? 'uia' }
  }
  guard(snapshot: ForegroundObservation, action: ObservationAction) {
    return this.inspectInput(snapshot, action, true)
  }
  async verifyControlState(snapshot: ForegroundObservation, raw: unknown) {
    const failed = { verified: false, observable: false, source: 'uia' }
    if (!raw || typeof raw !== 'object') return failed
    const condition = raw as Record<string, unknown>
    const { property, value, center, runtime_id: runtimeId } = condition
    if (
      Object.keys(condition).sort().join() !== 'center,property,runtime_id,value' ||
      (property !== 'checked' && property !== 'selected') ||
      typeof value !== 'boolean' ||
      !Array.isArray(center) ||
      center.length !== 2 ||
      !center.every(Number.isFinite) ||
      !Array.isArray(runtimeId) ||
      !runtimeId.length ||
      !runtimeId.every(Number.isInteger)
    )
      return failed
    const live = await this.metadata(center as number[])
    const target = live.point_target
    if (
      live.window_id !== snapshot.window_id ||
      live.process_id !== snapshot.process_id ||
      live.point_owner !== live.window_id ||
      !target ||
      target.process_id !== snapshot.process_id ||
      !target.enabled ||
      target.runtime_id.join() !== runtimeId.join() ||
      center[0] < target.rect[0] ||
      center[0] >= target.rect[2] ||
      center[1] < target.rect[1] ||
      center[1] >= target.rect[3] ||
      typeof target[property] !== 'boolean'
    )
      return failed
    return {
      verified: target[property] === value,
      observable: true,
      source: target.source ?? 'uia',
    }
  }
  async verifyVisibleText(snapshot: ForegroundObservation, expectedText: string) {
    if (!expectedText.trim() || expectedText.length > 1000)
      return { verified: false, source: 'ocr' }
    const live = await this.metadata()
    if (live.window_id !== snapshot.window_id || live.process_id !== snapshot.process_id)
      return { verified: false, source: 'ocr' }
    const fresh = await this.capture()
    const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const verified =
      !!fresh &&
      fresh.window_id === snapshot.window_id &&
      fresh.process_id === snapshot.process_id &&
      normalize(fresh.ocr_text).includes(normalize(expectedText))
    return { verified, source: 'ocr', observation_id: fresh?.observation_id }
  }
  dispose() {
    const child = this.child
    this.child = undefined
    child?.kill()
    this.pending?.reject(new Error('Windows foreground observer closed'))
    this.pending = undefined
  }
}

interface ObservationOptions {
  capture: (signal?: AbortSignal) => Promise<ForegroundFrame | null>
  recognize: (frame: ForegroundFrame, signal?: AbortSignal) => Promise<ForegroundObservation>
  isOcrBusy: () => boolean
  canObserve: () => boolean
  isInteracting?: () => boolean
  onObservation: (snapshot: ForegroundObservation) => void | Promise<void>
  onInvalidated?: () => void
  onError?: (error: Error) => void
  intervalMs?: number
  stableMs?: number
  minOcrIntervalMs?: number
  now?: () => number
}
/** Latest-only passive loop. Explicit observations bypass debounce, never the OCR mutex. */
export class ForegroundObservationService {
  private timer?: ReturnType<typeof setTimeout>
  private pauses = new Set<string>()
  private abort?: AbortController
  private fingerprint = ''
  private targetIdentity = ''
  private processedFingerprint = ''
  private stableSince = 0
  private emitted = ''
  private emittedObservationId?: string
  private lastContentHash = ''
  private retryCount = 0
  private retryAfter = 0
  private running = false
  private busy = false
  private lastOcrAt = -Infinity
  constructor(private options: ObservationOptions) {}
  start() {
    if (this.running) return
    this.running = true
    this.schedule()
  }
  pause(reason = 'user') {
    if (this.pauses.has(reason)) return
    this.pauses.add(reason)
    this.abort?.abort()
    this.invalidate()
  }
  resume(reason = 'user') {
    this.pauses.delete(reason)
  }
  get paused() {
    return this.pauses.size > 0
  }
  get isWorking() {
    return this.busy
  }
  invalidate() {
    this.emitted = ''
    this.emittedObservationId = undefined
    this.retryCount = 0
    this.retryAfter = 0
    this.options.onInvalidated?.()
  }
  retryObservation(observationId: string) {
    if (observationId !== this.emittedObservationId || this.retryCount >= 3) return
    this.retryAfter = (this.options.now?.() ?? Date.now()) + 5000 * 2 ** this.retryCount
    this.retryCount += 1
    this.emitted = ''
  }
  private schedule() {
    if (this.running)
      this.timer = setTimeout(
        () => void this.tick().finally(() => this.schedule()),
        this.options.intervalMs ?? 500,
      )
  }
  private async tick() {
    if (this.busy || this.paused || !this.options.canObserve() || this.options.isOcrBusy()) return
    this.busy = true
    this.abort = new AbortController()
    try {
      const frame = await this.options.capture(this.abort.signal)
      if (!frame || this.abort.signal.aborted) return
      const now = this.options.now?.() ?? Date.now()
      const identity = `${frame.process_id}:${frame.window_id}:${frame.window_rect.join()}`
      if (identity !== this.targetIdentity) {
        this.targetIdentity = identity
        this.invalidate()
      }
      if (this.options.isInteracting?.()) {
        // The island changes its own mask while hovered or edited. Continue
        // checking the target, then compare page text once that mask settles.
        this.fingerprint = frame.fingerprint
        this.stableSince = now
        return
      }
      if (frame.fingerprint !== this.fingerprint) {
        this.fingerprint = frame.fingerprint
        this.stableSince = now
        // A caret, hover, or our own overlay can change pixels without changing
        // the page. Keep the recommendation until OCR confirms new content.
        return
      }
      if (now < this.retryAfter) return
      if (frame.fingerprint === this.processedFingerprint && now - this.lastOcrAt < 5000) return
      if (now - this.stableSince < (this.options.stableMs ?? 800)) return
      if (now - this.lastOcrAt < (this.options.minOcrIntervalMs ?? 1500)) return
      this.lastOcrAt = now
      const snapshot = await this.options.recognize(frame, this.abort.signal)
      if (this.options.isInteracting?.()) {
        this.stableSince = this.options.now?.() ?? Date.now()
        return
      }
      this.processedFingerprint = frame.fingerprint
      if (
        this.abort.signal.aborted ||
        this.paused ||
        !this.options.canObserve() ||
        snapshot.content_hash === this.emitted
      )
        return
      if (snapshot.content_hash !== this.lastContentHash) this.invalidate()
      this.lastContentHash = snapshot.content_hash
      this.emitted = snapshot.content_hash
      this.emittedObservationId = snapshot.observation_id
      await this.options.onObservation(snapshot)
    } catch (error) {
      if (!this.abort.signal.aborted) {
        if (this.emittedObservationId) this.retryObservation(this.emittedObservationId)
        this.options.onError?.(error instanceof Error ? error : new Error('Observation failed'))
      }
    } finally {
      this.busy = false
      this.abort = undefined
    }
  }
  async observeNow(timeoutMs = 10000): Promise<ForegroundObservation | null> {
    this.abort?.abort()
    const deadline = Date.now() + timeoutMs
    while (this.busy || this.options.isOcrBusy()) {
      if (Date.now() >= deadline) throw new Error('OCR is still occupied; observation timed out')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (this.paused || !this.options.canObserve()) return null
    this.busy = true
    this.abort = new AbortController()
    try {
      const frame = await this.options.capture(this.abort.signal)
      return frame ? await this.options.recognize(frame, this.abort.signal) : null
    } finally {
      this.busy = false
      this.abort = undefined
    }
  }
  dispose() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.abort?.abort()
    this.invalidate()
  }
}
