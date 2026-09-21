@echo off
rem Downloads the latest unsigned IPA release into ios\builds\
setlocal
set REPO=FastXSkyline/DapperPOS-IOS
set OUT=%~dp0..\builds
if not exist "%OUT%" mkdir "%OUT%"
echo Downloading latest IPA from %REPO% ...
curl -L -o "%OUT%\DapperPOS-unsigned.ipa" "https://github.com/%REPO%/releases/latest/download/DapperPOS-unsigned.ipa"
if errorlevel 1 (
  echo Download FAILED. Check https://github.com/%REPO%/releases
  exit /b 1
)
echo Saved to %OUT%\DapperPOS-unsigned.ipa
endlocal
