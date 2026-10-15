#!/bin/sh
# Starts Multicord inside the Flatpak. zypak-wrapper (from the Electron
# BaseApp) lets Chromium's own sandbox run inside Flatpak's.
# Temporary files go to the app's own runtime directory, which the host can see.
export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"
# Wayland app id and window grouping follow the desktop file's name.
export CHROME_DESKTOP="${FLATPAK_ID}.desktop"

# Native Wayland when the session has it and the sandbox may use it; otherwise
# X11 (which Flatpak grants only where there is no Wayland: fallback-x11).
wayland_socket="${WAYLAND_DISPLAY:-wayland-0}"
case "$wayland_socket" in
  /*) ;;
  *) wayland_socket="${XDG_RUNTIME_DIR}/${wayland_socket}" ;;
esac
if [ -S "$wayland_socket" ]; then
  set -- --ozone-platform=wayland --enable-wayland-ime "$@"
else
  set -- --ozone-platform=x11 "$@"
fi

exec zypak-wrapper /app/multicord/multicord "$@"
