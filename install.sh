#!/usr/bin/env bash
# 一键安装 webtool（Linux / macOS）
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null || { echo "请先安装 Node.js >= 18.17"; exit 1; }
exec node "$DIR/install.js" "$@"
