# Cria os atalhos oficiais do AI Council na Area de Trabalho e no Menu Iniciar
# (e opcionalmente ativa ou desativa o inicio automatico com o Windows).

param(
    [switch]$EnableAutostart,
    [switch]$DisableAutostart
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$LauncherVbs = Join-Path $ScriptDir "launch-tray.vbs"
$IconPath = Join-Path $RepoDir "public\icons\ai-council.ico"

if (-not (Test-Path $LauncherVbs)) {
    throw "Launcher nao encontrado em $LauncherVbs"
}

$wsh = New-Object -ComObject WScript.Shell

function New-AICouncilShortcut([string]$shortcutPath, [string]$description) {
    $parent = Split-Path -Parent $shortcutPath
    if (-not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $sc = $wsh.CreateShortcut($shortcutPath)
    $sc.TargetPath = "wscript.exe"
    $sc.Arguments = "//B `"$LauncherVbs`""
    $sc.WorkingDirectory = $RepoDir
    $sc.Description = $description
    if (Test-Path $IconPath) {
        $sc.IconLocation = "$IconPath,0"
    }
    $sc.Save()
}

$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "AI Council.lnk"
$startMenuShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "AI Council.lnk"
$startupShortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "AI Council.lnk"

New-AICouncilShortcut $desktopShortcut "AI Council - Intelligence Hub (Bandeja do Windows)"
New-AICouncilShortcut $startMenuShortcut "AI Council - Intelligence Hub (Bandeja do Windows)"

Write-Host "[OK] Atalho criado na Area de Trabalho: $desktopShortcut"
Write-Host "[OK] Atalho criado no Menu Iniciar:     $startMenuShortcut"

if ($EnableAutostart) {
    New-AICouncilShortcut $startupShortcut "AI Council - Intelligence Hub (Inicio Automatico)"
    Write-Host "[OK] Inicio automatico com o Windows: ATIVADO"
} elseif ($DisableAutostart) {
    if (Test-Path $startupShortcut) {
        Remove-Item $startupShortcut -Force
    }
    Write-Host "[OK] Inicio automatico com o Windows: DESATIVADO"
} else {
    $autoState = if (Test-Path $startupShortcut) { "ATIVADO" } else { "DESATIVADO (ative quando quiser pelo menu da bandeja)" }
    Write-Host "[INFO] Inicio automatico com o Windows: $autoState"
}
