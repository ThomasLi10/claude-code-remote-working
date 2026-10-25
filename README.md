# claude-code-remote-working

English | [简体中文](README.zh-CN.md)

**Work on any SSH host from Claude Code as if it were your local working directory.**

`/rw devbox:/home/alice/code/api` points Claude at a directory on another machine. From then on it explores, edits, runs tests and commits there the way it would locally, over plain ssh. Nothing is installed on the remote, and your Claude Code setup (login, settings, skills, MCP servers) stays on your machine.

```text
/rw devbox:~/code/api fix the failing test in tests/test_auth.py
/rw api /run-tests          # run a skill that lives on the remote
/rw devbox:~/co<Tab>        # complete hosts and remote directories
/rw ls                      # list your aliases: instant, no model call
```

## How it works

- **Commands** run as `rw T run '<cmd>'`: a fresh `bash -l` in the remote directory. The variables the remote's interactive shell startup sets (PATH, conda, nvm, proxies, ...) are captured once, cached on the remote and loaded before every command, so commands see what your own shell there sees. ssh connections are multiplexed (`ControlMaster`), so repeated calls are fast.
- **Files** are read and edited through a local mirror: remote `HOST:/abs/path` is `<mirror>/HOST/abs/path`. Hooks make the mirror transparent:
  - *Read* fetches the current remote file first, so a read is never stale.
  - *Edit* and *Write* upload the file right away. The transfer is checked with sha256, missing parent directories are created and existing files keep their permissions.
  - An upload is refused if the remote file changed since Claude last read it (another Claude session, a formatter, `git checkout`, an editor). The mirror is reset to the remote version and Claude's version is saved aside, so nothing is overwritten silently.
- **Each session has its own mirror**: in memory (`/dev/shm`), private (`umask 077`), and deleted when the session ends unless it holds edits that never reached the remote.
- **Remote context**: connecting prints the remote's git state and tools, every `CLAUDE.md` that applies there, and the agent skills installed on the remote (`.claude/skills`, `.agents/skills`, `.codex/skills` of the directory, its repo and the remote user), which you run as `/rw <target> /<skill>`.
- **Guard rails**: Grep and Glob are blocked inside the mirror, which only holds the files Claude opened; Claude searches on the remote with `rg`, `git grep` or `find` instead. A file over 10 MB is not moved whole, and Claude is told to look at parts of it with `tail` or `grep` on the remote. While the session's mirror holds edits that never reached the remote, a Stop hook keeps Claude's turn going once and lists them.

## Requirements

- Claude Code (tested with 2.1.310) on Linux, with bash, ssh, base64, sha256sum (or shasum), awk, sed and diff.
- Key-based ssh to the remote that works without prompts: rw runs ssh with `BatchMode=yes`. Run `ssh HOST true` once to accept a new host key, and use ssh-agent for a key with a passphrase.
- On the remote: bash, base64, and sha256sum, shasum or openssl. git and ripgrep are used when present.

## Install

```bash
git clone https://github.com/ThomasLi10/claude-code-remote-working.git ~/code/claude-code-remote-working \
  && ~/code/claude-code-remote-working/install.sh
```

`install.sh` links `~/.claude/skills/rw` to `skills/rw` in the checkout and creates `~/.config/claude-rw/aliases` from the example. An existing `~/.claude/skills/rw` is moved to `~/.local/state/claude-rw/backups/` first, and its `aliases` file is carried over. The script is safe to run again.

The skill directory is also a Claude Code plugin, `rw@skills-dir`, which Claude Code loads from the skills folder by itself. Its hooks complete hosts, remote directories, aliases and remote skills after `/rw`, show the current target in the status line, answer `/rw ls` without a model call, keep a turn from ending with unpushed edits, and clean up mirrors at session end, so there is nothing to add to `settings.json`.

**Update:** `git -C ~/code/claude-code-remote-working pull`. Because of the link, the new version is live at once; hook changes apply in the next session or after `/reload-plugins`.

**Uninstall:** `~/code/claude-code-remote-working/install.sh --uninstall` removes the link and keeps your aliases.

## Usage

| You type | What happens |
|---|---|
| `/rw devbox:/home/alice/code/api` | that directory becomes Claude's working directory |
| `/rw /home/alice/code/api in devbox` | the same, in words |
| `/rw devbox` | the remote home directory |
| `/rw api <task>` | an alias, followed by what you want done |
| `/rw api /run-tests [args]` | run the remote's own `run-tests` skill there |
| `/rw ls`, or just `/rw` | list the aliases and recent targets |

The prompt box completes as you type:

- `/rw` lists every alias, recent target and ssh host (from `~/.ssh/config`). After `/rw ` the dim hint names your aliases, and the first letters narrow the list.
- Taking a host writes `host:` and lists the directories in its home; taking a directory lists its subdirectories, so you can walk down to the project. Git repos are marked.
- After `/rw <target> /` it lists the skills installed on that host.

Directory listings go over rw's shared ssh connection and join the list when they arrive, so typing never waits on ssh. The status line under the prompt shows the target rw last worked in.

Claude keeps working on the remote until you switch targets or tell it to stop. To add an alias, ask: "add an rw alias `api` for devbox:/home/alice/code/api".

`/rw ls` is answered by a hook, so it costs no tokens. Claude Code shows the list under a "UserPromptExpansion operation blocked by hook" header, which is how a hook answers a command without starting a model turn.

## Aliases

The aliases file is `~/.config/claude-rw/aliases` (`$XDG_CONFIG_HOME/claude-rw/aliases` if that is set, or the file `$RW_ALIASES` names), one alias per line:

```text
# NAME  HOST:DIR
api     devbox:/home/alice/code/api
web     devbox:~/code/web
gpu     alice@gpu.example.com:/data/train
```

HOST is anything ssh accepts. An alias wins over an ssh host of the same name. Directories can't contain spaces.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RW_ALIASES` | `~/.config/claude-rw/aliases` | the aliases file |
| `RW_SSH_OPTS` | (none) | extra ssh options, e.g. `-o ProxyJump=bastion`; they take precedence over rw's defaults |
| `RW_MIRROR_BASE` | `/dev/shm/claude-remote`, or `$TMPDIR/claude-remote-$UID` without `/dev/shm` | where the session mirrors live |
| `RW_MIRROR` | (none) | one fixed mirror directory instead of one per session |
| `RW_MAX_FILE_MB` | `10` | files bigger than this are not moved whole through the mirror; `0` turns the limit off |

## Where things are

| What | Path |
|---|---|
| the skill (a link to this checkout) | `~/.claude/skills/rw` |
| your aliases | `~/.config/claude-rw/aliases` |
| session mirrors | `/dev/shm/claude-remote/<session id>/` |
| remote skill lists cached for Tab completion | `~/.cache/claude-rw/skills/` |
| targets rw connected to lately | `~/.cache/claude-rw/recent` |
| captured shell environment, on each remote (mode 600) | `~/.cache/rw/env.sh` |
| backups made by `install.sh` | `~/.local/state/claude-rw/backups/` |

## Limitations

- There is no tty: commands get EOF on stdin, so use non-interactive flags. Servers and watchers go in `nohup … &` or a tmux session on the remote.
- The mirror only holds the files Claude has opened; searching happens on the remote.
- Every read and write moves the whole file (base64 over ssh): fine for source files, too slow for big ones, which is why files over `RW_MAX_FILE_MB` are refused.
- Tested with Linux on both ends.

## Repository layout

```text
install.sh                          install, update and uninstall
skills/rw/SKILL.md                  the skill: how Claude works through rw
skills/rw/rw                        the bash tool behind it: run, path, pull, push, diff, status, skills, hooks
skills/rw/aliases.example           template for ~/.config/claude-rw/aliases
skills/rw/.claude-plugin/plugin.json
skills/rw/hooks/hooks.json          plugin hooks: instant /rw ls, session-end cleanup
skills/rw/hooks/register.ts         completion and status line for /rw (a hooks module)
```

## License

[MIT](LICENSE)
