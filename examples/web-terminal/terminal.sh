#!/usr/bin/env bash
# Entry point for each browser shell session (ttyd runs this per connection).
#
# App pods run as a fixed non-root UID (65532) that has no /etc/passwd entry,
# which makes bash's \u show "I have no name!" and breaks tools that call
# getpwuid() (whoami, ssh). Where nss_wrapper is available (conda-forge builds
# it for linux-64 only) we overlay a private passwd/group via LD_PRELOAD — the
# standard trick for arbitrary-UID containers — *before* exec'ing bash so the
# shell itself sees it too. Elsewhere we fall back to a $USER-based prompt.
set -u

export USER="${USER:-nebari}"
export LOGNAME="$USER"
export HOME="${HOME:-/app}"

# Ubuntu's /etc/bash.bashrc "sudo hint" calls `groups`, which also fails for
# a UID with no passwd entry; it is skipped when ~/.hushlogin exists.
touch "$HOME/.hushlogin"

lib="$(ls "${CONDA_PREFIX:-}"/lib/libnss_wrapper.so* 2>/dev/null | head -n1 || true)"
if [ -n "$lib" ] && ! getent passwd "$(id -u)" >/dev/null 2>&1; then
  export NSS_WRAPPER_PASSWD="$HOME/.nss_passwd"
  export NSS_WRAPPER_GROUP="$HOME/.nss_group"
  printf '%s:x:%s:%s:%s:%s:/bin/bash\n' "$USER" "$(id -u)" "$(id -g)" "$USER" "$HOME" > "$NSS_WRAPPER_PASSWD"
  printf '%s:x:%s:\n' "$USER" "$(id -g)" > "$NSS_WRAPPER_GROUP"
  export LD_PRELOAD="$lib${LD_PRELOAD:+:$LD_PRELOAD}"
fi

exec bash --rcfile "$(dirname "$0")/bashrc" -i
