param(
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RootDir = (Resolve-Path (Join-Path $ScriptDir "..\..")).ProviderPath
$RuntimeDir = Join-Path $RootDir ".runtime"
$LogDir = Join-Path $RuntimeDir "logs"
$PidFile = Join-Path $RuntimeDir "scancheck.pid"
$PortFile = Join-Path $RuntimeDir "current_port.txt"
$ServerLog = Join-Path $LogDir "launcher_server.log"
$VenvDir = Join-Path $RootDir ".venv"
$ApiDir = Join-Path $RootDir "apps\api"
$NodeRuntimeDir = Join-Path $RuntimeDir "tools\node"
$NodeCmd = "node.exe"
$NpmCmd = "npm.cmd"
$CacheFile = Join-Path $RuntimeDir ".launcher_cache.json"

function Ensure-WindowsFirewallRule {
    $ruleName = "ScanCheck Server"
    $existingRule = $null
    try {
        $existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    } catch {
        $existingRule = $null
    }

    if ($existingRule) {
        return
    }

    Write-Host '[ScanCheck] Adding Windows Firewall rule for ScanCheck...'

    try {
        $adminCheck = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")
        if ($adminCheck) {
            New-NetFirewallRule -DisplayName $ruleName `
                -Direction Inbound `
                -LocalPort 3000-3100 `
                -Protocol TCP `
                -Action Allow `
                -Profile Domain,Private,Public | Out-Null
            Write-Host '[ScanCheck] Firewall rule added successfully!'
        } else {
            Write-Warning '[ScanCheck] Not running as Administrator—could not automatically add Firewall rule!'
            Write-Warning '[ScanCheck] You may need to manually allow ScanCheck in Windows Firewall to access it from other devices on your network.'
        }
    } catch {
        Write-Warning (('[ScanCheck] Could not add Firewall rule: ') + $_)
    }
}

New-Item -ItemType Directory -Force -Path $RuntimeDir, $LogDir, (Join-Path $RuntimeDir "data"), (Join-Path $RuntimeDir "tmp") | Out-Null

Ensure-WindowsFirewallRule

# Load/save cache functions
function Get-Cache {
    if (Test-Path $CacheFile) {
        try {
            $obj = Get-Content $CacheFile -Raw | ConvertFrom-Json
            # Convert PSCustomObject to hashtable
            $hash = @{}
            foreach ($prop in $obj.PSObject.Properties) {
                $hash[$prop.Name] = $prop.Value
            }
            return $hash
        } catch {
            return @{}
        }
    }
    return @{}
}

function Set-Cache {
    param([hashtable]$Data)
    $Data | ConvertTo-Json -Depth 10 | Set-Content $CacheFile -Encoding UTF8
}

function Use-NodeRuntimePath {
    if (Test-Path $NodeRuntimeDir) {
        $nodePath = $NodeRuntimeDir
        if ($env:Path -notlike "*$nodePath*") {
            $env:Path = "$nodePath;$env:Path"
        }
    }
}

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

function Ensure-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw '[ScanCheck] Missing command after install: ' + $Name
    }
}

function Ensure-Winget {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw '[ScanCheck] winget is required on Windows. Install App Installer from Microsoft Store.'
    }
}

function Ensure-WingetPackage {
    param(
        [string]$PackageId,
        [string]$DisplayName,
        [switch]$Optional
    )

    # Check cache first
    $cache = Get-Cache
    $cacheKey = "winget_installed_$PackageId"
    $updatedKey = "${cacheKey}_updated"
    if ($cache.ContainsKey($cacheKey) -and $cache.ContainsKey($updatedKey) -and (Get-Date $cache[$updatedKey] -ErrorAction SilentlyContinue)) {
        $days = (Get-Date) - (Get-Date $cache[$updatedKey])
        if ($days.TotalDays -lt 30) {
            Write-Host "[ScanCheck] $DisplayName already installed (cached)."
            return
        }
    }

    $installed = winget list --id $PackageId --exact --accept-source-agreements 2>$null | Out-String
    if ($installed -match [Regex]::Escape($PackageId)) {
        Write-Host "[ScanCheck] $DisplayName already installed."
        $cache[$cacheKey] = $true
        $cache[$updatedKey] = (Get-Date).ToString("o")
        Set-Cache -Data $cache
        return
    }

    Write-Host "[ScanCheck] Installing $DisplayName from official winget source..."
    try {
        winget install --id $PackageId --exact --accept-package-agreements --accept-source-agreements --silent | Out-Host
        $cache[$cacheKey] = $true
        $cache[$updatedKey] = (Get-Date).ToString("o")
        Set-Cache -Data $cache
    } catch {
        if ($Optional) {
            Write-Warning "[ScanCheck] Optional package install failed: $DisplayName ($PackageId)"
            return
        }
        throw
    }
}

function Get-NodeMajor {
    param([string]$NodePath)
    try {
        return (& $NodePath -p "process.versions.node.split('.')[0]" 2>$null).Trim()
    } catch {
        return ""
    }
}

function Test-SupportedNode {
    param([string]$NodePath)
    $major = Get-NodeMajor -NodePath $NodePath
    return ($major -match '^\d+$' -and [int]$major -ge 18 -and [int]$major -le 22)
}

function Test-UsableNpm {
    param([string]$NpmPath)
    if (-not (Test-Path $NpmPath)) {
        return $false
    }
    try {
        $version = (& $NpmPath -v 2>$null | Out-String).Trim()
        return ($version -match '^\d+(\.\d+){1,2}')
    } catch {
        return $false
    }
}

function Reset-BrokenLocalNode {
    if (Test-Path $NodeRuntimeDir) {
        Write-Warning '[ScanCheck] Cached local Node runtime is incomplete or broken. Reinstalling it...'
        Remove-Item -Recurse -Force $NodeRuntimeDir
    }
}

function Install-LocalNodeLts {
    $desiredMajor = if ($env:SCANCHECK_NODE_MAJOR) { $env:SCANCHECK_NODE_MAJOR } else { "20" }
    $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
        "AMD64" { "x64" }
        "ARM64" { "arm64" }
        default { throw '[ScanCheck] Unsupported architecture for Node bootstrap: ' + $env:PROCESSOR_ARCHITECTURE }
    }

    $version = $env:SCANCHECK_NODE_VERSION
    if (-not $version) {
        # Check cache for latest compatible version
        $cache = Get-Cache
        $cacheKey = "node_latest_version_${desiredMajor}_${arch}"
        $updatedKey = "${cacheKey}_updated"
        if ($cache.ContainsKey($cacheKey) -and $cache.ContainsKey($updatedKey) -and (Get-Date $cache[$updatedKey] -ErrorAction SilentlyContinue)) {
            $hours = (Get-Date) - (Get-Date $cache[$updatedKey])
            if ($hours.TotalHours -lt 24) {
                $version = $cache[$cacheKey]
            }
        }
        
        if (-not $version) {
            $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
            $match = $index | Where-Object {
                $_.version -like "v$desiredMajor.*" -and $_.files -contains "win-$arch-zip"
            } | Select-Object -First 1
            if ($match) {
                $version = $match.version
                # Save to cache
                $cache[$cacheKey] = $version
                $cache[$updatedKey] = (Get-Date).ToString("o")
                Set-Cache -Data $cache
            } else {
                $version = "v22.11.0"
            }
        }
    }

    $nodeExe = Join-Path $NodeRuntimeDir "node.exe"
    $npmCmd = Join-Path $NodeRuntimeDir "npm.cmd"
    if ((Test-Path $nodeExe) -and (Test-UsableNpm -NpmPath $npmCmd)) {
        try {
            $current = (& $nodeExe -v).Trim()
            if ($current -eq $version) {
                return
            }
        } catch {}
    } elseif (Test-Path $NodeRuntimeDir) {
        Reset-BrokenLocalNode
    }

    Write-Host "[ScanCheck] Installing local Node runtime $version from nodejs.org..."
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("scancheck-node-" + [guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $zipName = "node-$version-win-$arch.zip"
    $zipPath = Join-Path $tmp $zipName
    $extractPath = Join-Path $tmp "extract"
    $nodeDir = Join-Path $extractPath "node-$version-win-$arch"

    Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/$zipName" -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

    if (Test-Path $NodeRuntimeDir) {
        Remove-Item -Recurse -Force $NodeRuntimeDir
    }
    New-Item -ItemType Directory -Force -Path $NodeRuntimeDir | Out-Null
    Copy-Item -Path (Join-Path $nodeDir "*") -Destination $NodeRuntimeDir -Recurse -Force
    Remove-Item -Recurse -Force $tmp
}

function Select-NodeRuntime {
    $useSystem = $false
    $desiredMajor = if ($env:SCANCHECK_NODE_MAJOR) { [string]$env:SCANCHECK_NODE_MAJOR } else { '20' }
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        if (Test-SupportedNode -NodePath $nodeCommand.Path) {
            $useSystem = $true
        } else {
            Write-Warning (('[ScanCheck] System Node ') + (& $nodeCommand.Path -v) + ' is outside supported range (18-22).')
        }
    }

    if ($useSystem) {
        $script:NodeCmd = $nodeCommand.Source
        $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $npmCommand) {
            throw '[ScanCheck] npm.cmd was not found next to Node.js.'
        }
        $script:NpmCmd = $npmCommand.Source
    } else {
        $localNode = Join-Path $NodeRuntimeDir "node.exe"
        $localNpm = Join-Path $NodeRuntimeDir "npm.cmd"
        $localMajor = if (Test-Path $localNode) { Get-NodeMajor -NodePath $localNode } else { '' }
        if ((Test-Path $localNode) -and ($localMajor -eq $desiredMajor) -and (Test-SupportedNode -NodePath $localNode) -and (Test-UsableNpm -NpmPath $localNpm)) {
            Write-Host '[ScanCheck] Using cached local Node runtime ' + (& $localNode -v) + '.'
        } else {
            if (Test-Path $NodeRuntimeDir) {
                Reset-BrokenLocalNode
            }
            Install-LocalNodeLts
        }
        $script:NodeCmd = $localNode
        $script:NpmCmd = $localNpm
        Use-NodeRuntimePath
    }

    Write-Host '[ScanCheck] Using Node runtime: ' + (& $script:NodeCmd -v)
    Write-Host '[ScanCheck] Using npm runtime: ' + (& $script:NpmCmd -v)
}

function Ensure-SystemDependencies {
    $missing = @()

    $hasSupportedSystemNode = $false
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand -and (Test-SupportedNode -NodePath $nodeCommand.Path)) {
        $hasSupportedSystemNode = $true
    }

    $localNode = Join-Path $NodeRuntimeDir "node.exe"
    $localNpm = Join-Path $NodeRuntimeDir "npm.cmd"
    $hasSupportedLocalNode = (Test-Path $localNode) -and (Test-SupportedNode -NodePath $localNode) -and (Test-UsableNpm -NpmPath $localNpm)
    if (-not $hasSupportedSystemNode -and -not $hasSupportedLocalNode) {
        $missing += "node"
    }

    $venvPython = Join-Path $VenvDir "Scripts\python.exe"
    $hasPython = (Test-Path $venvPython) -or (Get-Command python.exe -ErrorAction SilentlyContinue) -or (Get-Command py.exe -ErrorAction SilentlyContinue)
    if (-not $hasPython) {
        $missing += "python"
    }

    if ($missing.Count -eq 0) {
        return
    }

    if (Get-Command winget -ErrorAction SilentlyContinue) {
        if ($missing -contains "node") {
            Ensure-WingetPackage -PackageId "OpenJS.NodeJS.LTS" -DisplayName "Node.js LTS"
        }
        if ($missing -contains "python") {
            Ensure-WingetPackage -PackageId "Python.Python.3.12" -DisplayName "Python 3.12"
        }
        Refresh-Path
    }

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $hasSupportedSystemNode = $nodeCommand -and (Test-SupportedNode -NodePath $nodeCommand.Path)
    $hasSupportedLocalNode = (Test-Path $localNode) -and (Test-SupportedNode -NodePath $localNode) -and (Test-UsableNpm -NpmPath $localNpm)
    if (-not $hasSupportedSystemNode -and -not $hasSupportedLocalNode) {
        Write-Warning '[ScanCheck] No supported Node runtime found locally. The launcher will try to download a local Node runtime.'
    }

    if ((-not (Test-Path $venvPython)) -and (-not (Get-Command python.exe -ErrorAction SilentlyContinue)) -and (-not (Get-Command py.exe -ErrorAction SilentlyContinue))) {
        throw '[ScanCheck] Python 3 is required for QR generation and scanner preprocessing. Install Python 3.12, then run the launcher again.'
    }
}

function Ensure-PythonEnvironment {
    $venvPython = Join-Path $VenvDir "Scripts\python.exe"
    
    # If .venv exists but doesn't have the expected Windows layout (e.g. it has 'bin' from a Linux env), 
    # we must recreate it to avoid "Missing venv python" errors.
    if ((Test-Path $VenvDir) -and (-not (Test-Path $venvPython))) {
        Write-Warning (('[ScanCheck] Virtual environment at ') + $VenvDir + ' is invalid or from another OS. Recreating...')
        Remove-Item -Recurse -Force $VenvDir
    }

    if (-not (Test-Path $VenvDir)) {
        $systemPython = Get-Command python.exe -ErrorAction SilentlyContinue
        $pyLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
        if ($systemPython) {
            Write-Host '[ScanCheck] Creating Python virtual environment...'
            & $systemPython.Source -m venv $VenvDir
        } elseif ($pyLauncher) {
            Write-Host '[ScanCheck] Creating Python virtual environment...'
            & $pyLauncher.Source -3 -m venv $VenvDir
        } else {
            throw '[ScanCheck] Python 3 is required for QR generation and scanner preprocessing.'
        }
    }

    if (-not (Test-Path $venvPython)) {
        throw '[ScanCheck] Python virtual environment is unavailable. Delete .venv and run the launcher again.'
    }

    if (-not (Test-Path (Join-Path $RuntimeDir ".python_bootstrap_done"))) {
        Write-Host '[ScanCheck] Installing Python dependencies...'
        & $venvPython -m pip install --upgrade pip | Out-Host

        $requirementsPath = Join-Path $RootDir "requirements.txt"
        & $venvPython -m pip install -r $requirementsPath | Out-Host
        if ($LASTEXITCODE -ne 0) { throw '[ScanCheck] Python dependency install failed.' }

        New-Item -ItemType File -Path (Join-Path $RuntimeDir ".python_bootstrap_done") -Force | Out-Null
    }

    & $venvPython -c "import qrcode, cv2, numpy" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Remove-Item (Join-Path $RuntimeDir ".python_bootstrap_done") -Force -ErrorAction SilentlyContinue
        throw '[ScanCheck] Python QR/scanner dependencies are incomplete. Run the launcher again to reinstall them.'
    }
}

function Ensure-NodeEnvironment {
    Select-NodeRuntime
    Use-NodeRuntimePath
    $needsInstall = $false
    if (-not (Test-Path (Join-Path $ApiDir "node_modules"))) {
        $needsInstall = $true
    } else {
        Push-Location $ApiDir
        try {
            cmd.exe /c "`"$NpmCmd`" ls --depth=0 >nul 2>nul"
            if ($LASTEXITCODE -ne 0) {
                $needsInstall = $true
            }
        } finally {
            Pop-Location
        }
    }

    if (-not $needsInstall) {
        # Check if node_modules was created on a non-Windows OS (missing .cmd files in .bin)
        $binDir = Join-Path $ApiDir "node_modules\.bin"
        if (Test-Path $binDir) {
            $hasCmd = Get-ChildItem (Join-Path $binDir "*.cmd") -ErrorAction SilentlyContinue
            if (-not $hasCmd) {
                Write-Warning '[ScanCheck] Node dependencies seem to be from another OS; reinstalling...'
                $needsInstall = $true
            }
        }
    }

    if (-not $needsInstall) {
        Push-Location $ApiDir
        try {
            # Run node test through cmd.exe to prevent PowerShell's ErrorActionPreference from stopping on native stderr
            $testExpr = "try { require('sqlite3'); process.exit(0) } catch(e) { process.exit(1) }"
            cmd.exe /c "`"$NodeCmd`" -e `"$testExpr`" 2>nul"
            if ($LASTEXITCODE -ne 0) {
                Write-Host '[ScanCheck] sqlite3 bindings do not match active Node runtime; reinstalling Node dependencies...'
                $needsInstall = $true
            }
        } catch {
            $needsInstall = $true
        } finally {
            Pop-Location
        }
    }

    if ($needsInstall) {
        Write-Host '[ScanCheck] Installing Node dependencies...'
        $registry = if ($env:SCANCHECK_NPM_REGISTRY) { $env:SCANCHECK_NPM_REGISTRY } else { "https://registry.npmjs.org/" }
        $npmInstallCmd = if (Test-Path (Join-Path $ApiDir "package-lock.json")) { "ci" } else { "install" }
        $venvPython = Join-Path $VenvDir "Scripts\python.exe"
        Push-Location $ApiDir
        try {
            if (Test-Path $venvPython) {
                $env:npm_config_python = $venvPython
            }
            $currentRegistry = (cmd.exe /c "`"$NpmCmd`" config get registry 2>nul" | Out-String).Trim()
            if ($currentRegistry -and ($currentRegistry -ne $registry)) {
                Write-Host '[ScanCheck] Overriding npm registry:'
                Write-Host '  from: ' + $currentRegistry
                Write-Host '  to:   ' + $registry
            }

            & $NpmCmd $npmInstallCmd --registry $registry --prefer-offline --no-audit --no-fund --progress=false --fetch-retries=5 --fetch-retry-factor=2 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 | Out-Host
            if ($LASTEXITCODE -ne 0) {
                Write-Warning (('[ScanCheck] npm ') + $npmInstallCmd + ' failed. Retrying once after npm cache clean...')
                & $NpmCmd cache clean --force | Out-Host
                & $NpmCmd $npmInstallCmd --registry $registry --prefer-offline --no-audit --no-fund --progress=false --fetch-retries=5 --fetch-retry-factor=2 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 | Out-Host
                if ($LASTEXITCODE -ne 0) {
                    throw '[ScanCheck] npm ' + $npmInstallCmd + ' failed.'
                }
            }
        } finally {
            Pop-Location
        }
    }
}

function Test-ApiDependencies {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand -or -not (Test-Path (Join-Path $ApiDir "node_modules"))) {
        return $false
    }

    Push-Location $ApiDir
    try {
        cmd.exe /c "`"$($nodeCommand.Source)`" -e `"try { require('sqlite3'); process.exit(0) } catch(e) { process.exit(1) }`" 2>nul"
        return ($LASTEXITCODE -eq 0)
    } finally {
        Pop-Location
    }
}

function Sync-OmrTemplate {
    $runtimeTemplate = Join-Path (Join-Path (Join-Path (Join-Path $RootDir ".runtime") "omr-calib") "input") "template.json"
    $repoTemplate = Join-Path (Join-Path (Join-Path (Join-Path $RootDir "services") "omr-python") "omrchecker-template") "template.json"
    $source = if ($env:SCANCHECK_TEMPLATE_SOURCE) { $env:SCANCHECK_TEMPLATE_SOURCE.ToLowerInvariant() } else { "runtime" }

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runtimeTemplate), (Split-Path -Parent $repoTemplate) | Out-Null

    function Same-Content([string]$a, [string]$b) {
        if ((-not (Test-Path $a)) -or (-not (Test-Path $b))) { return $false }
        return (Get-FileHash -Algorithm SHA256 $a).Hash -eq (Get-FileHash -Algorithm SHA256 $b).Hash
    }

    if ($source -eq "runtime") {
        if (Test-Path $runtimeTemplate) {
            if (-not (Same-Content $runtimeTemplate $repoTemplate)) {
                Copy-Item -Path $runtimeTemplate -Destination $repoTemplate -Force
                Write-Host '[ScanCheck] Synced OMR template: runtime -> repo'
            } else {
                Write-Host '[ScanCheck] OMR template already in sync (runtime == repo)'
            }
            return
        }
        if (Test-Path $repoTemplate) {
            Copy-Item -Path $repoTemplate -Destination $runtimeTemplate -Force
            Write-Host '[ScanCheck] Synced OMR template: repo -> runtime'
            return
        }
        Write-Warning '[ScanCheck] No OMR template found to sync.'
        return
    }

    if ($source -eq "repo") {
        if (Test-Path $repoTemplate) {
            if (-not (Same-Content $repoTemplate $runtimeTemplate)) {
                Copy-Item -Path $repoTemplate -Destination $runtimeTemplate -Force
                Write-Host '[ScanCheck] Synced OMR template: repo -> runtime'
            } else {
                Write-Host '[ScanCheck] OMR template already in sync (repo == runtime)'
            }
            return
        }
        if (Test-Path $runtimeTemplate) {
            Copy-Item -Path $runtimeTemplate -Destination $repoTemplate -Force
            Write-Host '[ScanCheck] Synced OMR template: runtime -> repo'
            return
        }
        Write-Warning '[ScanCheck] No OMR template found to sync.'
        return
    }

    throw '[ScanCheck] Invalid SCANCHECK_TEMPLATE_SOURCE=' + $source + ' (use "runtime" or "repo").'
}

function Test-LauncherLayout {
    $requiredFiles = @(
        (Join-Path $ApiDir "server.js"),
        (Join-Path $ApiDir "package.json"),
        (Join-Path $RootDir "requirements.txt")
    )
    $missing = @()
    foreach ($file in $requiredFiles) {
        if (-not (Test-Path $file)) {
            $missing += $file
        }
    }
    if ($missing.Count -gt 0) {
        throw '[ScanCheck] Launcher validation failed. Missing files: ' + ($missing -join ', ')
    }

    Write-Host '[ScanCheck] Launcher validation OK.'
    Write-Host '[ScanCheck] Root: ' + $RootDir
    Write-Host '[ScanCheck] API:  ' + $ApiDir
    Write-Host '[ScanCheck] Node cache: ' + $NodeRuntimeDir
}

function Read-Port {
    if (Test-Path $PortFile) {
        return (Get-Content $PortFile -Raw).Trim()
    }
    return "3000"
}

function Test-Health {
    $port = Read-Port
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 2
        return $true
    } catch {
        return $false
    }
}

function Start-Server {
    if (Test-Path $PidFile) {
        $existingPid = (Get-Content $PidFile -Raw).Trim()
        if ($existingPid) {
            $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
            if ($proc -and (Test-Health)) {
                Write-Host '[ScanCheck] Server already running (PID ' + $existingPid + ').'
                return
            }
        }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }

    Write-Host '[ScanCheck] Starting server...'
    Use-NodeRuntimePath
    $venvPython = Join-Path $VenvDir "Scripts\python.exe"
    
    # Build cmdArgs properly using double quotes where needed
    $setPython = 'set "SCANCHECK_PYTHON=' + $venvPython + '"'
    $setNpm = 'set "npm_config_python=' + $venvPython + '"'
    $runNode = '"' + $NodeCmd + '" server.js >> "' + $ServerLog + '" 2>&1'
    $cmdArgs = '/c ' + $setPython + ' & ' + $setNpm + ' & ' + $runNode
    
    $proc = Start-Process -FilePath "cmd.exe" -ArgumentList $cmdArgs -WorkingDirectory $ApiDir -WindowStyle Hidden -PassThru
    Set-Content -Path $PidFile -Value $proc.Id
}

function Wait-ForServer {
    $attempts = 90
    for ($i = 1; $i -le $attempts; $i++) {
        if (Test-Health) {
            return
        }
        Start-Sleep -Seconds 1
    }
    throw '[ScanCheck] Server did not become healthy in time. Check ' + $ServerLog
}

function Open-Browser {
    $port = Read-Port
    $url = "http://localhost:$port"
    Write-Host '[ScanCheck] Opening ' + $url
    Start-Process $url | Out-Null
}

if ($ValidateOnly) {
    Test-LauncherLayout
    exit 0
}

# Fast path check - if everything is already set up, skip some checks
$cache = Get-Cache
$fastPath = $false
if ($cache.ContainsKey("last_successful_launch")) {
    $venvPython = Join-Path $VenvDir "Scripts\python.exe"
    $localNode = Join-Path $NodeRuntimeDir "node.exe"
    $nodeModules = Join-Path $ApiDir "node_modules"
    if (
        ((Test-Path $localNode) -or (Get-Command node.exe -ErrorAction SilentlyContinue)) -and
        (Test-Path $nodeModules) -and
        (Test-ApiDependencies)
    ) {
        $fastPath = $true
    }
}

if (-not $fastPath) {
    Write-Host '[ScanCheck] First-run or incomplete setup detected, performing full checks...'
    Ensure-SystemDependencies
    Ensure-PythonEnvironment
    Ensure-NodeEnvironment
    Sync-OmrTemplate
    $cache["last_successful_launch"] = (Get-Date).ToString("o")
    Set-Cache -Data $cache
} else {
    Write-Host '[ScanCheck] Fast path: All dependencies already set up.'
    Select-NodeRuntime
    Use-NodeRuntimePath
}

Start-Server
Wait-ForServer
Open-Browser

Write-Host '[ScanCheck] Ready.'
