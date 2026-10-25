import type { EngineInterface, PromptAutocompleteSuggestion, Register } from 'claude-code'

// The prompt box side of the rw skill:
//   /rw                 -> every alias, recent target and ssh host, to pick from
//   /rw a<Tab>          -> the aliases, recent targets and ssh hosts (~/.ssh/config) starting with "a", and `ls`
//   /rw host:<Tab>      -> the directories in host's home; taking one lists its subdirectories, and so on
//   /rw api /r<Tab>     -> the agent skills on api's host, as `rw api skills` lists them
// The dim hint after "/rw " names the aliases, and the status line shows the target rw last worked in.
// Typing never waits on ssh: skill lists come from the cache `rw` writes on every `info` or `skills` call
// (a missing or old one is refreshed in the background), and a directory listing joins the typeahead
// whenever it arrives.

const STALE_MS = 10 * 60 * 1000 // refresh a cached skill list in the background after this
const RETRY_MS = 60 * 1000 // don't retry a failing target sooner than this
const LISTING_MS = 60 * 1000 // keep a remote directory listing, and the ssh hosts, this long

type Paths = { rw: string; aliases: string; skills: string; recent: string }
type Alias = { name: string; target: string }
type Host = { name: string; address: string }
type Dir = { name: string; isRepo: boolean }
type Skill = { name: string; isUserOnly: boolean; description: string }

let paths: Promise<Paths> | undefined
const refreshing = new Set<string>()
const lastTry = new Map<string, number>()
let sshHosts: { at: number; hosts: Promise<Host[]> } | undefined
const listings = new Map<string, { at: number; dirs: Promise<Dir[]> }>()
let hinted: string | undefined // the alias names the hint after "/rw " was built from

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// The same locations `rw` uses: its aliases file, its skill-list cache and its list of recent targets.
function locate($: EngineInterface): Promise<Paths> {
  paths ??= $.process
    .run([
      'sh',
      '-c',
      'printf "%s\\n%s\\n%s" "$HOME" "${XDG_CACHE_HOME:-$HOME/.cache}" "${RW_ALIASES:-${XDG_CONFIG_HOME:-$HOME/.config}/claude-rw/aliases}"',
    ])
    .then(r => {
      const [home, cache, aliases] = r.stdout.split('\n')
      return {
        rw: `${home}/.claude/skills/rw/rw`,
        aliases: aliases ?? '',
        skills: `${cache}/claude-rw/skills`,
        recent: `${cache}/claude-rw/recent`,
      }
    })
  return paths
}

async function aliases($: EngineInterface, p: Paths): Promise<Alias[]> {
  const text = await $.fs.read(p.aliases).catch(() => '')
  return text.split('\n').flatMap(line => {
    const [name, target] = line.replace(/#.*/, '').trim().split(/\s+/)
    return name && target ? [{ name, target }] : []
  })
}

// Targets `rw info` connected to, most recent first.
async function recent($: EngineInterface, p: Paths): Promise<string[]> {
  const text = await $.fs.read(p.recent).catch(() => '')
  return text.split('\n').filter(Boolean)
}

// ~/.ssh/config and the files it includes, one level deep.
const SSH_CONFIG = `cd ~/.ssh 2>/dev/null || exit 0
cat config 2>/dev/null
sed -n 's/^[[:space:]]*[Ii]nclude[[:space:]]\\{1,\\}//p' config 2>/dev/null | while read -r line; do
  for f in $line; do
    case $f in "~/"*) f=$HOME/\${f#"~/"} ;; esac
    for g in $f; do [ -f "$g" ] && cat "$g"; done
  done
done`

// Each concrete Host name (no wildcards) with "user@hostname:port" from its block; the first block wins.
function parseSshConfig(text: string): Host[] {
  const hosts = new Map<string, string>()
  let block: { names: string[]; user?: string; hostname?: string; port?: string } | undefined
  const flush = () => {
    if (!block) return
    const address = `${block.user ? `${block.user}@` : ''}${block.hostname ?? ''}${block.port ? `:${block.port}` : ''}`
    for (const name of block.names) if (!hosts.has(name)) hosts.set(name, address)
  }
  for (const line of text.split('\n')) {
    const m = line.replace(/#.*/, '').trim().match(/^(\S+?)(?:\s*=\s*|\s+)(.+)$/)
    if (!m) continue
    const key = (m[1] ?? '').toLowerCase()
    const value = (m[2] ?? '').trim()
    if (key === 'host' || key === 'match') {
      flush()
      block = key === 'host' ? { names: value.split(/\s+/).filter(n => !/[*?!]/.test(n)) } : undefined
    } else if (block && key === 'hostname') block.hostname ??= value
    else if (block && key === 'user') block.user ??= value
    else if (block && key === 'port') block.port ??= value
  }
  flush()
  return [...hosts].map(([name, address]) => ({ name, address }))
}

function hosts($: EngineInterface): Promise<Host[]> {
  if (!sshHosts || Date.now() - sshHosts.at > LISTING_MS) {
    const hosts = $.process.run(['sh', '-c', SSH_CONFIG]).then(r => parseSshConfig(r.stdout), () => [])
    sshHosts = { at: Date.now(), hosts }
  }
  return sshHosts.hosts
}

// The directories in $p on the remote ("" or "~/..." from the home, relative ones too), git repos marked.
const LIST_DIRS = `case $p in "") p=$HOME/ ;; "~/"*) p=$HOME/\${p#"~/"} ;; /*) ;; *) p=$HOME/$p ;; esac
cd -- "$p" 2>/dev/null || exit 0
echo __RW_DIRS__
for e in */ .[!.]*/; do [ -d "$e" ] || continue; g=; [ -e "$e.git" ] && g=1; printf '%s\\t%s\\n' "\${e%/}" "$g"; done | head -n 2000`

// Listed with `rw HOST:/ run`, over the ssh connection rw shares; an unreachable host lists nothing.
function listDirs($: EngineInterface, p: Paths, host: string, dir: string): Promise<Dir[]> {
  const key = `${host}\n${dir}`
  const hit = listings.get(key)
  if (hit && Date.now() - hit.at < LISTING_MS) return hit.dirs
  const dirs = $.process.run([p.rw, `${host}:/`, 'run', `p=${quote(dir)}\n${LIST_DIRS}`], { timeoutMs: 8_000 }).then(
    r =>
      (r.stdout.split('__RW_DIRS__\n')[1] ?? '').split('\n').flatMap(line => {
        const [name, repo] = line.split('\t')
        return name ? [{ name, isRepo: repo === '1' }] : []
      }),
    () => [],
  )
  listings.set(key, { at: Date.now(), dirs })
  return dirs
}

// Runs `rw <target> skills`, which rewrites the cache file; one at a time per target.
function refresh($: EngineInterface, p: Paths, target: string) {
  const now = Date.now()
  if (refreshing.has(target) || now - (lastTry.get(target) ?? 0) < RETRY_MS) return
  refreshing.add(target)
  lastTry.set(target, now)
  void $.process
    .run([p.rw, target, 'skills'], { timeoutMs: 60_000 })
    .catch(() => undefined)
    .finally(() => refreshing.delete(target))
}

async function skills($: EngineInterface, p: Paths, target: string): Promise<Skill[]> {
  const file = `${p.skills}/${target.replace(/[^A-Za-z0-9._-]/g, '_')}.tsv`
  const stat = await $.fs.stat(file).catch(() => undefined)
  if (!stat || Date.now() - stat.mtimeMs > STALE_MS) refresh($, p, target)
  if (!stat) return []
  const text = await $.fs.read(file).catch(() => '')
  return text.split('\n').flatMap(line => {
    const [name, userOnly, description] = line.split('\t')
    return name ? [{ name, isUserOnly: userOnly === '1', description: description ?? '' }] : []
  })
}

// The first word after /rw. Taking an alias or a recent target ends it; taking a host writes "host:",
// which lists the host's directories next.
async function targetRows($: EngineInterface, typed: string): Promise<PromptAutocompleteSuggestion[]> {
  const p = await locate($)
  const [named, used, known] = await Promise.all([aliases($, p), recent($, p), hosts($)])
  if (hinted !== undefined && named.map(a => a.name).join(' ') !== hinted) {
    hinted = undefined
    $.ui.invalidate('command.describe')
  }
  const rows: PromptAutocompleteSuggestion[] = []
  for (const a of named) {
    if (a.name.startsWith(typed)) rows.push({ text: `${a.name} `, label: a.name, description: a.target })
  }
  const aliased = new Set(named.map(a => a.target))
  for (const t of used) {
    if (!aliased.has(t) && t.startsWith(typed)) rows.push({ text: `${t} `, label: t, description: 'recent' })
  }
  if ('ls'.startsWith(typed)) rows.push({ text: 'ls', description: 'list the aliases and recent targets' })
  const names = new Set(named.map(a => a.name))
  for (const h of known) {
    if (!names.has(h.name) && h.name.startsWith(typed)) {
      rows.push({ text: `${h.name}:`, label: h.name, description: h.address || 'ssh host' })
    }
  }
  return rows
}

// "host:PATH" with PATH being typed: the directories its last segment can still become.
async function dirRows($: EngineInterface, host: string, typed: string): Promise<PromptAutocompleteSuggestion[]> {
  const cut = typed.lastIndexOf('/')
  const dir = cut >= 0 ? typed.slice(0, cut + 1) : typed === '' || typed === '~' ? '~/' : ''
  const part = cut >= 0 ? typed.slice(cut + 1) : typed === '~' ? '' : typed
  const dirs = await listDirs($, await locate($), host, dir)
  return dirs
    .filter(d => d.name.startsWith(part) && (part.startsWith('.') || !d.name.startsWith('.')))
    .slice(0, 200)
    .map(d => ({ text: `${host}:${dir}${d.name}/`, label: `${d.name}/`, ...(d.isRepo ? { description: 'git repo' } : {}) }))
}

async function skillRows($: EngineInterface, target: string, typed: string): Promise<PromptAutocompleteSuggestion[]> {
  return (await skills($, await locate($), target)).flatMap(s =>
    s.name.startsWith(typed)
      ? [{ text: `/${s.name}`, description: `${target} · ${s.isUserOnly ? '[user-invoked] ' : ''}${s.description}` }]
      : [],
  )
}

async function suggest($: EngineInterface, text: string, start: number, token: string) {
  const before = text.slice(0, start)
  // the prompt box asks for no word after a bare "/rw ", so "/rw" itself offers every target
  if (token === '/rw' && /^\s*$/.test(before)) {
    return (await targetRows($, '')).map(r => ({ ...r, text: `/rw ${r.text}`, label: r.label ?? r.text }))
  }
  if (/^\s*\/rw\s+$/.test(before)) {
    const m = token.match(/^([^\s:/]+):(.*)$/)
    return m ? dirRows($, m[1] ?? '', m[2] ?? '') : targetRows($, token)
  }
  const target = before.match(/^\s*\/rw\s+(\S+)\s+$/)?.[1]
  return target && token.startsWith('/') ? skillRows($, target, token.slice(1)) : []
}

// Any rw call names its target: `info` prints the resolved one, the other commands take HOST:DIR.
const RW_CALL = /(?:^|[\s;&|(])(?:\S*\/)?rw["']?\s+(\S+)\s+(info|run|path|pull|push|diff|status|skills|job)\b/

function workedIn(command: string, output: string | undefined) {
  const m = command.match(RW_CALL)
  if (!m) return undefined
  if (m[2] === 'info') return output?.match(/^target: (\S+)$/m)?.[1]
  return m[1]?.includes(':/') ? m[1] : undefined
}

export const register: Register = on => {
  on('prompt.autocomplete', async ($, e, next) => {
    const own = await next(e)
    const mine = await suggest($, e.text, e.start, e.token)
    return { suggestions: [...own.suggestions, ...mine] }
  })

  on('command.describe', { command: 'rw' }, async ($, e, next) => {
    const described = await next(e)
    const names = (await aliases($, await locate($))).map(a => a.name)
    hinted = names.join(' ')
    if (!names.length) return described
    return { ...described, argumentHint: `${names.join(' | ')} | <host>[:<dir>] | ls   [task | /remote-skill]` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const target = workedIn(e.command, ran.text)
    if (target) $.ui.status(target) // drawn as "rw: <target>"
    return ran
  })

  on('session.end', ($, e, next) => {
    $.ui.status(undefined)
    return next(e)
  })
}
