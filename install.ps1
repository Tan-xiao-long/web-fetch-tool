# 一键安装 webtool（Windows PowerShell）
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error "请先安装 Node.js >= 18.17"; exit 1 }
node "$dir\install.js" @args
