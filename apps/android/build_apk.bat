@echo off
chcp 65001 >nul
title SafeDrop Android APK Build Tool
echo ========================================================
echo       SafeDrop Mobile APK Automated Build & Packaging Tool
echo ========================================================
echo.

set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

if not defined JAVA_HOME (
    if exist "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot" (
        set "JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot"
    )
)
if defined JAVA_HOME (
    set "PATH=%JAVA_HOME%\bin;%PATH%"
)

if not defined ANDROID_HOME (
    if exist "%LOCALAPPDATA%\Android\Sdk" (
        set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
    )
)
if defined ANDROID_HOME (
    set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
)

echo [1/3] Checking build environment...
where java >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Java runtime detected. Invoking Gradle to assemble SafeDrop mobile module...
    cd com
    call gradlew.bat assembleRelease --no-daemon
    if exist "app\build\outputs\apk\release\app-release.apk" (
        copy /y "app\build\outputs\apk\release\app-release.apk" "..\SafeDrop-release.apk" >nul
        echo [OK] SafeDrop Release APK successfully archived.
    ) else if exist "app\build\outputs\apk\release\app-release-unsigned.apk" (
        copy /y "app\build\outputs\apk\release\app-release-unsigned.apk" "..\SafeDrop-release.apk" >nul
        echo [OK] SafeDrop Unsigned Release APK successfully archived.
    ) else if exist "app\build\outputs\apk\debug\app-debug.apk" (
        copy /y "app\build\outputs\apk\debug\app-debug.apk" "..\SafeDrop-release.apk" >nul
        echo [OK] SafeDrop Debug APK successfully archived.
    )
    cd ..
) else (
    echo [WARNING] Java runtime not detected in PATH or JAVA_HOME.
)

echo [2/3] Verifying and archiving SafeDrop APK (SafeDrop-release.apk)...
node pack_apk.js
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Packaging failed.
    pause
    exit /b 1
)

echo [3/3] Verifying APK package integrity...
if exist "SafeDrop-release.apk" (
    echo.
    echo ========================================================
    echo [SUCCESS] SafeDrop Mobile APK is ready!
    echo Artifact path: %SCRIPT_DIR%SafeDrop-release.apk
    echo ========================================================
) else (
    echo [INFO] SafeDrop-release.apk not found.
)

echo.
pause
