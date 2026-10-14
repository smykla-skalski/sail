#!/bin/sh
# Keep ordinary Git calls native; only the deliberately blocked calls need Node.
real_git=${SAIL_E2E_REAL_GIT:-/usr/bin/git}
case "$real_git" in
  /*) ;;
  *) printf '%s\n' 'SAIL_E2E_REAL_GIT must be an absolute executable path' >&2; exit 1 ;;
esac
delay_directory=${SAIL_E2E_SLOW_GIT_DIR:-}
if [ -n "$delay_directory" ] && [ -f "$delay_directory/block-path" ] && delayed_path=$(cat "$delay_directory/block-path" 2>/dev/null); then
  required_argument=$(cat "$delay_directory/block-argument" 2>/dev/null) || required_argument=
  path_matches=false
  argument_matches=false
  [ -n "$required_argument" ] || argument_matches=true
  previous=
  for argument do
    if [ "$previous" = '-C' ] && [ "$argument" = "$delayed_path" ]; then
      path_matches=true
    fi
    [ "$argument" != "$required_argument" ] || argument_matches=true
    previous=$argument
  done
  if [ "$path_matches" = true ] && [ "$argument_matches" = true ]; then
    exec "${SAIL_E2E_NODE:-node}" "${0%/*}/slow-git.mjs" "$@"
  fi
fi
exec "$real_git" "$@"
