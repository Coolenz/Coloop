// Read-only, bounded FlaUI UIA3 observation. No input, invocation, focus or value-setting APIs.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;

class ColoopAutoWorkUia {
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 2097152 };
  static int revision = 0;
  static string Text(string value, int limit) { return value == null ? "" : value.Length > limit ? value.Substring(0, limit) : value; }
  static void Print(object value) { Console.WriteLine(Json.Serialize(value)); }
  static bool Target(IntPtr hwnd, uint expected) { uint actual; GetWindowThreadProcessId(hwnd, out actual); return IsWindow(hwnd) && actual == expected; }
  static object Snapshot(UIA3Automation automation, IntPtr hwnd, uint expected) {
    if (!Target(hwnd, expected)) throw new Exception("TARGET_CHANGED");
    var window = automation.FromHandle(hwnd);
    var queue = new Queue<AutomationElement>(); queue.Enqueue(window);
    var nodes = new List<object>(); var drafts = new List<object>(); var messages = new List<string>();
    var walker = automation.TreeWalkerFactory.GetControlViewWalker();
    var elapsed = Stopwatch.StartNew(); int count = 0; int readErrors = 0; int textBudget = 65536;
    while (queue.Count > 0 && count < 1000 && elapsed.ElapsedMilliseconds < 3500) {
      var element = queue.Dequeue(); count++;
      try {
        if (element.Properties.IsPassword.ValueOrDefault) continue;
        var controlType = element.Properties.ControlType.ValueOrDefault;
        string kind = controlType.ToString(); string name = Text(element.Properties.Name.ValueOrDefault, 1200);
        string value = "";
        if (controlType == ControlType.Edit && element.Patterns.Value.IsSupported)
          value = Text(element.Patterns.Value.Pattern.Value.ValueOrDefault, 8192);
        if (controlType == ControlType.Document && element.Patterns.Text.IsSupported)
          value = Text(element.Patterns.Text.Pattern.DocumentRange.GetText(8192), 8192);
        name = Text(name, Math.Max(0, Math.Min(1200, textBudget))); textBudget -= name.Length;
        value = Text(value, Math.Max(0, Math.Min(8192, textBudget))); textBudget -= value.Length;
        var bounds = element.BoundingRectangle;
        bool offscreen = element.Properties.IsOffscreen.ValueOrDefault;
        var node = new { type=kind, name=name, value=value, automationId=Text(element.Properties.AutomationId.ValueOrDefault, 256),
          focused=element.Properties.HasKeyboardFocus.ValueOrDefault, offscreen=offscreen,
          bounds=new { x=bounds.X, y=bounds.Y, width=bounds.Width, height=bounds.Height } };
        nodes.Add(node);
        if (controlType == ControlType.Edit && !offscreen) drafts.Add(node);
        if ((controlType == ControlType.Text || controlType == ControlType.Document) && !offscreen)
          messages.Add(Text(value.Length > 0 ? value : name, 8192));
      } catch { readErrors++; }
      try {
        var child = walker.GetFirstChild(element); int siblings = 0;
        while (child != null && queue.Count + count < 1100 && siblings++ < 1000) { queue.Enqueue(child); child = walker.GetNextSibling(child); }
      } catch { readErrors++; }
    }
    if (!Target(hwnd, expected)) throw new Exception("TARGET_CHANGED");
    return new { version=1, source="flaui-uia3", pid=expected, hwnd=hwnd.ToInt64().ToString(),
      title=Text(window.Name, 2000), revision=Interlocked.Increment(ref revision),
      capturedAt=DateTime.UtcNow.ToString("o"), complete=queue.Count == 0 && readErrors == 0 && textBudget > 0, readErrors=readErrors, nodes=nodes, drafts=drafts, messages=messages,
      identityVerified=false };
  }
  [STAThread] static int Main(string[] args) {
    Console.OutputEncoding = new System.Text.UTF8Encoding(false);
    try {
      using (var automation = new UIA3Automation()) {
        automation.TransactionTimeout = TimeSpan.FromMilliseconds(500);
        automation.ConnectionTimeout = TimeSpan.FromMilliseconds(500);
        if (args.Length == 1 && args[0] == "--probe") {
          Print(new { ready=true, backend="FlaUI.UIA3", version=typeof(UIA3Automation).Assembly.GetName().Version.ToString(), readOnly=true }); return 0;
        }
        if (args.Length != 6 || args[0] != "--pid" || args[2] != "--hwnd" || args[4] != "--watch-ms") throw new Exception("INVALID_ARGUMENTS");
        uint pid; long handle; int duration;
        if (!uint.TryParse(args[1], out pid) || pid == 0 || !long.TryParse(args[3], out handle) || handle == 0 ||
            !int.TryParse(args[5], out duration) || duration < 0 || duration > 30000) throw new Exception("INVALID_ARGUMENTS");
        var hwnd = new IntPtr(handle);
        if (!Target(hwnd, pid)) throw new Exception("TARGET_CHANGED");
        int dirty = 0;
        var selected = automation.FromHandle(hwnd);
        selected.RegisterStructureChangedEvent(TreeScope.Subtree, delegate(AutomationElement element, StructureChangeType change, int[] runtimeId) {
          Interlocked.Exchange(ref dirty, 1);
        });
        selected.RegisterPropertyChangedEvent(TreeScope.Subtree, delegate(AutomationElement element, FlaUI.Core.Identifiers.PropertyId property, object value) {
          Interlocked.Exchange(ref dirty, 1);
        }, automation.PropertyLibrary.Element.Name, automation.PropertyLibrary.Element.HasKeyboardFocus,
          automation.PropertyLibrary.Value.Value);
        // Global focus callback is filtered to the selected process; it only requests a fresh read.
        var focus = automation.RegisterFocusChangedEvent(delegate(AutomationElement element) {
          try { if (element.Properties.ProcessId.ValueOrDefault == pid) Interlocked.Exchange(ref dirty, 1); } catch { }
        });
        Print(Snapshot(automation, hwnd, pid));
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < duration) {
          Thread.Sleep(100);
          if (Interlocked.Exchange(ref dirty, 0) != 0) Print(Snapshot(automation, hwnd, pid));
        }
        automation.UnregisterFocusChangedEvent(focus);
      }
      return 0;
    } catch (Exception error) { Print(new { ready=false, error=error.Message, readOnly=true }); return 1; }
  }
}
