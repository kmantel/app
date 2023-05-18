#!/usr/bin/env bash

function powershell() {
    "/mnt/c/windows/system32/WindowsPowerShell/v1.0/powershell.exe" $@
}

if [[ -z "$1" ]]; then
    version="dev"
else
    version="$1"
fi

powershell yarn build:desktop
powershell yarn run webpack --config desktop.webpack."$version".js
APP_VERSION=$(node -p "require('./../web/package.json').version")
powershell yarn run electron-builder --windows --x64 --ia32 --publish=never --c.extraMetadata.version="$APP_VERSION"
