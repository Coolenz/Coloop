// Isolated WinForms target for observation/HID integration tests; no network or user files.
using System;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Windows.Forms;

class AgentLab : Form {
    readonly TextBox input = new TextBox();
    readonly Label status = new Label();
    readonly string folder;
    int clicks;
    readonly string code;
    bool closed;
    bool applied;
    readonly DateTime started = DateTime.UtcNow;

    AgentLab(string destination) {
        var serializer = new JavaScriptSerializer();
        var config = File.Exists(destination) ? serializer.Deserialize<System.Collections.Generic.Dictionary<string, string>>(File.ReadAllText(destination)) : null;
        folder = Path.GetFullPath(config == null ? destination : config["folder"]);
        Directory.CreateDirectory(folder);
        byte[] random = new byte[4];
        using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(random);
        code = config == null ? BitConverter.ToString(random).Replace("-", "").ToLowerInvariant() : config["code"];
        Text = config == null ? "RK Agent Lab" : config["title"];
        ClientSize = new Size(640, 290);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 12);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        var heading = new Label { Text = "Local USB agent test", Left = 28, Top = 24, Width = 560 };
        var challenge = new Label { Text = "Code: " + code, Left = 28, Top = 65, Width = 560,
                                    AccessibleName = "Code: " + code };
        challenge.Font = new Font("Segoe UI", 16);
        challenge.Height = 35;
        input.SetBounds(28, 110, 440, 35);
        input.AccessibleName = "Input";
        input.Name = "Input";
        var apply = new Button { Text = "Apply", Left = 485, Top = 108, Width = 125, Height = 38,
                                 AccessibleName = "Apply" };
        status.SetBounds(28, 177, 580, 70);
        status.Text = "Ready";
        status.AccessibleName = "Ready";
        apply.Click += delegate {
            clicks++;
            applied = true;
            status.Text = "Applied: " + input.Text;
            status.AccessibleName = status.Text;
            Write("lab-result.json", new { value = input.Text, clicks = clicks, code_matches = input.Text == code });
            SaveState("applied");
        };
        Controls.AddRange(new Control[] { heading, challenge, input, apply, status });
        Write("lab-expected.json", new { code = code });
        Shown += delegate { input.Focus(); SaveState("ready"); };
        FormClosed += delegate { closed = true; SaveState("closed"); };
    }

    void SaveState(string name) {
        var state = new { title = Text, pid = System.Diagnostics.Process.GetCurrentProcess().Id,
                          started_utc = started.ToString("o"), at_utc = DateTime.UtcNow.ToString("o"),
                          applied = applied, closed = closed, value = input.Text,
                          clicks = clicks, code_matches = input.Text == code };
        Write("fixture-state.json", state);
        File.AppendAllText(Path.Combine(folder, "fixture-events.jsonl"),
            new JavaScriptSerializer().Serialize(new { name = name, at_utc = DateTime.UtcNow.ToString("o"), state = state }) + Environment.NewLine);
    }

    void Write(string filename, object value) {
        string path = Path.Combine(folder, filename);
        string temporary = path + ".tmp";
        File.WriteAllText(temporary, new JavaScriptSerializer().Serialize(value));
        if (File.Exists(path)) File.Replace(temporary, path, null);
        else File.Move(temporary, path);
    }

    [STAThread]
    static void Main(string[] args) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new AgentLab(args.Length > 0 ? args[0] : ".runtime"));
    }
}
