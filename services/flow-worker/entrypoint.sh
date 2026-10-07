#!/bin/sh
set -eu

# gflow drives a headed Chrome (GFLOW_CLI_HEADLESS=false), so the worker needs an X display. The
# image defaults DISPLAY to :99 and this script owns only that private Xvfb display. A caller that
# passes its own DISPLAY (the documented interactive `gflow auth login` with the host's X11 socket
# mounted) is left alone: nothing is started and no host X11 file is touched.
if [ "${DISPLAY:-:99}" = ":99" ]; then
  export DISPLAY=:99
  # A container restart keeps /tmp, so a killed Xvfb can leave its :99 lock and socket behind.
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  # Xvfb is not supervised after `exec`: it lives exactly as long as the container. `init: true`
  # in Compose reaps it, and the container's stop tears it down with every other process.
  Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/dev/null 2>&1 &
  tries=0
  until [ -S /tmp/.X11-unix/X99 ]; do
    tries=$((tries + 1))
    if [ "$tries" -gt 50 ]; then
      echo "Xvfb did not start on :99" >&2
      exit 1
    fi
    sleep 0.1
  done
fi

exec "$@"
