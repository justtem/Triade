@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title AI Council — Inicializador Rapido

cd /d "%~dp0"

echo ==========================================================
echo   AI COUNCIL — INTELLIGENCE HUB (INICIALIZADOR RAPIDO)
echo ==========================================================
echo.

REM 1. Verifica se Node.js >= 20 esta instalado
where node >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado neste computador.
    echo.
    echo Instale o Node.js 20 LTS ou superior em: https://nodejs.org/
    echo Depois execute este arquivo novamente.
    echo.
    choice /C SN /M "Deseja abrir o site oficial do Node.js agora"
    if errorlevel 2 exit /b 1
    start "" "https://nodejs.org/"
    exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -v') do set "NODE_RAW=%%v"
set "NODE_MAJOR=%NODE_RAW:v=%"
if %NODE_MAJOR% LSS 20 (
    echo [ERRO] Node.js v%NODE_MAJOR% detectado. O AI Council precisa de Node.js 20 ou superior.
    echo Baixe a versao LTS em: https://nodejs.org/
    echo.
    pause
    exit /b 1
)
echo [OK] Node.js detectado (v%NODE_MAJOR%+).

REM 2. Instala dependencias na primeira execucao
if not exist "node_modules\" (
    echo.
    echo [1/3] Instalando dependencias pela primeira vez...
    call npm.cmd install
    if errorlevel 1 (
        echo [ERRO] Falha ao instalar dependencias. Verifique sua conexao com a internet.
        pause
        exit /b 1
    )
)

REM 3. Compila TypeScript se ainda nao existir dist\monitor.js
if not exist "dist\monitor.js" (
    echo.
    echo [2/3] Compilando AI Council...
    call npm.cmd run build
    if errorlevel 1 (
        echo [ERRO] Falha ao compilar o projeto.
        pause
        exit /b 1
    )
)

REM 4. Le porta customizada do .env (padrao 4317)
set "PORT=4317"
if exist ".env" (
    for /f "usebackq tokens=1,2 delims==" %%a in (".env") do (
        if /I "%%a"=="PORT" set "PORT=%%b"
    )
)

REM 5. Inicia na Bandeja do Windows (ou direto via node se o script VBS nao existir)
echo.
echo [3/3] Iniciando AI Council na porta %PORT%...
if exist "scripts\win\launch-tray.vbs" (
    start "" wscript.exe //B "%~dp0scripts\win\launch-tray.vbs"
) else (
    start "" /B node dist\monitor.js
)

REM Aguarda o servidor responder (ate 12 segundos)
set "READY=0"
for /L %%i in (1,1,12) do (
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT%/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
    if not errorlevel 1 (
        set "READY=1"
        goto :open_browser
    )
    timeout /t 1 /nobreak >nul
)

:open_browser
echo [OK] Abrindo http://127.0.0.1:%PORT% no navegador...
start "" "http://127.0.0.1:%PORT%"
exit /b 0
