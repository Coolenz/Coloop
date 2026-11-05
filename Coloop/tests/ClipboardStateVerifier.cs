// Independent clipboard readback. Payloads remain inside this verifier process.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

public sealed class ClipboardStateVerifier {
    [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern uint EnumClipboardFormats(uint previous);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClipboardFormatName(uint format, StringBuilder name, int count);
    [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr handle);

    readonly string baseline;
    readonly bool metadataMarker;
    public ClipboardStateVerifier() { baseline = Digest(); metadataMarker = MetadataAdvertised(); }
    public bool Same() { return baseline == Digest(); }
    public bool MetadataSame() { return metadataMarker == MetadataAdvertised(); }
    public bool Marker(string text) {
        return System.Windows.Forms.Clipboard.GetText() == text;
    }
    static bool MetadataAdvertised() {
        if (!OpenClipboard(IntPtr.Zero)) throw new Exception("VERIFIER_CLIPBOARD_BUSY");
        try {
            for (uint format = EnumClipboardFormats(0); format != 0; format = EnumClipboardFormats(format)) {
                var name = new StringBuilder(256);
                GetClipboardFormatName(format, name, 256);
                if (name.ToString() == "EnterpriseDataProtectionId") return true;
            }
            return false;
        } finally { CloseClipboard(); }
    }

    static string Digest() {
        if (!OpenClipboard(IntPtr.Zero)) throw new Exception("VERIFIER_CLIPBOARD_BUSY");
        try {
            var values = new SortedDictionary<uint, string>();
            long total = 0;
            for (uint format = EnumClipboardFormats(0); format != 0; format = EnumClipboardFormats(format)) {
                var name = new StringBuilder(256);
                GetClipboardFormatName(format, name, 256);
                // OLE envelopes contain process-local pointers and are rebuilt by
                // Windows. Compare all materialized public data, not those pointers.
                if (name.ToString() == "DataObject" || name.ToString() == "Ole Private Data") continue;
                IntPtr handle = GetClipboardData(format);
                // This offered marker has no retrievable payload. It disappears
                // when its delayed-render owner exits, including a normal OLE flush.
                if (handle == IntPtr.Zero && name.ToString() == "EnterpriseDataProtectionId") continue;
                long size = (long)GlobalSize(handle).ToUInt64();
                total += size;
                if (handle == IntPtr.Zero || size <= 0 || total > 33554432)
                    throw new Exception("VERIFIER_FORMAT_UNSUPPORTED");
                IntPtr pointer = GlobalLock(handle);
                if (pointer == IntPtr.Zero) throw new Exception("VERIFIER_FORMAT_UNSUPPORTED");
                var bytes = new byte[(int)size];
                try { Marshal.Copy(pointer, bytes, 0, bytes.Length); }
                finally { GlobalUnlock(handle); }
                using (var hash = SHA256.Create()) {
                    values.Add(format, Convert.ToBase64String(hash.ComputeHash(bytes)));
                }
            }
            var digest = new StringBuilder();
            foreach (var item in values) digest.Append(item.Key).Append('=').Append(item.Value).Append('\n');
            return digest.ToString();
        } finally { CloseClipboard(); }
    }
}
