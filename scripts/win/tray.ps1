# AI Council - Controlador na Bandeja do Windows (System Tray)
# Permite ligar/desligar o servidor local (porta 4317) e ativar/desativar
# o inicio automatico com o Windows com 1 clique.

param(
    [switch]$NoAutoStartServer
)

$ErrorActionPreference = "SilentlyContinue"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$DataDir = Join-Path $RepoDir "data"
$PidFile = Join-Path $DataDir "monitor.pid"
$LogFile = Join-Path $DataDir "monitor.log"
$DistEntry = Join-Path $RepoDir "dist\monitor.js"
$SrcEntry = Join-Path $RepoDir "src\monitor.ts"
$IconPath = Join-Path $RepoDir "public\icons\ai-council.ico"
$LauncherVbs = Join-Path $ScriptDir "launch-tray.vbs"
$StartupDir = [Environment]::GetFolderPath("Startup")
$StartupShortcut = Join-Path $StartupDir "AI Council.lnk"
$Port = 4317
$DashboardUrl = "http://127.0.0.1:$Port"

# Le porta customizada do .env, se existir
$EnvFile = Join-Path $RepoDir ".env"
if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile) {
        if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') {
            $Port = [int]$Matches[1]
            $DashboardUrl = "http://127.0.0.1:$Port"
        }
    }
}

# Garante instancia unica da bandeja
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\AICouncilTrayApp_$Port", [ref]$createdNew)
if (-not $createdNew) {
    Start-Process $DashboardUrl
    exit 0
}

$script:ServerProcess = $null
$script:LastRunningState = $null

function Test-ServerOnline {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        $connected = $async.AsyncWaitHandle.WaitOne(150, $false)
        if ($connected) {
            $client.EndConnect($async)
            $client.Close()
            return $true
        }
        $client.Close()
        return $false
    } catch {
        return $false
    }
}

function Find-NodeExecutable {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fallback = "C:\Program Files\nodejs\node.exe"
    if (Test-Path $fallback) { return $fallback }
    return "node.exe"
}

function Ensure-DistBuilt {
    $needsBuild = -not (Test-Path $DistEntry)
    if (-not $needsBuild -and (Test-Path $SrcEntry)) {
        $srcTime = (Get-Item $SrcEntry).LastWriteTimeUtc
        $distTime = (Get-Item $DistEntry).LastWriteTimeUtc
        if ($srcTime -gt $distTime) {
            $needsBuild = $true
        }
    }
    if ($needsBuild) {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "cmd.exe"
        $psi.Arguments = "/c npm.cmd run build"
        $psi.WorkingDirectory = $RepoDir
        $psi.CreateNoWindow = $true
        $psi.UseShellExecute = $false
        $p = [System.Diagnostics.Process]::Start($psi)
        $p.WaitForExit(60000) | Out-Null
    }
}

function Show-TrayNotice([string]$title, [string]$text) {
    if ($script:NotifyIcon) {
        $script:NotifyIcon.BalloonTipTitle = $title
        $script:NotifyIcon.BalloonTipText = $text
        $script:NotifyIcon.ShowBalloonTip(3500)
    }
}

function Start-AICouncilServer {
    if (Test-ServerOnline) {
        Update-TrayUi
        Show-TrayNotice "AI Council ativo" "Servidor online na porta $Port. Clique com o botao direito no icone da bandeja para opcoes."
        return $true
    }

    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    Ensure-DistBuilt

    $nodeExe = Find-NodeExecutable
    $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    Add-Content -Path $LogFile -Value "`r`n=== [$stamp] Iniciando AI Council via Bandeja do Windows ===" -Encoding UTF8

    $nodePsi = New-Object System.Diagnostics.ProcessStartInfo
    $nodePsi.FileName = $nodeExe
    $nodePsi.Arguments = "`"$DistEntry`""
    $nodePsi.WorkingDirectory = $RepoDir
    $nodePsi.CreateNoWindow = $true
    $nodePsi.UseShellExecute = $false
    $nodePsi.RedirectStandardOutput = $true
    $nodePsi.RedirectStandardError = $true

    try {
        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $nodePsi
        $proc.Start() | Out-Null
        $script:ServerProcess = $proc
        Set-Content -Path $PidFile -Value $proc.Id -Encoding ASCII

        $logPathLocal = $LogFile
        $outHandler = [System.Diagnostics.DataReceivedEventHandler]{
            param($sender, $e)
            if ($e.Data) {
                try { [System.IO.File]::AppendAllText($logPathLocal, "$($e.Data)`r`n") } catch {}
            }
        }
        $proc.add_OutputDataReceived($outHandler)
        $proc.add_ErrorDataReceived($outHandler)
        $proc.BeginOutputReadLine()
        $proc.BeginErrorReadLine()

        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 200
            if (Test-ServerOnline) { break }
        }

        Update-TrayUi
        if (Test-ServerOnline) {
            Show-TrayNotice "AI Council ligado" "Servidor ativo na porta $Port (PC e celular prontos)."
            return $true
        } else {
            Show-TrayNotice "Falha ao ligar AI Council" "Verifique data\monitor.log para detalhes."
            return $false
        }
    } catch {
        Show-TrayNotice "Erro ao iniciar servidor" $_.Exception.Message
        return $false
    }
}

function Stop-AICouncilServer {
    $stoppedAny = $false

    if ($script:ServerProcess -and -not $script:ServerProcess.HasExited) {
        try {
            $script:ServerProcess.Kill()
            $script:ServerProcess.WaitForExit(3000) | Out-Null
            $stoppedAny = $true
        } catch {}
        $script:ServerProcess = $null
    }

    if (Test-Path $PidFile) {
        $savedPid = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($savedPid -match '^\d+$') {
            $p = Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
            if ($p -and $p.ProcessName -match 'node') {
                Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
                $stoppedAny = $true
            }
        }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }

    if (Test-ServerOnline) {
        try {
            $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
            foreach ($c in $conns) {
                if ($c.OwningProcess -gt 0) {
                    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
                    if ($proc -and $proc.ProcessName -match 'node') {
                        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                        $stoppedAny = $true
                    }
                }
            }
        } catch {}
    }

    Start-Sleep -Milliseconds 300
    Update-TrayUi
    if ($stoppedAny) {
        Show-TrayNotice "AI Council desligado" "O servidor local foi encerrado."
    }
}

function Get-AutostartEnabled {
    return (Test-Path $StartupShortcut)
}

function Set-AutostartEnabled([bool]$enable) {
    if ($enable) {
        $wsh = New-Object -ComObject WScript.Shell
        $sc = $wsh.CreateShortcut($StartupShortcut)
        $sc.TargetPath = "wscript.exe"
        $sc.Arguments = "//B `"$LauncherVbs`""
        $sc.WorkingDirectory = $RepoDir
        $sc.Description = "AI Council - Intelligence Hub (Inicio Automatico)"
        if (Test-Path $IconPath) {
            $sc.IconLocation = "$IconPath,0"
        }
        $sc.Save()
        Show-TrayNotice "Inicio automatico ativado" "O AI Council vai ligar sozinho quando o Windows iniciar."
    } else {
        if (Test-Path $StartupShortcut) {
            Remove-Item $StartupShortcut -Force -ErrorAction SilentlyContinue
        }
        Show-TrayNotice "Inicio automatico desativado" "Voce escolhe quando abrir pelo atalho do AI Council."
    }
}

function Load-TrayIcon {
    if (Test-Path $IconPath) {
        try {
            return New-Object System.Drawing.Icon($IconPath)
        } catch {}
    }
    return [System.Drawing.SystemIcons]::Application
}

# ==========================================================
# UI DA BANDEJA DO WINDOWS (System.Windows.Forms.NotifyIcon)
# ==========================================================

$script:NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:NotifyIcon.Icon = Load-TrayIcon
$script:NotifyIcon.Text = "AI Council - Verificando..."
$script:NotifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$itemStatus = New-Object System.Windows.Forms.ToolStripMenuItem("Status: verificando...")
$itemStatus.Enabled = $false
$itemStatus.Font = New-Object System.Drawing.Font($itemStatus.Font, [System.Drawing.FontStyle]::Bold)

$itemOpen = New-Object System.Windows.Forms.ToolStripMenuItem("Abrir AI Council no navegador")
$itemOpen.Add_Click({
    if (-not (Test-ServerOnline)) {
        Start-AICouncilServer | Out-Null
    }
    Start-Process $DashboardUrl
})

$itemStart = New-Object System.Windows.Forms.ToolStripMenuItem("Ligar servidor")
$itemStart.Add_Click({ Start-AICouncilServer | Out-Null })

$itemStop = New-Object System.Windows.Forms.ToolStripMenuItem("Desligar servidor")
$itemStop.Add_Click({ Stop-AICouncilServer })

$itemRestart = New-Object System.Windows.Forms.ToolStripMenuItem("Reiniciar servidor")
$itemRestart.Add_Click({
    Stop-AICouncilServer
    Start-AICouncilServer | Out-Null
})

$itemAutostart = New-Object System.Windows.Forms.ToolStripMenuItem("Iniciar automaticamente com o Windows")
$itemAutostart.CheckOnClick = $true
$itemAutostart.Checked = Get-AutostartEnabled
$itemAutostart.Add_Click({
    Set-AutostartEnabled $itemAutostart.Checked
})

$itemLog = New-Object System.Windows.Forms.ToolStripMenuItem("Abrir log do servidor (monitor.log)")
$itemLog.Add_Click({
    if (-not (Test-Path $LogFile)) {
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        New-Item -ItemType File -Force -Path $LogFile | Out-Null
    }
    Start-Process notepad.exe "`"$LogFile`""
})

$itemExit = New-Object System.Windows.Forms.ToolStripMenuItem("Sair (desligar e fechar bandeja)")
$itemExit.Add_Click({
    $timer.Stop()
    Stop-AICouncilServer
    $script:NotifyIcon.Visible = $false
    $script:NotifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

$menu.Items.Add($itemStatus) | Out-Null
$menu.Items.Add($itemOpen) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$menu.Items.Add($itemStart) | Out-Null
$menu.Items.Add($itemStop) | Out-Null
$menu.Items.Add($itemRestart) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$menu.Items.Add($itemAutostart) | Out-Null
$menu.Items.Add($itemLog) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$menu.Items.Add($itemExit) | Out-Null

$script:NotifyIcon.ContextMenuStrip = $menu

# Duplo clique no icone da bandeja: liga (se necessario) e abre o navegador
$script:NotifyIcon.Add_DoubleClick({
    if (-not (Test-ServerOnline)) {
        Start-AICouncilServer | Out-Null
    }
    Start-Process $DashboardUrl
})

function Update-TrayUi {
    $online = Test-ServerOnline
    if ($online) {
        $itemStatus.Text = "[ON] Status: Ligado (porta $Port)"
        $script:NotifyIcon.Text = "AI Council - Ligado (:$Port)"
        $itemStart.Enabled = $false
        $itemStop.Enabled = $true
        $itemRestart.Enabled = $true
    } else {
        $itemStatus.Text = "[OFF] Status: Desligado"
        $script:NotifyIcon.Text = "AI Council - Desligado"
        $itemStart.Enabled = $true
        $itemStop.Enabled = $false
        $itemRestart.Enabled = $false
    }
    $itemAutostart.Checked = Get-AutostartEnabled
    $script:LastRunningState = $online
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Update-TrayUi })
$timer.Start()

if (-not $NoAutoStartServer) {
    Start-AICouncilServer | Out-Null
} else {
    Update-TrayUi
}

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $timer.Stop()
    $script:NotifyIcon.Visible = $false
    $script:NotifyIcon.Dispose()
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
}
