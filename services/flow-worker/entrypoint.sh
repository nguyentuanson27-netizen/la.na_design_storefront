#!/bin/sh
set -e

Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/dev/null 2>&1 &
XVFBPID=$!
trap 'kill $XVFBPID 2>/dev/null' EXIT INT TERM
sleep 1

export DISPLAY=:99
exec "$@"
