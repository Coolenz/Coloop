// Native isolated acceptance target. TextChanged writes actual contents, not model assertions.
using System;
using System.IO;
using System.Text;
using System.Windows.Forms;

public class ProactiveTextLab : Form {
    readonly TextBox editor = new TextBox();
    readonly string output;
    int changes;
    public ProactiveTextLab(string folder, string title) {
        output = Path.GetFullPath(folder);
        Directory.CreateDirectory(output);
        Text = title;
        Width = 780; Height = 540; StartPosition = FormStartPosition.CenterScreen;
        editor.Multiline = true; editor.AcceptsReturn = true; editor.AcceptsTab = true;
        editor.ScrollBars = ScrollBars.Vertical; editor.Dock = DockStyle.Fill;
        editor.Font = new System.Drawing.Font("Microsoft YaHei UI", 15);
        editor.Name = "ColoopProactiveLabEditor";
        editor.AccessibleName = "Coloop proactive isolated document";
        editor.Text = "产品发布计划";
        editor.TextChanged += delegate { changes++; Save(); };
        Controls.Add(editor);
        Shown += delegate { editor.Focus(); editor.SelectionStart = editor.TextLength; Save(); };
        FormClosed += delegate { Save(); };
    }
    void Save() {
        File.WriteAllText(Path.Combine(output,"identity.txt"), System.Diagnostics.Process.GetCurrentProcess().Id + "\n" + Handle.ToInt64(),
                          new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(output,"actual-text.txt"), editor.Text, new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(output,"events.txt"), "text_changed=" + changes + "\ntext_length=" + editor.TextLength,
                          new UTF8Encoding(false));
    }
    [STAThread]
    public static void Main(string[] args) {
        if(args.Length != 2) throw new ArgumentException("output directory and unique title required");
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new ProactiveTextLab(args[0],args[1]));
    }
}
