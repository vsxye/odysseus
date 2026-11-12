@echo off
setlocal
cd /d "%~dp0"
rem Command-line version of the assistant, using the venv that run.bat created.
rem   ask.bat                       -> runs the 5 assignment test questions
rem   ask.bat "your question here"  -> answers one question (Stage 3 pipeline)
rem   set ANTHROPIC_API_KEY=...      -> before running, to get real LLM answers
if not exist ".venv\Scripts\python.exe" (
  echo Run run.bat once first - it sets everything up.
  pause
  exit /b 1
)
if "%~1"=="" (
  ".venv\Scripts\python.exe" -m assistant --demo
) else (
  ".venv\Scripts\python.exe" -m assistant %*
)
echo.
pause
