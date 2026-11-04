// Isolated native UI acceptance fixture. Receives no control commands or model results.
// Build: csc /target:winexe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public sealed class ScrollProbeTextBox : TextBox {
    public event EventHandler NativeScrolled;
    protected override void WndProc(ref Message message) {
        int id = message.Msg;
        base.WndProc(ref message);
        if (id == 0x20a || id == 0x115) {
            EventHandler handler = NativeScrolled;
            if (handler != null) handler(this, EventArgs.Empty);
        }
    }
}

public sealed class ActionTaskLab : Form {
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr handle, int message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern int GetClassName(IntPtr handle, StringBuilder name, int count);
    readonly string folder, taskId;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly List<Dictionary<string, object>> events = new List<Dictionary<string, object>>();
    readonly Label result = new Label();
    readonly Timer sampler = new Timer();
    CheckBox check;
    ListBox doubleTarget;
    Button hoverTarget;
    ScrollProbeTextBox scroll;
    TextBox fieldA, fieldB;
    RichTextBox revision;
    int sequence, mouseDownCount, mouseUpCount, clickCount, doubleClickCount, enterCount, hoverCount, wheelCount;
    bool started;
    bool pointerInsideOnShown;
    int initialEnterCount, initialMouseDownCount;
    string lastSample = "";

    public ActionTaskLab(string directory, string task, string title) {
        folder = Path.GetFullPath(directory); taskId = task;
        Directory.CreateDirectory(folder);
        Text = title; Width = 860; Height = 650; StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 12); AutoScaleMode = AutoScaleMode.Dpi;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 1, RowCount = 3 };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 60));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 70));
        layout.Controls.Add(new Label { Text = Heading(task), Dock = DockStyle.Fill, AutoSize = false }, 0, 0);
        var body = new Panel { Dock = DockStyle.Fill };
        layout.Controls.Add(body, 0, 1);
        result.Dock = DockStyle.Fill; result.AccessibleName = "Actual task result"; result.AutoSize = false;
        layout.Controls.Add(result, 0, 2); Controls.Add(layout);
        BuildTask(body);
        sampler.Interval = 100; sampler.Tick += delegate { Sample(); };
        Shown += delegate {
            pointerInsideOnShown = hoverTarget != null && hoverTarget.RectangleToScreen(hoverTarget.ClientRectangle).Contains(Cursor.Position);
            initialEnterCount = enterCount; initialMouseDownCount = mouseDownCount;
            started = true;
            Control focus = (Control)fieldA ?? revision ?? (Control)scroll ?? check ?? (Control)doubleTarget ?? hoverTarget;
            if (focus != null) focus.Focus();
            Record("shown", "window", null); sampler.Start(); WriteIdentity(); Save();
        };
        FormClosing += delegate { sampler.Stop(); Record("closing", "window", null); Save(); };
    }

    static string Heading(string task) {
        switch (task) {
            case "checkbox": return "Toggle the notification checkbox";
            case "double_click": return "Double-click the named list item";
            case "hover": return "Move the mouse onto the hover target";
            case "scroll": return "Scroll list - reach the final row";
            case "two_fields": return "Update the two separate notes";
            case "replace_undo_redo": return "Revision editor - replace, undo, then redo";
            default: throw new ArgumentException("Unknown task id");
        }
    }

    void BuildTask(Panel body) {
        if (taskId == "checkbox") {
            check = new CheckBox { Text = "Enable feature", AccessibleName = "Enable feature", AutoSize = false, Width = 420, Height = 60, Location = new Point(20, 35) };
            check.CheckedChanged += delegate { Record("checked_changed", "notification_checkbox", check.Checked); RefreshResult(); Save(); };
            HookMouse(check, "notification_checkbox"); body.Controls.Add(check);
        } else if (taskId == "double_click") {
            doubleTarget = new ListBox { AccessibleName = "Double click list", Width = 540, Height = 125, Location = new Point(20, 35), IntegralHeight = false, Font = new Font("Microsoft YaHei UI", 16) };
            doubleTarget.Items.Add("Double click target");
            doubleTarget.MouseDoubleClick += delegate(object sender, MouseEventArgs e) {
                if (doubleTarget.IndexFromPoint(e.Location) == 0) { doubleClickCount++; Record("mouse_double_click", "double_click_item", doubleClickCount); RefreshResult(); Save(); }
            };
            HookMouse(doubleTarget, "double_click_item"); body.Controls.Add(doubleTarget);
        } else if (taskId == "hover") {
            hoverTarget = new Button { Text = "Hover target", AccessibleName = "Hover target", Width = 460, Height = 95, Location = new Point(270, 190) };
            hoverTarget.MouseEnter += delegate { enterCount++; Record("mouse_enter", "hover_target", enterCount); RefreshResult(); Save(); };
            hoverTarget.MouseHover += delegate { hoverCount++; Record("mouse_hover", "hover_target", hoverCount); RefreshResult(); Save(); };
            HookMouse(hoverTarget, "hover_target"); body.Controls.Add(hoverTarget);
        } else if (taskId == "scroll") {
            scroll = new ScrollProbeTextBox { AccessibleName = "Scroll list", Name = "ScrollableDocument", Multiline = true, AcceptsReturn = true, ScrollBars = ScrollBars.Vertical, WordWrap = false, Dock = DockStyle.Fill };
            var lines = new List<string>(); lines.Add("TOP_MARKER - beginning of document");
            for (int i = 1; i <= 100; i++) lines.Add("Document line " + i.ToString("D3") + " - scroll to find the bottom marker");
            lines.Add("BOTTOM_MARKER - end of document"); scroll.Lines = lines.ToArray();
            scroll.NativeScrolled += delegate { wheelCount++; Record("native_scroll", "scroll_document", FirstVisibleLine()); RefreshResult(); Save(); };
            HookMouse(scroll, "scroll_document"); body.Controls.Add(scroll);
        } else if (taskId == "two_fields") {
            var fields = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 4, ColumnCount = 1 };
            fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 35)); fields.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
            fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 35)); fields.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
            fieldA = MakeField("Field A", "项目：Coloop\r\n计划：旧版本\r\n备注：保留这一行");
            fieldB = MakeField("Field B", "收件人：测试团队\r\n状态：待更新");
            fields.Controls.Add(new Label { Text = "Field A", Dock = DockStyle.Fill }, 0, 0); fields.Controls.Add(fieldA, 0, 1);
            fields.Controls.Add(new Label { Text = "Field B", Dock = DockStyle.Fill }, 0, 2); fields.Controls.Add(fieldB, 0, 3);
            HookEditor(fieldA, "field_a"); HookEditor(fieldB, "field_b"); body.Controls.Add(fields);
        } else {
            revision = new RichTextBox { AccessibleName = "Revision editor", Name = "RevisionEditor", Dock = DockStyle.Fill, DetectUrls = false, Text = "Original revision" };
            revision.Select(0, revision.TextLength);
            revision.TextChanged += delegate { Record("text_changed", "revision", revision.Text); RefreshResult(); Save(); };
            revision.SelectionChanged += delegate { if (started) { Record("selection_changed", "revision", Selection(revision)); Save(); } };
            revision.KeyDown += delegate(object sender, KeyEventArgs e) { if (e.Control && (e.KeyCode == Keys.Z || e.KeyCode == Keys.Y)) Record(e.KeyCode == Keys.Z ? "undo_keydown" : "redo_keydown", "revision", revision.Text); };
            revision.KeyUp += delegate(object sender, KeyEventArgs e) { if (e.KeyCode == Keys.Z || e.KeyCode == Keys.Y) { Record(e.KeyCode == Keys.Z ? "undo_keyup" : "redo_keyup", "revision", revision.Text); Save(); } };
            HookMouse(revision, "revision"); body.Controls.Add(revision);
        }
        RefreshResult();
    }

    static TextBox MakeField(string name, string text) { return new TextBox { AccessibleName = name, Name = name, Text = text, Multiline = true, AcceptsReturn = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill }; }
    void HookEditor(TextBox editor, string name) {
        editor.TextChanged += delegate { Record("text_changed", name, editor.Text); RefreshResult(); Save(); };
        editor.KeyUp += delegate { Record("key_up", name, Selection(editor)); Save(); };
        HookMouse(editor, name);
    }
    void HookMouse(Control control, string name) {
        control.MouseDown += delegate(object sender, MouseEventArgs e) { mouseDownCount++; Record("mouse_down", name, new { x = e.X, y = e.Y, clicks = e.Clicks, button = e.Button.ToString() }); Save(); };
        control.MouseUp += delegate(object sender, MouseEventArgs e) { mouseUpCount++; Record("mouse_up", name, new { x = e.X, y = e.Y, clicks = e.Clicks, button = e.Button.ToString() }); Save(); };
        control.Click += delegate { clickCount++; Record("click", name, clickCount); Save(); };
    }
    static Dictionary<string, object> Selection(TextBoxBase editor) { return new Dictionary<string, object> { { "start", editor.SelectionStart }, { "length", editor.SelectionLength } }; }
    int FirstVisibleLine() { return scroll == null ? 0 : SendMessage(scroll.Handle, 0xCE, IntPtr.Zero, IntPtr.Zero).ToInt32(); }
    int LastVisibleLine() {
        if (scroll == null) return 0;
        int character = scroll.GetCharIndexFromPosition(new Point(Math.Max(0, scroll.ClientSize.Width - 22), Math.Max(0, scroll.ClientSize.Height - 4)));
        return scroll.GetLineFromCharIndex(character);
    }
    Dictionary<string, object> ScrollState() { int first = FirstVisibleLine(), last = LastVisibleLine(), count = scroll == null ? 0 : scroll.Lines.Length; return new Dictionary<string, object> { { "first_visible_line", first }, { "last_visible_line", last }, { "line_count", count }, { "top_visible", first == 0 }, { "bottom_visible", count > 0 && last >= count - 1 }, { "native_scroll_count", wheelCount } }; }
    void RefreshResult() {
        if (check != null) result.Text = check.Checked ? "Feature enabled" : "Feature disabled";
        else if (doubleTarget != null) result.Text = (doubleClickCount > 0 ? "Double click verified" : "Double click pending") + "\nDouble clicks: " + doubleClickCount;
        else if (hoverTarget != null) result.Text = (enterCount > 0 ? "Hover verified" : "Hover pending") + "\nMouse entries: " + enterCount + " / Mouse downs: " + mouseDownCount;
        else if (scroll != null) result.Text = (FirstVisibleLine() == 0 ? "Document at start" : ((bool)ScrollState()["bottom_visible"] ? "Bottom reached" : "Document scrolling")) + "\nFirst visible line: " + FirstVisibleLine();
        else if (fieldA != null) result.Text = fieldA.Modified && fieldB.Modified ? "Both notes updated" : fieldA.Modified ? "First note updated" : fieldB.Modified ? "Second note updated" : "Notes unchanged";
        else if (revision != null) result.Text = revision.Text == "Original revision" ? "Revision original" : "Revision changed";
    }
    void Record(string type, string control, object value) {
        if (!started) return;
        events.Add(new Dictionary<string, object> { { "seq", ++sequence }, { "type", type }, { "control", control }, { "timestamp", DateTime.UtcNow.ToString("o") }, { "value", value } });
        if (events.Count > 512) events.RemoveAt(0);
    }
    void Sample() {
        string current = json.Serialize(new { a = fieldA == null ? null : Selection(fieldA), b = fieldB == null ? null : Selection(fieldB), revision = revision == null ? null : Selection(revision), scroll = ScrollState() });
        if (current != lastSample) { lastSample = current; Record("sample_changed", "window", null); RefreshResult(); Save(); }
    }
    static string NativeClass(Control control) { if (control == null) return null; var buffer = new StringBuilder(256); GetClassName(control.Handle, buffer, buffer.Capacity); return buffer.ToString(); }
    void WriteIdentity() { AtomicWrite("identity.json", json.Serialize(new { pid = System.Diagnostics.Process.GetCurrentProcess().Id, window_id = Handle.ToInt64().ToString(), task_id = taskId, title = Text })); }
    void Save() {
        if (!started) return;
        var fields = new { a = fieldA == null ? null : fieldA.Text, b = fieldB == null ? null : fieldB.Text, revision = revision == null ? null : revision.Text };
        var selection = new { a = fieldA == null ? null : Selection(fieldA), b = fieldB == null ? null : Selection(fieldB), revision = revision == null ? null : Selection(revision) };
        AtomicWrite("state.json", json.Serialize(new { version = 1, task_id = taskId, sequence, pointer_inside_on_shown = pointerInsideOnShown, initial_mouse_enter_count = initialEnterCount, initial_mouse_down_count = initialMouseDownCount, mouse_down_count = mouseDownCount, mouse_up_count = mouseUpCount, click_count = clickCount, doubleclick_count = doubleClickCount, mouse_enter_count = enterCount, mouse_hover_count = hoverCount, @checked = check != null && check.Checked, scroll = ScrollState(), fields, selection, visible_result = result.Text, native_classes = new { a = NativeClass(fieldA), b = NativeClass(fieldB), revision = NativeClass(revision), scroll = NativeClass(scroll), checkbox = NativeClass(check), double_click = NativeClass(doubleTarget), hover = NativeClass(hoverTarget) }, events }));
    }
    void AtomicWrite(string name, string content) {
        string destination = Path.Combine(folder, name), temporary = destination + ".pending";
        byte[] bytes = new UTF8Encoding(false).GetBytes(content);
        using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
        if (File.Exists(destination)) File.Replace(temporary, destination, null); else File.Move(temporary, destination);
    }
    [STAThread] public static void Main(string[] args) {
        if (args.Length != 3) throw new ArgumentException("output_dir task_id unique_title required");
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new ActionTaskLab(args[0], args[1], args[2]));
    }
}



