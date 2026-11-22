@echo off
setlocal
if "%~1"=="" exit /b 2
set "OUT=%~f1"
set "SOURCE=%~dp0mosaic-files.cpp"
set "FINDER=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq delims=" %%I in (`"%FINDER%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS=%%I"
if not defined VS exit /b 1
call "%VS%\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64
if errorlevel 1 exit /b 1
cl /nologo /std:c++17 /EHsc /W4 "%SOURCE%" /Fe:"%OUT%" /link advapi32.lib ole32.lib
exit /b %ERRORLEVEL%
