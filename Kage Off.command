#!/bin/zsh
# Double-click when you are back at the Mac: lets it sleep again and disconnects Tailscale.
cd "$(dirname "$0")" && node scripts/kage-web/off.mjs
echo
read -sk 1 "?Press any key to close."
