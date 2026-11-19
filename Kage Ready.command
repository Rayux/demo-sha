#!/bin/zsh
# Double-click before leaving the Mac: turns on everything Kage needs.
cd "$(dirname "$0")" && node scripts/kage-web/ready.mjs
echo
read -sk 1 "?Press any key to close."
