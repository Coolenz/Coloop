// Dedicated software-input fixture. Opens only the generated JSON-in-text test document.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Web.Script.Serialization;
using System.Windows.Forms;

class WindowsDesktopLab : Form {
    readonly TextBox text = new TextBox();
    readonly TextBox number = new TextBox();
    readonly Label status = new Label();
    readonly string folder;
    readonly string nonce;
    int clicks;
    WindowsDesktopLab(string file) {
        var config = new JavaScriptSerializer().Deserialize<Dictionary<string, string>>(
            File.ReadAllText(file, System.Text.Encoding.UTF8));
        folder = config["folder"];
        nonce = config["nonce"];
        Text = config["title"];
        ClientSize = new Size(760, 320);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 12);
        var code = new Label { Text = "File code: " + nonce, AccessibleName = "File code: " + nonce,
                              Left = 24, Top = 20, Width = 700, Height = 35 };
        text.SetBounds(145, 80, 570, 35);
        text.AccessibleName = "Text";
        text.Text = "old text";
        number.SetBounds(145, 135, 570, 35);
        number.AccessibleName = "Number";
        number.Text = "999";
        var apply = new Button { Text = "Apply", AccessibleName = "Apply", Left = 590,
                                 Top = 190, Width = 125, Height = 38 };
        status.SetBounds(24, 245, 690, 55);
        status.Text = "Ready";
        status.AccessibleName = "Ready";
        apply.Click += delegate {
            clicks++;
            status.Text = "Applied: " + nonce;
            status.AccessibleName = status.Text;
            Save("applied");
        };
        Controls.AddRange(new Control[] { code, text, number, apply, status,
            new Label { Text = "Text", Left = 24, Top = 84, Width = 100 },
            new Label { Text = "Number", Left = 24, Top = 139, Width = 100 } });
        Shown += delegate { text.Focus(); Save("opened"); };
        FormClosed += delegate { Save("closed"); };
    }
    void Save(string state) {
        var result = new { state = state, title = Text, nonce = nonce, text = text.Text,
                           number = number.Text, clicks = clicks,
                           pid = System.Diagnostics.Process.GetCurrentProcess().Id };
        File.WriteAllText(Path.Combine(folder, "lab-result.json"),
                          new JavaScriptSerializer().Serialize(result));
    }
    [STAThread]
    static void Main(string[] args) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new WindowsDesktopLab(args[0]));
    }
}
