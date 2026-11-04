// Isolated, instrumented target. All tested input arrives through USB HID.
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

class PointerPad : Control {
    public PointerPad() {
        SetStyle(ControlStyles.StandardClick | ControlStyles.StandardDoubleClick |
                 ControlStyles.Selectable, true);
        AccessibleRole = AccessibleRole.PushButton;
        AccessibleName = "Pointer pad";
        Text = "Pointer pad";
        BackColor = Color.LightSteelBlue;
        TabStop = true;
    }
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);
        e.Graphics.DrawString("Pointer pad: drag from left to right", Font, Brushes.Black, 12, 12);
    }
    protected override void OnMouseDown(MouseEventArgs e) {
        Focus(); Capture = true; base.OnMouseDown(e);
    }
    protected override void OnMouseUp(MouseEventArgs e) {
        base.OnMouseUp(e); Capture = false;
    }
}

class HIDLab : Form {
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    readonly string folder;
    readonly TextBox input = new TextBox();
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly Timer timer = new Timer();
    bool closed;
    int seq;

    HIDLab(string path) {
        folder = path;
        Text = "RK HID Lab " + Path.GetFileName(Path.GetDirectoryName(folder)) + "/" + Path.GetFileName(folder);
        ClientSize = new Size(720, 460);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        KeyPreview = true;
        input.SetBounds(20, 25, 680, 110);
        input.Multiline = true; input.AcceptsReturn = true; input.AcceptsTab = true;
        input.AccessibleName = "Literal input";
        var pad = new PointerPad { Left = 20, Top = 170, Width = 680, Height = 260 };
        Controls.AddRange(new Control[] { input, pad });
        input.TextChanged += delegate { Event("text", new { value = input.Text }); Save(); };
        KeyDown += (s, e) => Event("key_down", new { key = e.KeyCode.ToString(), modifiers = e.Modifiers.ToString() });
        KeyUp += (s, e) => Event("key_up", new { key = e.KeyCode.ToString() });
        pad.MouseDown += (s, e) => Event("mouse_down", Mouse(e));
        pad.MouseUp += (s, e) => Event("mouse_up", Mouse(e));
        pad.MouseDoubleClick += (s, e) => Event("double_click", Mouse(e));
        pad.MouseMove += (s, e) => Event("mouse_move", Mouse(e));
        pad.MouseWheel += (s, e) => Event("wheel", Mouse(e));
        timer.Interval = 100;
        timer.Tick += delegate { Save(); };
        Shown += delegate { input.Focus(); Activate(); Save(); timer.Start(); };
        FormClosed += delegate { closed = true; timer.Stop(); Save(); };
    }
    object Mouse(MouseEventArgs e) {
        return new { x = e.X, y = e.Y, button = e.Button.ToString(), delta = e.Delta, clicks = e.Clicks };
    }
    void Event(string name, object data) {
        File.AppendAllText(Path.Combine(folder, "events.jsonl"), json.Serialize(new {
            seq = ++seq, name = name, data = data, at = DateTime.UtcNow.ToString("o")
        }) + Environment.NewLine);
    }
    void Save() {
        var point = Cursor.Position;
        var data = new { title = Text, pid = System.Diagnostics.Process.GetCurrentProcess().Id,
            value = input.Text, closed = closed, cursor = new int[] { point.X, point.Y },
            buttons_down = new bool[] { GetAsyncKeyState(1) < 0, GetAsyncKeyState(2) < 0, GetAsyncKeyState(4) < 0 },
            modifiers_down = new bool[] { GetAsyncKeyState(16) < 0, GetAsyncKeyState(17) < 0,
                                        GetAsyncKeyState(18) < 0, GetAsyncKeyState(91) < 0 },
            dpi = DeviceDpi };
        string target = Path.Combine(folder, "state.json"), temporary = target + ".tmp";
        File.WriteAllText(temporary, json.Serialize(data));
        if (File.Exists(target)) File.Replace(temporary, target, null);
        else File.Move(temporary, target);
    }
    [STAThread] static void Main(string[] args) {
        SetProcessDPIAware();
        Application.EnableVisualStyles();
        Application.Run(new HIDLab(Path.GetFullPath(args[0])));
    }
}
