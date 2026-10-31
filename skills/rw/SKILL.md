---
name: rw
description: Work in a directory on a remote ssh host exactly as if it were the local working directory - reading, editing and creating its files and running its commands over ssh. Use when the user gives a remote target like "/home/alice/code/api in devbox" or "devbox:/home/alice/code/api", a bare ssh host like "devbox", or a short rw alias like "api", or asks to code, debug or run tests in a project that lives on a machine they reach by ssh.
argument-hint: "ls | <alias> | <host>:<dir> | <host>  [/remote-skill | task]   e.g. api /run-tests"
hooks:
  PreToolUse:
    - matcher: "Read"
      hooks:
        - type: command
          command: '"$HOME/.claude/skills/rw/rw" hook pre-read'
          timeout: 120
    - matcher: "Grep|Glob"
      hooks:
        - type: command
          command: '"$HOME/.claude/skills/rw/rw" hook guard-search'
  PostToolUse:
    - matcher: "Edit|MultiEdit|Write|NotebookEdit"
      hooks:
        - type: command
          command: '"$HOME/.claude/skills/rw/rw" hook post-write'
          timeout: 120
---

# Remote working directory

Target: **$ARGUMENTS**

Normalize the target to `HOST:DIR` (an ssh host alias and a directory), e.g. `/home/alice/code/api in devbox` → `devbox:/home/alice/code/api`. A single word with no directory (`api`, `devbox`) is kept as it is: `info` resolves it (see "Short targets" below). If the target is just `ls`, the user only wants the alias list: run `${CLAUDE_SKILL_DIR}/rw ls`, show its output as a code block and stop. Don't connect anywhere, and keep your current working directory. If no target is given, show that list the same way and ask which one to use. Words after the target are the user's request: a task, or `/name [args]`, a skill on the remote (see "Remote skills" below). Below, `T` stands for that string and `rw` for `${CLAUDE_SKILL_DIR}/rw`. Write both out in full in every command, because shell state does not carry over between Bash calls.

From now until the user switches target or tells you to stop, DIR on HOST **is your working directory**. Work exactly as you normally would: explore, read, edit, run, test, commit, verify. Only the mechanics change:

| Normally | Here |
|---|---|
| Bash in the cwd | `rw T run '<cmd>'` (bash in DIR on HOST) |
| Read / Edit / Write `DIR/<rel>` | Read / Edit / Write the **mirror path** `M/<rel>` |
| Grep / Glob | `rw T run 'rg -n …'`, `git grep -n`, `git ls-files`, `find` |
| CLAUDE.md in the cwd | the remote CLAUDE.md files that `info` prints |

The local machine is only your terminal. Don't read or change local project files outside the mirror.

## 1. Connect

Run `rw T info`. It checks ssh and resolves DIR. It prints the git state, the tools on the login PATH and the mirror dir `M`. It also prints the agent skills installed on the remote (see "Remote skills") and every CLAUDE.md that applies on the remote: DIR and its parents, plus the remote `~/.claude/CLAUDE.md`. Follow those CLAUDE.md files as you would local project instructions. From then on, use the `target:` line it prints as `T`.

If ssh fails, remember it runs with BatchMode and can't answer prompts. The error says whether the host can't be reached or needs a prompt answered; for a prompt, ask the user to run `! ssh HOST true` once (to accept the host key or unlock their key), then retry. Don't work around it some other way. `rw doctor T` (T as the user gave it) checks the local setup, the connection and the remote's tools, and says what is wrong.

### Short targets

- A bare `HOST` means its home directory, like `HOST:~`.
- A `NAME` listed in the aliases file (`${XDG_CONFIG_HOME:-~/.config}/claude-rw/aliases`, or `$RW_ALIASES` if set; one `NAME HOST:DIR` per line, `#` comments) stands for its `HOST:DIR`. An alias wins over an ssh host of the same name.

Only `info` accepts these. Pass them to it as they are and use the `target:` line it prints as `T` from then on. When the user asks to add, change or remove an alias, edit that file, creating it if it doesn't exist.

## 2. Run commands

```bash
${CLAUDE_SKILL_DIR}/rw T run 'git status --short && git log --oneline -3'

${CLAUDE_SKILL_DIR}/rw T run <<'EOF'
source .venv/bin/activate
pytest -x tests/test_api.py 2>&1 | tail -40
EOF
```

- Arguments are joined into one bash command. Single-quote one-liners so nothing expands locally. A quoted heredoc (`<<'EOF'`) is the safest choice for anything with quotes, `$vars` or several lines.
- Each call is a fresh `bash -l` started in DIR, so `cd`, exports and venv activation don't carry over.
- There is no tty and stdin is /dev/null. Use non-interactive flags (`git --no-pager`, `-y`, `--no-edit`). A command that waits for input gets EOF instead of hanging.
- The exit code is the remote command's. 255 means ssh itself failed.
- Run long builds or test suites with `run_in_background: true` on the Bash call, or give the call a longer timeout. Stopping the local call doesn't reliably stop the remote process, so wrap commands that might hang in `timeout 600 …`.
- Anything that must outlive the call (a dev server, a watcher, a training run, a test suite to check on later) is a job, not `nohup` or `tmux`. `rw T job start NAME '<cmd>'` starts it detached in DIR, with the environment `run` gives, and prints its first lines. `rw T job logs NAME [LINES]` shows its state and the end of its log. `rw T job wait NAME [SECONDS]` waits for it to finish and exits with its exit code, or 124 while it still runs; give long waits `run_in_background: true`. `rw T job ls` lists the host's jobs, `rw T job stop NAME` stops one with its children, and `rw T job rm NAME` deletes a finished one.
- Each call first loads the environment variables the remote's interactive shell startup sets (`~/.bashrc` past its "interactive only" guard: PATH, PYTHONPATH, conda/nvm paths, proxies...), so commands see what the user's own shell sees; `info` lists them under `env:`. rw saves them on the remote and refreshes them when a startup file changes. Don't source `~/.bashrc` yourself. Only variables carry over, not shell functions or aliases: `conda activate` or `nvm use` won't work as commands. If a script needs one, source its setup inside the script (for example `source ~/.nvm/nvm.sh`).

## 3. Files: use the mirror paths

Each session has its own mirror, kept in memory and deleted when the session ends. Remote file `HOST:/abs/path` maps to `<session mirror>/HOST/abs/path`, so `DIR/src/a.py` is `M/src/a.py` (`M` is the `mirror:` line `info` prints). `rw T path src/a.py` prints it. Use mirror paths with Read, Edit and Write. This skill's hooks keep them in sync:

- **Read** on a mirror path fetches the current remote file first. It's always fresh, even for a file you've never opened. If the file doesn't exist on the remote, Read reports it as missing.
- **Edit / Write** uploads the file right afterwards and you'll see `rw: synced to HOST:PATH`. Missing parent directories are created, and existing files keep their permissions.
- The upload is refused with `rw: NOT SYNCED …` in two cases: the remote file changed since you last read it (often another Claude session working in the same directory), or you wrote over a remote file you hadn't read. It's the remote version of "file modified since read". The mirror is reset to the remote content and your version is saved elsewhere (the message gives the path). Read the file again and redo the edit.
- After a remote command that may rewrite files (formatter, codegen, `git checkout/pull/stash/rebase`), Read files again before you edit them.
- Delete, move and chmod remotely with `run` (`git mv`, `rm`, `chmod +x`).
- The mirror holds only the files you've opened. Don't explore it with Grep, Glob or ls (a hook blocks Grep and Glob there); search on the remote instead. Never run project commands locally in the mirror, because it isn't a checkout.
- On a lossy link a transfer can stall. When nothing comes back for 30 s (`RW_STALL_SECS`), rw sets the shared connection aside and retries once over a new one, so a Read or pull may take that long. If it still fails with "the network to HOST is stalling", wait a minute and retry, or tell the user. Don't work around it with your own `ssh`/`scp` through rw's ControlPath: they go over the same stuck connection.
- A file over 10 MB (`RW_MAX_FILE_MB`) isn't moved whole: Read refuses it and says so. Look at parts of it with `run` (`tail -n 200`, `grep -n`, `head -c`), or ask the user before raising the limit.

If you don't see `rw: synced …` after an Edit or Write, the hooks aren't active. In that case run `rw T pull <path>` before each Read and `rw T push <path>` after each edit yourself.

## 4. Other helpers

- `rw T status` lists mirror files whose edits aren't on the remote yet, for example after a failed upload. Check it before you finish; it should be clean. If it isn't, a Stop hook keeps your turn going once and lists the files: push each one after checking it with `diff`, or tell the user why it stays unpushed.
- `rw T diff <path>` diffs the current remote file against the mirror copy.
- `rw T pull -f <path>` throws away mirror edits. `rw T push -f <path>` overwrites the remote even if it changed. Use either only with the user's OK.

## 5. Remote skills

`info` lists the agent skills installed on the remote as `/name`: those of DIR and its repo (`.claude/skills`, `.agents/skills`, `.codex/skills`) and the remote user's (`~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`). `rw T skills` prints the same list as TSV (name, 1 if user-invoked only, description, SKILL.md). Both refresh the cache the prompt box completes `/rw <target> /…` from. They are that machine's own workflows. Run them from there; don't keep local copies.

- The user runs one as `/rw api /run-tests [args]`: a word starting with `/` right after the target names a remote skill. In a later message they may name it as `/run-tests` inside their text ("now use /run-tests", "用 /run-tests"). A skill marked `[user-invoked only]` runs only when the user names it; you may use the others when a task clearly calls for them, as with local skills.
- A `/name` that the remote doesn't list: say so and show the list; don't guess a near match.
- To run one, Read its SKILL.md through its mirror path (`rw T path <the path info listed>`) and follow it as if the Skill tool had loaded it, with the rw mechanics:
  - Lines made of an exclamation mark and a command in backticks (e.g. its "Current State" list) aren't pre-run here: run each command with `rw T run` and use the output.
  - Its arguments placeholder (the word ARGUMENTS after a dollar sign) stands for the rest of the user's words after the skill name.
  - Files it links relative to its own directory are on the remote; Read them through the mirror too.
  - Where it says to ask the user (a question tool, a popup), use AskUserQuestion.
- A local skill with the same name is a different workflow. For work in this target, the remote one wins.

## Reporting

Refer to files by their path relative to DIR (`src/api.py:42`), not by mirror paths. Make git commits, branches and PRs on the remote with `run`, following the usual rules for them.
