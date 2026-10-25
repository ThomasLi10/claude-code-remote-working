#!/usr/bin/env bash
# Install the rw skill for Claude Code: link ~/.claude/skills/rw to this checkout, so that a
# `git pull` here updates it.
#
#   ./install.sh               install, or repair an install (safe to run again)
#   ./install.sh --uninstall   remove the link; your aliases and caches stay
#
# An existing ~/.claude/skills/rw that is not this checkout is moved to
# ${XDG_STATE_HOME:-~/.local/state}/claude-rw/backups/ first, and its aliases file is copied to
# ${XDG_CONFIG_HOME:-~/.config}/claude-rw/aliases unless there is one already.

set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SRC=$REPO/skills/rw
DEST=$HOME/.claude/skills/rw
CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}/claude-rw
ALIASES=$CONFIG/aliases
BACKUPS=${XDG_STATE_HOME:-$HOME/.local/state}/claude-rw/backups

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
tilde() { case $1 in "$HOME"|"$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }
links_here() { [ -L "$DEST" ] && [ "$(readlink "$DEST")" = "$SRC" ]; }

install() {
  [ -f "$SRC/SKILL.md" ] && [ -f "$SRC/rw" ] || die "$SRC is incomplete; run this from a full checkout"
  chmod +x "$SRC/rw"

  local tool backup missing=()
  for tool in ssh base64 awk sed diff mktemp; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || missing+=("sha256sum or shasum")
  [ ${#missing[@]} -eq 0 ] || warn "rw needs these tools, which are not on PATH: ${missing[*]}"
  command -v claude >/dev/null 2>&1 || warn "claude is not on PATH; install Claude Code before using /rw"

  if links_here; then
    say "already installed: $(tilde "$DEST") -> $SRC"
  else
    if [ -e "$DEST" ] || [ -L "$DEST" ]; then
      backup=$BACKUPS/$(date +%Y%m%d-%H%M%S)
      mkdir -p "$backup"
      if [ -f "$DEST/aliases" ]; then
        if [ ! -e "$ALIASES" ]; then
          mkdir -p "$CONFIG" && cp -p "$DEST/aliases" "$ALIASES"
          say "moved your aliases to $(tilde "$ALIASES")"
        elif ! cmp -s "$DEST/aliases" "$ALIASES"; then
          warn "kept $(tilde "$ALIASES"); the old install's different aliases file is in the backup"
        fi
      fi
      mv -- "$DEST" "$backup/rw"
      say "moved the old $(tilde "$DEST") to $(tilde "$backup/rw")"
    fi
    mkdir -p "$(dirname "$DEST")"
    ln -s "$SRC" "$DEST"
    say "linked $(tilde "$DEST") -> $SRC"
  fi

  if [ ! -e "$ALIASES" ]; then
    mkdir -p "$CONFIG" && cp "$SRC/aliases.example" "$ALIASES"
    say "created $(tilde "$ALIASES") from the example; add your hosts there"
  fi

  if grep -qsE 'skills/rw/rw[\\"]* hook session-end' "$HOME/.claude/settings.json"; then
    say "note: ~/.claude/settings.json still has an old SessionEnd hook for rw. The skill brings its own"
    say "      now, so that entry only makes the cleanup run twice (harmless); you can delete it."
  fi

  "$DEST/rw" ls >/dev/null || die "$(tilde "$DEST")/rw does not run"
  if command -v claude >/dev/null 2>&1; then
    if claude plugin list --json 2>/dev/null | grep -q '"rw@skills-dir"'; then
      say "Claude Code loads the skill's hooks (rw@skills-dir)"
    else
      warn "'claude plugin list' does not show rw@skills-dir. /rw still works, but /rw ls goes through the model and session mirrors are not cleaned up; a newer Claude Code fixes this"
    fi
  fi

  say ""
  say "Done. In a new Claude Code session (or after /reload-plugins) try:  /rw ls"
  say "Update later with:  git -C $(tilde "$REPO") pull"
}

uninstall() {
  if links_here; then
    rm -- "$DEST"
    say "removed $(tilde "$DEST")"
  elif [ -e "$DEST" ] || [ -L "$DEST" ]; then
    die "$(tilde "$DEST") is not a link to this checkout; leaving it alone"
  else
    say "nothing to remove: $(tilde "$DEST") does not exist"
  fi
  say "kept your aliases ($(tilde "$ALIASES")) and the cache in ~/.cache/claude-rw"
}

case ${1:-} in
  '') install ;;
  --uninstall) uninstall ;;
  -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown option: $1 (see --help)" ;;
esac
