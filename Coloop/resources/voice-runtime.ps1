$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$stage = 'decode'
try {
  $request = [Console]::ReadLine() | ConvertFrom-Json
  $bytes = [Convert]::FromBase64String([string]$request.audio)
  Add-Type -AssemblyName System.Speech
  Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.IO;
using System.Globalization;
using System.Collections.Generic;
using System.Speech.Recognition;
using System.Threading;
public sealed class ColoopSpeechSegment { public string Text; public double Confidence; }
public sealed class ColoopSpeechResult { public ColoopSpeechSegment[] Segments; public int Rejected; }
public static class ColoopSpeech {
 public static ColoopSpeechResult Read(byte[] audio) {
  using (var input = new MemoryStream(audio, false))
  using (var engine = new SpeechRecognitionEngine(CultureInfo.GetCultureInfo("zh-CN")))
  using (var completed = new ManualResetEvent(false)) {
   var segments = new List<ColoopSpeechSegment>();
   int rejected = 0;
   Exception failure = null;
   EventHandler<SpeechRecognizedEventArgs> recognized = delegate(object sender, SpeechRecognizedEventArgs e) {
    lock (segments) {
     if (segments.Count >= 100) { failure = new InvalidOperationException("VOICE_TOO_MANY_SEGMENTS"); engine.RecognizeAsyncCancel(); }
     else segments.Add(new ColoopSpeechSegment { Text = e.Result.Text, Confidence = e.Result.Confidence });
    }
   };
   EventHandler<SpeechRecognitionRejectedEventArgs> reject = delegate { Interlocked.Increment(ref rejected); };
   EventHandler<RecognizeCompletedEventArgs> finish = delegate(object sender, RecognizeCompletedEventArgs e) {
    if (e.Error != null) failure = e.Error;
    try { completed.Set(); } catch (ObjectDisposedException) {}
   };
   engine.SpeechRecognized += recognized;
   engine.SpeechRecognitionRejected += reject;
   engine.RecognizeCompleted += finish;
   try {
    engine.LoadGrammar(new DictationGrammar());
    engine.SetInputToWaveStream(input);
    engine.RecognizeAsync(RecognizeMode.Multiple);
    if (!completed.WaitOne(150000)) {
     engine.RecognizeAsyncCancel(); completed.WaitOne(5000);
     throw new TimeoutException("VOICE_RECOGNITION_TIMEOUT");
    }
    if (failure != null) throw failure;
    lock (segments) return new ColoopSpeechResult { Segments = segments.ToArray(), Rejected = rejected };
   } finally {
    engine.SpeechRecognized -= recognized;
    engine.SpeechRecognitionRejected -= reject;
    engine.RecognizeCompleted -= finish;
   }
  }
 }
}
'@
  $stage = 'initialize'
  $recognized = [ColoopSpeech]::Read($bytes)
  $segments = [Collections.Generic.List[object]]::new()
  $weightedConfidence = 0.0
  $characters = 0
  foreach ($segment in $recognized.Segments) {
    $text = [string]$segment.Text
    $segments.Add(@{ text = $text; confidence = [double]$segment.Confidence })
    $characters += $text.Length
    $weightedConfidence += [double]$segment.Confidence * $text.Length
  }
  if ($characters -eq 0) { throw 'NO_SPEECH_RECOGNIZED' }
  $result = @{ ok = $true; text = ($segments | ForEach-Object { $_.text }) -join ' '; confidence = $weightedConfidence / $characters;
    language = 'zh-CN'; engine = 'windows_offline_speech'; segments = $segments.ToArray(); rejected_segments = $recognized.Rejected }
} catch {
  $exception = $_.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  $code = [string]$exception.Message
  if ($code -notmatch '^[A-Z_]{1,100}$') { $code = 'VOICE_TRANSCRIPTION_FAILED' }
  $result = @{ ok = $false; error = $code; stage = $stage }
}
[Console]::WriteLine(($result | ConvertTo-Json -Compress -Depth 8))
