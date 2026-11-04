// Dedicated hardware-HID form fixture. No software input or clipboard APIs.
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

class HIDFormLab : Form {
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    readonly string folder;
    readonly string code = "FORM_" + Guid.NewGuid().ToString("N").Substring(0, 12);
    readonly TextBox text = new TextBox();
    readonly TextBox number = new TextBox();
    readonly Label status = new Label();
    readonly Timer timer = new Timer();
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly bool noActivate;
    int clicks, seq;
    bool closed;

    protected override bool ShowWithoutActivation { get { return noActivate; } }

    HIDFormLab(string path, bool passive) {
        folder = path;
        noActivate = passive;
        TopMost = passive;
        Text = "RK HID Form " + Path.GetFileName(folder);
        ClientSize = new Size(760, 320);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        Font = new Font("Segoe UI", 12);
        KeyPreview = true;
        var label = new Label { Text = "Code: " + code, AccessibleName = "Code: " + code,
                                Left = 24, Top = 20, Width = 700, Height = 35 };
        text.SetBounds(145, 80, 570, 35);
        text.AccessibleName = "Text"; text.Text = "old text";
        number.SetBounds(145, 135, 570, 35);
        number.AccessibleName = "Number"; number.Text = "999";
        var apply = new Button { Text = "Apply", AccessibleName = "Apply", Left = 590,
                                 Top = 190, Width = 125, Height = 38 };
        status.SetBounds(24, 245, 690, 55);
        status.Text = "Ready"; status.AccessibleName = "Ready";
        apply.Click += delegate {
            clicks++;
            status.Text = "Applied: " + code; status.AccessibleName = status.Text;
            Event("applied", new { text = text.Text, number = number.Text, code = code }); Save();
        };
        text.TextChanged += delegate { Event("text", new { value = text.Text }); Save(); };
        number.TextChanged += delegate { Event("number", new { value = number.Text }); Save(); };
        KeyDown += (s, e) => Event("key_down", new { key = e.KeyCode.ToString(), modifiers = e.Modifiers.ToString() });
        KeyUp += (s, e) => Event("key_up", new { key = e.KeyCode.ToString() });
        foreach (Control control in new Control[] { text, number, apply }) {
            string name = control.AccessibleName;
            control.MouseDown += (s, e) => Event("mouse_down", new { target = name, button = e.Button.ToString() });
            control.MouseUp += (s, e) => Event("mouse_up", new { target = name, button = e.Button.ToString() });
        }
        Controls.AddRange(new Control[] { label, text, number, apply, status,
            new Label { Text = "Text", Left = 24, Top = 84, Width = 100 },
            new Label { Text = "Number", Left = 24, Top = 139, Width = 100 } });
        timer.Interval = 100; timer.Tick += delegate { Save(); };
        Activated += delegate { Event("activated", new { via = "window_event" }); };
        Shown += delegate {
            if (!noActivate) { text.Focus(); Activate(); }
            Event("prepared", new { activation_by_fixture = !noActivate });
            Save(); timer.Start();
        };
        FormClosed += delegate { closed = true; timer.Stop(); Save(); };
    }
    void Event(string name, object data) {
        File.AppendAllText(Path.Combine(folder, "events.jsonl"), json.Serialize(new {
            seq = ++seq, name = name, data = data, at = DateTime.UtcNow.ToString("o")
        }) + Environment.NewLine);
    }
    void Save() {
        var data = new { title = Text, pid = System.Diagnostics.Process.GetCurrentProcess().Id,
            text = text.Text, number = number.Text, code = code, status = status.Text,
            clicks = clicks, closed = closed,
            buttons_down = new bool[] { GetAsyncKeyState(1) < 0, GetAsyncKeyState(2) < 0, GetAsyncKeyState(4) < 0 },
            modifiers_down = new bool[] { GetAsyncKeyState(16) < 0, GetAsyncKeyState(17) < 0,
                                        GetAsyncKeyState(18) < 0, GetAsyncKeyState(91) < 0 }, dpi = DeviceDpi };
        string target = Path.Combine(folder, "state.json"), temporary = target + ".tmp";
        File.WriteAllText(temporary, json.Serialize(data));
        if (File.Exists(target)) File.Replace(temporary, target, null);
        else File.Move(temporary, target);
    }
    [STAThread] static void Main(string[] args) {
        SetProcessDPIAware(); Application.EnableVisualStyles();
        Application.Run(new HIDFormLab(Path.GetFullPath(args[0]),
            args.Length > 1 && args[1] == "--no-activate"));
    }
}
