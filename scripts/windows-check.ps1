<#
  Windows check for pi-local-server / opencode-local-server.

  READ-ONLY: it does not change your firewall, Pi or OpenCode settings. It unpacks the code into a temp
  folder, runs the tests there, and prints what discovery finds on this PC. No IP addresses, API keys or
  config file contents are printed. The report is also copied to the clipboard.

  Usage (PowerShell):
    powershell -ExecutionPolicy Bypass -File .\windows-check.ps1
    powershell -ExecutionPolicy Bypass -File .\windows-check.ps1 -Zip C:\path\pi-local-server.zip
#>
param(
  [string]$Zip = (Join-Path $env:USERPROFILE 'Downloads\pi-local-server.zip'),
  [string]$Dir = (Join-Path $env:TEMP 'pi-local-server-check')
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$report = New-Object System.Collections.Generic.List[string]
function Log([string]$m) { Write-Host $m; $report.Add($m) }
function Section([string]$t) { Log ''; Log "=== $t" }
function Tail([string]$text, [int]$n = 12) {
  $lines = ($text -split "`r?`n") | Where-Object { $_.Trim() -ne '' }
  ($lines | Select-Object -Last $n) -join "`n"
}

Section 'System'
try { Log ("OS: " + (Get-CimInstance Win32_OperatingSystem).Caption + " build " + [System.Environment]::OSVersion.Version.Build) } catch { Log "OS: unknown" }
Log ("PowerShell: " + $PSVersionTable.PSVersion)
foreach ($name in 'node', 'npm', 'git', 'pi', 'opencode', 'tailscale') {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { Log ("{0,-9}: on PATH" -f $name) } else { Log ("{0,-9}: NOT on PATH" -f $name) }
}
$nodeVersion = ''
if (Get-Command node -ErrorAction SilentlyContinue) { $nodeVersion = (& node --version) ; Log "node version: $nodeVersion" }
$openCodeApp = @("$env:LOCALAPPDATA\Programs\OpenCode", "$env:LOCALAPPDATA\OpenCode", "$env:ProgramFiles\OpenCode") | Where-Object { Test-Path $_ }
Log ("OpenCode Desktop folder found: " + [bool]$openCodeApp)

Section 'Tailscale CLI'
$tsPath = @('C:\Program Files\Tailscale\tailscale.exe', 'C:\Program Files (x86)\Tailscale\tailscale.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $tsPath) {
  Log 'tailscale.exe not found in the default install folders'
} else {
  Log 'tailscale.exe found in a default install folder'
  try {
    $status = (& $tsPath status --json | Out-String) | ConvertFrom-Json
    foreach ($peer in $status.Peer.PSObject.Properties.Value) {
      $direct = [bool]$peer.CurAddr
      Log ("  peer {0,-22} online={1,-5} direct-lan-address={2}" -f $peer.HostName, $peer.Online, $direct)
    }
  } catch { Log ("tailscale status failed: " + $_.Exception.Message) }
}

Section 'ARP table (LAN discovery)'
try {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $arp = (& arp -a 2>&1 | Out-String)
  $sw.Stop()
  $entries = ([regex]::Matches($arp, '\b\d{1,3}(\.\d{1,3}){3}\b')).Count
  Log ("arp -a: {0} ms, {1} IPv4 entries" -f $sw.ElapsedMilliseconds, $entries)
} catch { Log ("arp -a failed: " + $_.Exception.Message) }

Section 'Inbound firewall rules that look related'
try {
  $rules = Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True -ErrorAction Stop |
    Where-Object { $_.DisplayName -match 'Local LLM|python|llama|LM Studio|Strata|node' }
  if (-not $rules) { Log 'no matching allow rules' }
  foreach ($r in $rules) {
    $pf = $r | Get-NetFirewallPortFilter
    $af = $r | Get-NetFirewallAddressFilter
    Log ("  {0} | profile={1} | ports={2} | remote={3}" -f $r.DisplayName, $r.Profile, ($pf.LocalPort -join ','), ($af.RemoteAddress -join ','))
  }
} catch { Log ("firewall query failed: " + $_.Exception.Message) }

Section 'Code'
if (-not (Test-Path $Zip)) {
  Log "Zip not found: $Zip"
  Log 'Put pi-local-server.zip there (or pass -Zip) and run again for the test and discovery parts.'
} else {
  if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
  Expand-Archive -Path $Zip -DestinationPath $Dir -Force
  Push-Location $Dir
  try {
    Log "Unpacked to $Dir"
    $npmOut = (cmd /c "npm install --no-audit --no-fund 2>&1" | Out-String)
    Log ("npm install: " + (Tail $npmOut 3))

    Section 'Typecheck'
    $tsc = (cmd /c "npx tsc --noEmit 2>&1" | Out-String)
    if ($tsc.Trim() -eq '') { Log 'tsc: OK' } else { Log (Tail $tsc 15) }

    Section 'Tests'
    $tests = (cmd /c "npm test 2>&1" | Out-String)
    $testExit = $LASTEXITCODE
    $summary = ($tests -split "`r?`n") | Where-Object { $_ -match '(tests|pass|fail) \d+\s*$' }
    if ($summary) { $summary | ForEach-Object { Log $_ } } else { Log (Tail $tests 15) }
    Log ("npm test exit code: " + $testExit)
    if ($testExit -ne 0) { Log (Tail $tests 40) }

    Section 'Discovery on this PC (npm run live-check)'
    Log ((cmd /c "npm run --silent live-check 2>&1" | Out-String).TrimEnd())

    Section 'Pi extension (temporary Pi settings folder, your Pi config is not touched)'
    if (Get-Command pi -ErrorAction SilentlyContinue) {
      $env:PI_CODING_AGENT_DIR = (New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("pls-pi-" + [guid]::NewGuid().ToString('N')))).FullName
      $ext = Join-Path $Dir 'extensions\pi-local-server\index.ts'
      Log ((& pi -ne -e $ext --offline --list-models local- 2>&1 | Out-String).TrimEnd())
      Remove-Item Env:\PI_CODING_AGENT_DIR
    } else { Log 'pi is not on PATH: skipped' }

    Section 'OpenCode plugin build'
    $build = (cmd /c "npm run --silent build:opencode 2>&1" | Out-String)
    $dist = Join-Path $Dir 'opencode\dist\index.js'
    if (Test-Path $dist) { Log ("built: opencode\dist\index.js ({0} bytes)" -f (Get-Item $dist).Length) } else { Log ("build failed: " + (Tail $build 8)) }
    $cfgDir = Join-Path $env:USERPROFILE '.config\opencode'
    Log ("OpenCode config folder exists: " + (Test-Path $cfgDir))
    if (Test-Path $dist) {
      $url = 'file:///' + ($dist -replace '\\', '/')
      Log 'To try the plugin in OpenCode Desktop, add this to %USERPROFILE%\.config\opencode\opencode.jsonc (back it up first):'
      Log ('  "plugin": ["' + $url + '"]')
    }
  } finally { Pop-Location }
}

Section 'Local servers listening (port, bound address, process)'
$ports = 8080, 8095, 1234, 11434, 8000, 30000, 1337, 5000, 5001, 4000, 9997
try {
  $listening = Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $ports -contains $_.LocalPort }
  if (-not $listening) { Log 'none of the usual ports is listening (is a server running?)' }
  foreach ($c in $listening | Sort-Object LocalPort) {
    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    Log ("  port {0,-6} bound to {1,-10} by {2}" -f $c.LocalPort, $c.LocalAddress, $proc.ProcessName)
  }
  Log '  (127.0.0.1 = reachable from this PC only; 0.0.0.0 or :: = reachable from other devices)'
} catch { Log ("Get-NetTCPConnection failed: " + $_.Exception.Message) }

$path = Join-Path $env:TEMP 'pi-local-server-report.txt'
$report | Set-Content -Path $path -Encoding UTF8
try { ($report -join "`r`n") | Set-Clipboard; Log ''; Log "Report saved to $path and copied to the clipboard: paste it in the chat." }
catch { Log ''; Log "Report saved to $path (clipboard not available): open it and paste its content in the chat." }
