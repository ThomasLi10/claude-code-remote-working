# claude-code-remote-working

[English](README.md) | 简体中文

**在 Claude Code 里像操作本地工作目录一样，在任意 SSH 主机上工作。**

`/rw devbox:/home/alice/code/api` 把 Claude 指向另一台机器上的一个目录。之后它就在那里浏览代码、修改文件、跑测试、提交，和在本地时一样，全部走普通的 ssh。远端不需要安装任何东西，你的 Claude Code 配置（登录、设置、skill、MCP server）都留在本机。

```text
/rw devbox:~/code/api 修一下 tests/test_auth.py 里失败的测试
/rw api /run-tests          # 运行远端机器上的 skill
/rw devbox:~/co<Tab>        # 补全 host 和远端目录
/rw ls                      # 列出 alias：立即显示，不调用模型
```

## 工作原理

- **命令**通过 `rw T run '<cmd>'` 执行：每次在远端目录里起一个新的 `bash -l`。远端交互式 shell 启动时设置的变量（PATH、conda、nvm、代理……）会被采集一次、缓存在远端，并在每条命令前加载，所以命令看到的环境和你自己在那台机器上的 shell 一样。ssh 连接是复用的（`ControlMaster`），连续调用很快。
- **文件**通过本地镜像读写：远端的 `HOST:/abs/path` 对应 `<镜像>/HOST/abs/path`，由 hook 保证镜像对 Claude 透明：
  - *Read* 之前先拉取远端当前的文件，读到的永远是最新内容。
  - *Edit* / *Write* 之后立即上传：传输用 sha256 校验，自动创建缺失的父目录，已有文件保留原权限。
  - 如果远端文件在 Claude 上次读取之后被改过（另一个 Claude 会话、格式化工具、`git checkout`、编辑器），上传会被拒绝：镜像重置为远端版本，Claude 的版本另存一份，不会悄悄覆盖任何东西。
- **每个会话有自己的镜像**：放在内存里（`/dev/shm`），权限私有（`umask 077`），会话结束时删除；如果里面还有没传到远端的修改，就会保留。
- **远端上下文**：连接时会打印远端的 git 状态和可用工具、所有适用的 `CLAUDE.md`，以及远端安装的 agent skill（目录、所在仓库和远端用户的 `.claude/skills`、`.agents/skills`、`.codex/skills`），可以用 `/rw <target> /<skill>` 运行。
- **后台任务**：`rw T job start NAME '<cmd>'` 在远端以脱离 ssh 的方式运行需要长期存在的命令（dev server、训练、长时间的测试），目录和环境与 `run` 相同，日志和退出码都留在远端。用 `job logs`、`job wait`、`job stop`、`job ls` 管理，Claude 可以先把任务跑起来，继续做别的，再回来看结果。
- **防护**：镜像里只有 Claude 打开过的文件，所以在镜像里用 Grep 和 Glob 会被拦下，Claude 改用远端的 `rg`、`git grep` 或 `find` 搜索。超过 10 MB 的文件不会整个传输，Claude 会被提示改用远端的 `tail`、`grep` 看局部。会话镜像里还有没传到远端的修改时，Stop hook 会让 Claude 这一轮先不结束，并列出这些文件（只拦一次）。

## 环境要求

- Linux 上的 Claude Code（在 2.1.310 上测试过），以及 bash、ssh、base64、sha256sum（或 shasum）、awk、sed、diff。
- 到远端的 ssh 要用密钥认证，并且不需要任何交互：rw 以 `BatchMode=yes` 运行 ssh。新主机先手动执行一次 `ssh HOST true` 接受主机指纹；带口令的密钥请用 ssh-agent。
- 远端需要：bash、base64，以及 sha256sum、shasum 或 openssl 之一。有 git 和 ripgrep 时会用上。

## 安装

```bash
git clone https://github.com/ThomasLi10/claude-code-remote-working.git ~/code/claude-code-remote-working \
  && ~/code/claude-code-remote-working/install.sh
```

`install.sh` 会把 `~/.claude/skills/rw` 软链到仓库里的 `skills/rw`，并用模板生成 `~/.config/claude-rw/aliases`。如果 `~/.claude/skills/rw` 已经存在，会先整个移到 `~/.local/state/claude-rw/backups/`，其中的 `aliases` 文件会迁移过来。脚本可以重复执行。

skill 目录本身也是一个 Claude Code 插件（`rw@skills-dir`），Claude Code 会从 skills 目录自动加载它。插件的 hook 负责：`/rw` 之后补全 host、远端目录、alias 和远端 skill；在状态栏显示当前目标；不经模型直接响应 `/rw ls`；镜像里还有未同步的修改时不让这一轮结束；会话结束时清理镜像。所以不需要改 `settings.json`。

**检查**：`~/.claude/skills/rw/rw doctor <host 或 alias>` 先检查本机配置，再检查 ssh 能否免交互登录、远端工具是否齐全、shell 环境能否采集、目录是否存在，并告诉你该改什么。

**更新**：`git -C ~/code/claude-code-remote-working pull`。因为是软链，新版本立即生效；hook 的改动在下一个会话或执行 `/reload-plugins` 后生效。

**卸载**：`~/code/claude-code-remote-working/install.sh --uninstall`，只删除软链，保留你的 alias。

## 用法

| 输入 | 效果 |
|---|---|
| `/rw devbox:/home/alice/code/api` | 这个目录成为 Claude 的工作目录 |
| `/rw /home/alice/code/api in devbox` | 同上，换一种说法 |
| `/rw devbox` | 远端的 home 目录 |
| `/rw api <任务>` | 用 alias 指定目标，后面接要做的事 |
| `/rw api /run-tests [参数]` | 在远端运行它自己的 `run-tests` skill |
| `/rw ls`，或者只输入 `/rw` | 列出 alias 和最近用过的目标 |

输入框会边输入边补全：

- 敲 `/rw` 就列出所有 alias、最近用过的目标和 ssh host（来自 `~/.ssh/config`）。敲了空格后，灰色提示会显示你的 alias 名；再敲几个字母，列表按前缀过滤。
- 选中一个 host 会写入 `host:` 并列出它 home 下的目录；再选中目录，就列出下一层子目录，一路走到项目目录。git 仓库会有标记。
- 在 `/rw <目标> /` 之后，列出那台机器上安装的 skill。

列目录走的是 rw 共享的 ssh 连接，结果到了才加入列表，输入时不用等 ssh。输入框下方的状态栏会显示 rw 最近一次工作的目标。

在你切换目标或让它停下之前，Claude 会一直在远端工作。要加 alias，直接说："加一个 rw alias `api`，指向 devbox:/home/alice/code/api"。

`/rw ls` 由 hook 直接响应，不消耗 token。Claude Code 会把列表显示在 "UserPromptExpansion operation blocked by hook" 标题下面，这是 hook 不启动模型就回应一条命令时的显示方式。

## Alias

alias 文件是 `~/.config/claude-rw/aliases`（设置了 `$XDG_CONFIG_HOME` 时是 `$XDG_CONFIG_HOME/claude-rw/aliases`，或者 `$RW_ALIASES` 指定的文件），每行一个：

```text
# 名字  HOST:目录
api     devbox:/home/alice/code/api
web     devbox:~/code/web
gpu     alice@gpu.example.com:/data/train
```

HOST 可以是 ssh 能接受的任何写法。alias 和 ssh 主机同名时，alias 优先。目录里不能有空格。

## 配置

| 变量 | 默认值 | 含义 |
|---|---|---|
| `RW_ALIASES` | `~/.config/claude-rw/aliases` | alias 文件 |
| `RW_SSH_OPTS` | （无） | 额外的 ssh 选项，比如 `-o ProxyJump=bastion`，优先于 rw 的默认选项 |
| `RW_MIRROR_BASE` | `/dev/shm/claude-remote`；没有 `/dev/shm` 时是 `$TMPDIR/claude-remote-$UID` | 会话镜像的位置 |
| `RW_MIRROR` | （无） | 使用一个固定的镜像目录，而不是每个会话一个 |
| `RW_MAX_FILE_MB` | `10` | 超过这个大小（MB）的文件不经镜像整个传输；`0` 表示不限制 |

## 文件位置

| 内容 | 路径 |
|---|---|
| skill（指向本仓库的软链） | `~/.claude/skills/rw` |
| 你的 alias | `~/.config/claude-rw/aliases` |
| 会话镜像 | `/dev/shm/claude-remote/<会话 ID>/` |
| 远端 skill 列表缓存（用于 Tab 补全） | `~/.cache/claude-rw/skills/` |
| 最近连过的目标 | `~/.cache/claude-rw/recent` |
| 采集的 shell 环境（在每台远端上，权限 600） | `~/.cache/rw/env.sh` |
| 后台任务的命令、日志和退出码（在每台远端上） | `~/.cache/rw/jobs/<名字>/` |
| `install.sh` 的备份 | `~/.local/state/claude-rw/backups/` |

## 局限

- 没有 tty：命令的 stdin 直接是 EOF，请使用非交互参数。服务、watcher、长时间的任务用 `rw T job start` 跑。
- 镜像里只有 Claude 打开过的文件，搜索在远端进行。
- 每次读写都传输整个文件（经 ssh 的 base64）：源代码文件没问题，大文件太慢，所以超过 `RW_MAX_FILE_MB` 的文件会被拒绝。
- 只在两端都是 Linux 的环境下测试过。

## 仓库结构

```text
install.sh                          安装、更新、卸载
skills/rw/SKILL.md                  skill 本体：告诉 Claude 如何通过 rw 工作
skills/rw/rw                        背后的 bash 工具：run、path、pull、push、diff、status、skills、job、doctor、hooks
skills/rw/aliases.example           ~/.config/claude-rw/aliases 的模板
skills/rw/.claude-plugin/plugin.json
skills/rw/hooks/hooks.json          插件 hook：即时的 /rw ls、会话结束时的清理
skills/rw/hooks/register.ts         /rw 的补全和状态栏（hooks 模块）
```

## 许可证

[MIT](LICENSE)
