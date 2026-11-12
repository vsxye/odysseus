@echo off
setlocal EnableExtensions
title TechMart Product Assistant
cd /d "%~dp0"

rem ---------------------------------------------------------------------
rem  One-click launcher.
rem  1. Downloads a private, portable Python 3.12 into .runtime\  (first run only)
rem     - no installer, no PATH changes, no registry, does not touch any
rem       Python already on this PC.
rem  2. Creates an isolated virtual environment in .venv\  (first run only)
rem  3. Installs requirements.txt into that venv           (first run only)
rem  4. Installs Ollama (free, open-source, per-user) + the small
rem     qwen2.5:3b model if missing, so answers come from a real LLM
rem     with no API key.                                  (first run only)
rem  5. Starts a local server and opens the demo in your browser.
rem  To uninstall: just delete this folder.
rem ---------------------------------------------------------------------

set "PY_VER=3.12.10"
set "RUNTIME=%~dp0.runtime"
set "PY_HOME=%RUNTIME%\python\tools"
set "BASE_PY=%PY_HOME%\python.exe"
set "VENV=%~dp0.venv"
set "VPY=%VENV%\Scripts\python.exe"
if not defined LLM_MODEL set "LLM_MODEL=qwen2.5:3b"

echo.
echo  ================================================
echo    TechMart Product Assistant - local launcher
echo  ================================================
echo.

if exist "%VPY%" goto :deps

rem ---- 1. portable Python --------------------------------------------
if exist "%BASE_PY%" goto :venv
echo  [1/3] Downloading portable Python %PY_VER% (about 15 MB, one time only)...
if not exist "%RUNTIME%" mkdir "%RUNTIME%"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue';" ^
  "Invoke-WebRequest -UseBasicParsing -Uri 'https://api.nuget.org/v3-flatcontainer/python/%PY_VER%/python.%PY_VER%.nupkg' -OutFile '%RUNTIME%\python.zip';" ^
  "Expand-Archive -Force -Path '%RUNTIME%\python.zip' -DestinationPath '%RUNTIME%\python';" ^
  "Remove-Item -Force '%RUNTIME%\python.zip'"
if errorlevel 1 goto :fail_download
if not exist "%BASE_PY%" goto :fail_download

:venv
rem ---- 2. virtual environment ----------------------------------------
echo  [2/3] Creating isolated virtual environment in .venv ...
"%BASE_PY%" -m venv "%VENV%"
if errorlevel 1 goto :fail_venv

:deps
rem ---- 3. dependencies (re-run only when requirements.txt changes) ----
fc /b "requirements.txt" "%VENV%\.installed-requirements.txt" >nul 2>&1
if not errorlevel 1 goto :llm
echo  [3/3] Installing dependencies into .venv ...
"%VPY%" -m pip install --disable-pip-version-check --no-warn-script-location -q --upgrade pip
"%VPY%" -m pip install --disable-pip-version-check --no-warn-script-location -q -r requirements.txt
if errorlevel 1 goto :fail_pip
copy /y "requirements.txt" "%VENV%\.installed-requirements.txt" >nul

:llm
rem ---- 4. free local LLM (Ollama + a small open-source model) --------
rem  Set TECHMART_SKIP_LLM=1 to skip; the app then uses rule-based answers.
if "%TECHMART_SKIP_LLM%"=="1" goto :run
set "OLLAMA_EXE="
for /f "delims=" %%i in ('where ollama 2^>nul') do if not defined OLLAMA_EXE set "OLLAMA_EXE=%%i"
if not defined OLLAMA_EXE if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if defined OLLAMA_EXE goto :ollama_up

echo  [LLM] Installing Ollama - free, open-source local LLM runtime (per-user, about 1 GB, one time only)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue';" ^
  "Invoke-WebRequest -UseBasicParsing -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile '%RUNTIME%\OllamaSetup.exe'"
if errorlevel 1 goto :llm_fail
"%RUNTIME%\OllamaSetup.exe" /VERYSILENT /NORESTART /SUPPRESSMSGBOXES
del /q "%RUNTIME%\OllamaSetup.exe" >nul 2>&1
set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if not exist "%OLLAMA_EXE%" goto :llm_fail

:ollama_up
set /a OLLAMA_TRIES=0
curl -s -m 2 http://127.0.0.1:11434/api/version >nul 2>&1
if not errorlevel 1 goto :model
echo  [LLM] Starting Ollama...
start "Ollama" /min "%OLLAMA_EXE%" serve
:wait_ollama
ping -n 2 127.0.0.1 >nul
curl -s -m 2 http://127.0.0.1:11434/api/version >nul 2>&1
if not errorlevel 1 goto :model
set /a OLLAMA_TRIES+=1
if %OLLAMA_TRIES% GEQ 30 goto :llm_fail
goto :wait_ollama

:model
"%OLLAMA_EXE%" list 2>nul | findstr /i /b /c:"%LLM_MODEL% " >nul
if not errorlevel 1 goto :llm_ok
echo  [LLM] Downloading model %LLM_MODEL% (about 2 GB, one time only)...
"%OLLAMA_EXE%" pull %LLM_MODEL%
if errorlevel 1 goto :llm_fail
:llm_ok
set "TECHMART_LOCAL_MODEL=%LLM_MODEL%"
echo  [LLM] Local model ready: %LLM_MODEL%
goto :run

:llm_fail
echo.
echo  NOTE: the local LLM could not be set up. The app still works with
echo  rule-based answers. Run run.bat again later to retry.
echo.

:run
echo.
echo  Setup OK. Starting the demo...
"%VPY%" "%~dp0scripts\serve.py"
goto :end

:fail_download
echo.
echo  ERROR: could not download portable Python.
echo  Check your internet connection (or proxy/antivirus) and run run.bat again.
goto :pause_end

:fail_venv
echo.
echo  ERROR: could not create the virtual environment.
echo  Delete the .runtime and .venv folders and run run.bat again.
goto :pause_end

:fail_pip
echo.
echo  NOTE: optional Python packages did not install (often the Windows
echo  260-character path limit - move this folder somewhere shorter, e.g. C:\TechMart).
echo  The web app and the LLM do not need them, so continuing...
copy /y "requirements.txt" "%VENV%\.installed-requirements.txt" >nul
goto :llm

:pause_end
echo.
pause
:end
endlocal
