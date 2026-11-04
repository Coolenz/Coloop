<#
Project-local Android tools. Dot-source to set process-only environment variables:
  . ./scripts/android-toolchain.ps1
Install the pinned tools (and optionally the emulator) without an administrator:
  ./scripts/android-toolchain.ps1 -Install -WithEmulator -AcceptLicenses
No user/machine environment, proxy setting, Windows feature, or global SDK is changed.
#>
param([switch]$Install, [switch]$WithEmulator, [switch]$AcceptLicenses, [switch]$CreateAvd)
$ErrorActionPreference = 'Stop'
$ColoopAndroidRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.cache/android-toolchain'))
$ColoopSdkRoot = Join-Path $ColoopAndroidRoot 'sdk'
$ColoopJavaRoot = Join-Path $ColoopAndroidRoot 'jdk'
$ColoopGradleRoot = Join-Path $ColoopAndroidRoot 'gradle-8.13'

if ($Install) {
  New-Item -ItemType Directory -Force -Path $ColoopAndroidRoot | Out-Null
  # JDK checksum: Adoptium public v3 API; Gradle: official distribution .sha256.
  # Android SHA1 values: Google's repository2-3.xml and sys-img/android/sys-img2-3.xml.
  $packages = @(
    @{ name='jdk21.zip'; url='https://api.github.com/repos/adoptium/temurin21-binaries/releases/assets/689108686?download=1'; algorithm='sha256'; checksum='a4dbaa05fca4bd89d84584e58c459bd732efebb1722af80ab13c6516832004f9'; target='jdk' },
    @{ name='gradle-8.13-bin.zip'; url='https://api.github.com/repos/gradle/gradle-distributions/releases/assets/232373824?download=1'; algorithm='sha256'; checksum='20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78'; target='gradle-8.13' },
    @{ name='commandlinetools.zip'; url='https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip'; algorithm='sha256'; checksum='90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a'; target='sdk/cmdline-tools/latest' },
    @{ name='platform-36_r02.zip'; url='https://dl.google.com/android/repository/platform-36_r02.zip'; algorithm='sha1'; checksum='2c1a80dd4d9f7d0e6dd336ec603d9b5c55a6f576'; target='sdk/platforms/android-36' },
    @{ name='build-tools_r35_windows.zip'; url='https://dl.google.com/android/repository/build-tools_r35_windows.zip'; algorithm='sha1'; checksum='af059bb67cf7786f45ee0db85e2d24985df1b4b6'; target='sdk/build-tools/35.0.0' },
    @{ name='platform-tools_r37.0.1-win.zip'; url='https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip'; algorithm='sha1'; checksum='e03e78b1d80b396f1c3358e31251cb31740e1110'; target='sdk/platform-tools' }
  )
  if ($WithEmulator) {
    $packages += @{ name='emulator-windows_x64-16740729.zip'; url='https://dl.google.com/android/repository/emulator-windows_x64-16740729.zip'; algorithm='sha1'; checksum='4d7268aa7787c640ad892844e6c9a5f159e91ad3'; target='sdk/emulator' }
    $packages += @{ name='x86_64-35_r02.zip'; url='https://dl.google.com/android/repository/sys-img/android/x86_64-35_r02.zip'; algorithm='sha1'; checksum='2d857d170c0d1b827149565da34b3383e5306f7f'; target='sdk/system-images/android-35/default/x86_64' }
  }
  $manifestPath = Join-Path $ColoopAndroidRoot 'pinned-packages.json'
  $packages | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding utf8
  $downloadScript = Join-Path $ColoopAndroidRoot 'download-pinned.mjs'
  @'
import { mkdir, readFile, stat, rename } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
const root=import.meta.dirname, directory=join(root,'downloads');
await mkdir(directory,{recursive:true});
const packages=JSON.parse((await readFile(join(root,'pinned-packages.json'),'utf8')).replace(/^\uFEFF/,''));
async function hash(file,algorithm){const h=createHash(algorithm);for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
async function download(p){const file=join(directory,p.name);try{if((await stat(file)).isFile()&&await hash(file,p.algorithm)===p.checksum){console.log('Verified existing '+p.name);return;}}catch{}
 const r=await fetch(p.url,{headers:{'user-agent':'Coloop-build',accept:'application/octet-stream','accept-encoding':'identity'},signal:AbortSignal.timeout(900000)});
 if(!r.ok)throw new Error('Download failed '+p.name+': HTTP '+r.status);
 console.log('Downloading '+p.name);await pipeline(Readable.fromWeb(r.body),createWriteStream(file+'.pending'));
 if(await hash(file+'.pending',p.algorithm)!==p.checksum)throw new Error('Checksum mismatch: '+p.name);
 await rename(file+'.pending',file);console.log('Verified '+p.name);
}
// Drain successful downloads before surfacing a failure; a failed mirror cannot truncate peers.
const results=await Promise.allSettled(packages.map(download));
for(const result of results)if(result.status==='rejected')throw result.reason;
'@ | Set-Content -LiteralPath $downloadScript -Encoding utf8
  & node $downloadScript
  if ($LASTEXITCODE -ne 0) { throw 'Android tool download or checksum verification failed' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  foreach ($package in $packages) {
    $target = [IO.Path]::GetFullPath((Join-Path $ColoopAndroidRoot $package.target))
    if (-not $target.StartsWith($ColoopAndroidRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid tool target' }
    if (Test-Path -LiteralPath $target) { continue }
    $stage = Join-Path $ColoopAndroidRoot ('extract-' + [guid]::NewGuid())
    [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $ColoopAndroidRoot ('downloads/' + $package.name)), $stage)
    $entries = @(Get-ChildItem -LiteralPath $stage)
    if ($entries.Count -ne 1 -or -not $entries[0].PSIsContainer) { throw ('Unexpected archive layout: ' + $package.name) }
    $source = [IO.Path]::GetFullPath($entries[0].FullName)
    if (-not $source.StartsWith($ColoopAndroidRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid extraction source' }
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($target)) | Out-Null
    [IO.Directory]::Move($source, $target)
    Write-Output ('Installed ' + $package.target)
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $ColoopJavaRoot 'bin/java.exe'))) { throw 'Project JDK is missing. Run scripts/android-toolchain.ps1 -Install first.' }
if (-not (Test-Path -LiteralPath (Join-Path $ColoopGradleRoot 'bin/gradle.bat'))) { throw 'Project Gradle is missing. Run scripts/android-toolchain.ps1 -Install first.' }
$env:JAVA_HOME = $ColoopJavaRoot
$env:ANDROID_HOME = $ColoopSdkRoot
$env:ANDROID_SDK_ROOT = $ColoopSdkRoot
$env:GRADLE_USER_HOME = Join-Path $ColoopAndroidRoot 'gradle-home'
$env:ANDROID_USER_HOME = Join-Path $ColoopAndroidRoot 'android-user'
$env:ANDROID_EMULATOR_HOME = Join-Path $ColoopAndroidRoot 'android-user'
# The deprecated PREFS_ROOT appends .android and conflicts with exact USER_HOME.
# Clear only this process's alias; do not write any user/machine environment value.
$env:ANDROID_PREFS_ROOT = $null
$env:ANDROID_AVD_HOME = Join-Path $ColoopAndroidRoot 'avd'
$env:Path = (@(
  (Join-Path $ColoopJavaRoot 'bin'),
  (Join-Path $ColoopGradleRoot 'bin'),
  (Join-Path $ColoopSdkRoot 'platform-tools'),
  (Join-Path $ColoopSdkRoot 'emulator'),
  (Join-Path $ColoopSdkRoot 'cmdline-tools/latest/bin')
) + ($env:Path -split ';') | Select-Object -Unique) -join ';'
foreach ($directory in @($env:GRADLE_USER_HOME, $env:ANDROID_USER_HOME, $env:ANDROID_AVD_HOME)) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
if ($AcceptLicenses) {
  1..100 | ForEach-Object { 'y' } | & (Join-Path $ColoopSdkRoot 'cmdline-tools/latest/bin/sdkmanager.bat') --sdk_root=$ColoopSdkRoot --licenses
  if ($LASTEXITCODE -ne 0) { throw 'Android SDK license setup failed' }
}
$ColoopAndroidPaths = [pscustomobject]@{
  Jdk=$ColoopJavaRoot; Sdk=$ColoopSdkRoot; Gradle=$ColoopGradleRoot;
  GradleUserHome=$env:GRADLE_USER_HOME; Avd=$env:ANDROID_AVD_HOME
}
if ($CreateAvd) {
  $avdPath = Join-Path $env:ANDROID_AVD_HOME 'Coloop_API_35.avd'
  $imagePath = Join-Path $ColoopSdkRoot 'system-images/android-35/default/x86_64'
  if (-not (Test-Path -LiteralPath (Join-Path $imagePath 'system.img'))) { throw 'Emulator image missing; install tools with -WithEmulator.' }
  New-Item -ItemType Directory -Force -Path $avdPath | Out-Null
  @"
avd.ini.encoding=UTF-8
path=$avdPath
target=android-35
"@ | Set-Content -LiteralPath (Join-Path $env:ANDROID_AVD_HOME 'Coloop_API_35.ini') -Encoding ascii
  @"
AvdId=Coloop_API_35
avd.ini.displayname=Coloop API 35
abi.type=x86_64
hw.cpu.arch=x86_64
hw.cpu.ncore=2
hw.ramSize=1536
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader
hw.lcd.width=720
hw.lcd.height=1600
hw.lcd.density=320
hw.keyboard=yes
hw.mainKeys=no
hw.audioInput=no
hw.audioOutput=no
hw.camera.back=none
hw.camera.front=none
hw.sdCard=no
image.sysdir.1=$imagePath\
tag.id=default
tag.display=Default Android System Image
disk.dataPartition.size=1073741824
fastboot.forceColdBoot=yes
showDeviceFrame=no
runtime.network.latency=none
runtime.network.speed=full
"@ | Set-Content -LiteralPath (Join-Path $avdPath 'config.ini') -Encoding ascii
  Write-Output ('Created project AVD: ' + $avdPath)
}
