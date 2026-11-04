$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Collections.Concurrent;
public static class ClipboardLeaseInput {
 static ConcurrentQueue<string> lines = new ConcurrentQueue<string>();
 public static volatile bool Ended;
 public static void Start() {
   var reader = new Thread(() => {
     try { string line; while((line=Console.ReadLine())!=null) lines.Enqueue(line); }
     finally { Ended=true; }
   });
   reader.IsBackground=true; reader.Start();
 }
 public static string Next() { string line; return lines.TryDequeue(out line) ? line : null; }
}
public static class ClipboardLeaseNative {
 [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool CloseClipboard();
 [DllImport("user32.dll")] static extern bool EmptyClipboard();
 [DllImport("user32.dll")] static extern uint EnumClipboardFormats(uint f);
 [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint f);
 [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint f, IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
 [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
 [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr p);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr p);
 [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr p);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr size);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr p);
 static Dictionary<uint, byte[]> saved;
 public static bool HasSaved { get { return saved!=null; } }
 public static uint Sequence;
 static void Put(uint format, byte[] bytes) {
   IntPtr h = GlobalAlloc(2, (UIntPtr)bytes.Length);
   if(h == IntPtr.Zero) throw new Exception("CLIPBOARD_ALLOC_FAILED");
   IntPtr p = GlobalLock(h);
   if(p == IntPtr.Zero) { GlobalFree(h); throw new Exception("CLIPBOARD_LOCK_FAILED"); }
   Marshal.Copy(bytes,0,p,bytes.Length); GlobalUnlock(h);
   if(SetClipboardData(format,h)==IntPtr.Zero) { GlobalFree(h); throw new Exception("CLIPBOARD_WRITE_FAILED"); }
 }
 public static uint Prepare(IntPtr owner, string text) {
   if(saved != null) throw new Exception("CLIPBOARD_LEASE_BUSY");
   if(!OpenClipboard(owner)) throw new Exception("CLIPBOARD_BUSY");
   try {
     var snapshot = new Dictionary<uint,byte[]>(); ulong total=0; bool hadBitmap=false;
     for(uint f=EnumClipboardFormats(0); f!=0; f=EnumClipboardFormats(f)) {
       // Bitmap/palette/metafile/owner-display formats are handles, not HGLOBAL bytes.
       if(f==2) { hadBitmap=true; continue; } // Windows can synthesize CF_BITMAP from DIB.
       if(f==3 || f==9 || f==14 || (f>=0x80 && f<=0x8e)) throw new Exception("CLIPBOARD_FORMAT_UNSUPPORTED");
       IntPtr h=GetClipboardData(f); ulong size=GlobalSize(h).ToUInt64(); total+=size;
       if(h==IntPtr.Zero || size==0 || total>33554432) throw new Exception("CLIPBOARD_FORMAT_UNSUPPORTED");
       IntPtr p=GlobalLock(h); if(p==IntPtr.Zero) throw new Exception("CLIPBOARD_FORMAT_UNSUPPORTED");
       byte[] data=new byte[(int)size]; try { Marshal.Copy(p,data,0,data.Length); } finally { GlobalUnlock(h); }
       snapshot.Add(f,data);
     }
     if(hadBitmap && !snapshot.ContainsKey(8) && !snapshot.ContainsKey(17)) throw new Exception("CLIPBOARD_FORMAT_UNSUPPORTED");
     if(!EmptyClipboard()) throw new Exception("CLIPBOARD_EMPTY_FAILED");
     saved=snapshot;
     try { Put(13,Encoding.Unicode.GetBytes(text+"\0")); Sequence=GetClipboardSequenceNumber(); }
     catch { foreach(var item in saved) Put(item.Key,item.Value); saved=null; throw; }
   } finally { CloseClipboard(); }
   // Windows may synthesize additional text formats when the writer closes.
   // Establish the lease only after that close, under a new clipboard lock.
   Sequence=GetClipboardSequenceNumber();
   bool reopened=false;
   for(int retry=0; retry<10 && !reopened; retry++) {
     reopened=OpenClipboard(owner); if(!reopened) Thread.Sleep(10);
   }
   if(!reopened) throw new Exception("CLIPBOARD_BUSY");
   try {
     if(GetClipboardOwner()!=owner) { saved=null; throw new Exception("CLIPBOARD_USER_CHANGED"); }
     Sequence=GetClipboardSequenceNumber();
     return Sequence;
   } finally { CloseClipboard(); }
 }
 public static string Finish(IntPtr owner) {
   if(saved==null) return "closed";
   if(!OpenClipboard(owner)) throw new Exception("CLIPBOARD_BUSY");
   try {
     if(GetClipboardSequenceNumber()!=Sequence) { saved=null; return "user_changed"; }
     if(!EmptyClipboard()) throw new Exception("CLIPBOARD_EMPTY_FAILED");
     foreach(var item in saved) Put(item.Key,item.Value);
     saved=null; return "restored";
   } finally { CloseClipboard(); }
 }
}
'@
$owner = New-Object System.Windows.Forms.Form
$ownerHandle = $owner.Handle
$lease = $null
$orphanedUntil = $null
[Console]::WriteLine('{"type":"ready","value":{"clipboard_leases":true}}')
[ClipboardLeaseInput]::Start()
try {
  while ($true) {
    $line = [ClipboardLeaseInput]::Next()
    if ($null -eq $line) {
      if (($lease -and [DateTime]::UtcNow -ge $lease.expires) -or ($orphanedUntil -and [DateTime]::UtcNow -ge $orphanedUntil)) {
        try { [void][ClipboardLeaseNative]::Finish($ownerHandle); $lease=$null; $orphanedUntil=$null } catch {}
      }
      if ([ClipboardLeaseInput]::Ended) { break }
      Start-Sleep -Milliseconds 50
      continue
    }
    $request = $null
    try {
      $request = $line | ConvertFrom-Json
      $body = $request.value
      switch ($request.op) {
        'clipboard.prepare' {
          if ($lease) { throw 'CLIPBOARD_LEASE_BUSY' }
          if (-not $body.task_id -or [Text.Encoding]::UTF8.GetByteCount([string]$body.text) -gt 32000 -or -not $body.text) { throw 'CLIPBOARD_INPUT_INVALID' }
          $seq=[ClipboardLeaseNative]::Prepare($ownerHandle,[string]$body.text)
          $lease=@{ id=[Guid]::NewGuid().ToString('N'); task=[string]$body.task_id; expires=[DateTime]::UtcNow.AddSeconds(10); sequence=$seq }
          $value=@{ lease_id=$lease.id; sequence=$seq; expires_in_ms=10000 }
        }
        'clipboard.guard' {
          if (-not $lease -or $body.lease_id -ne $lease.id -or $body.task_id -ne $lease.task -or [DateTime]::UtcNow -ge $lease.expires) { throw 'CLIPBOARD_LEASE_INVALID' }
          if ([ClipboardLeaseNative]::GetClipboardSequenceNumber() -ne $lease.sequence) { throw 'CLIPBOARD_USER_CHANGED' }
          $value=@{ allowed=$true }
        }
        'clipboard.finish' {
          if (-not $lease -or $body.lease_id -ne $lease.id -or $body.task_id -ne $lease.task) { throw 'CLIPBOARD_LEASE_INVALID' }
          $result=[ClipboardLeaseNative]::Finish($ownerHandle); $lease=$null
          $value=@{ status=$result }
        }
        default { throw 'CLIPBOARD_OPERATION_UNSUPPORTED' }
      }
      [Console]::WriteLine((@{type='reply';id=$request.id;value=$value}|ConvertTo-Json -Compress -Depth 8))
    } catch {
      if (-not $lease -and [ClipboardLeaseNative]::HasSaved) { $orphanedUntil=[DateTime]::UtcNow.AddSeconds(10) }
      # Return only fixed codes, never exception messages that might carry clipboard text.
      $code=([string]$_.Exception.Message)
      if ($code -notmatch '^CLIPBOARD_[A-Z_]+$') { $code='CLIPBOARD_OPERATION_FAILED' }
      [Console]::WriteLine((@{type='reply';id=$request.id;error=$code}|ConvertTo-Json -Compress))
    }
  }
} finally {
  try { [void][ClipboardLeaseNative]::Finish($ownerHandle) } catch {}
  $owner.Dispose()
}
