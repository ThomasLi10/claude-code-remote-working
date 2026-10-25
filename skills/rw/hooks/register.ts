import type { EngineInterface, PromptAutocompleteSuggestion, Register } from 'claude-code'

// The prompt box side of the rw skill:
//   /rw                 -> every alias, recent target and ssh host, to pick from
//   /rw a<Tab>          -> the aliases, recent targets and ssh hosts (~/.ssh/config) starting with "a", and `ls`
//   /rw host:<Tab>      -> the directories in host's home; taking one lists its subdirectories, and so on
//   /rw api /r<Tab>     -> the agent skills on api's host, as `rw api skills` lists them
// The dim hint after "/rw " names the aliases, and the status line shows the target rw last worked in.
// Typing never waits long on ssh: skill lists come from the cache `rw` writes on every `info` or `skills`
// call (a missing or old one is refreshed in the background), and remote directories are listed a level
// ahead of the one being typed, starting as soon as a host's name is.

const STALE_MS = 10 * 60 * 1000 // refresh a cached skill list in the background after this
const RETRY_MS = 60 * 1000 // don't retry a failing skill list sooner than this
const LISTING_MS = 60 * 1000 // keep a remote directory listing, and the ssh hosts, this long
const UNREACHABLE_MS = 10 * 1000 // don't list a host again this soon after a listing failed
const WAIT_MS = 8000 // how long a keystroke waits for a listing (the next keystroke abandons the wait)

type Paths = { home: string; rw: string; aliases: string; skills: string; recent: string; sshOpts: string[] }
type Alias = { name: string; target: string }
type Host = { name: string; address: string }
type Dir = { name: string; isRepo: boolean }
type Skill = { name: string; isUserOnly: boolean; description: string }
type Listing = { at: number; dirs: Promise<Dir[]>; deep: boolean; deepening?: boolean }

let paths: Promise<Paths> | undefined
const refreshing = new Set<string>()
const lastTry = new Map<string, number>()
let sshHosts: { at: number; hosts: Promise<Host[]> } | undefined
const listings = new Map<string, Listing>() // by "host\ndir", dir as typed: "~/", "~/code/", "/", "code/"
const unreachable = new Map<string, number>() // host -> when a listing of it last failed
let hinted: string | undefined // the alias names the hint after "/rw " was built from

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// Work for the caches runs on a timer, outside the typing dispatch: a keystroke that abandons the
// dispatch would abort it, and the next keystroke is the one that needs the result.
function detached<T>($: EngineInterface, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    $.clock.after(0, () => void work().then(resolve, reject))
  })
}

// The same locations and ssh options `rw` uses: its aliases file, skill-list cache, recent targets.
function locate($: EngineInterface): Promise<Paths> {
  if (paths) return paths
  const argv = [
    'sh',
    '-c',
    'printf "%s\\n%s\\n%s\\n%s" "$HOME" "${XDG_CACHE_HOME:-$HOME/.cache}" ' +
      '"${RW_ALIASES:-${XDG_CONFIG_HOME:-$HOME/.config}/claude-rw/aliases}" "${RW_SSH_OPTS:-}"',
  ]
  paths = detached($, () => $.process.run(argv))
    .then(r => {
      const [home = '', cache = '', aliases = '', sshOpts = ''] = r.stdout.split('\n')
      return {
        home,
        rw: `${home}/.claude/skills/rw/rw`,
        aliases,
        skills: `${cache}/claude-rw/skills`,
        recent: `${cache}/claude-rw/recent`,
        sshOpts: sshOpts.split(/\s+/).filter(Boolean),
      }
    })
  paths.catch(() => (paths = undefined)) // asked again next time
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
    const hosts = detached($, () => $.process.run(['sh', '-c', SSH_CONFIG])).then(r => parseSshConfig(r.stdout))
    sshHosts = { at: Date.now(), hosts }
    hosts.catch(() => sshHosts?.hosts === hosts && (sshHosts = undefined))
  }
  return sshHosts.hosts.catch(() => [])
}

// The directories in $p ("" or "~/..." from the home, relative ones too), "name<TAB>1" for a git repo;
// then, for the first 200, their own as "name/sub<TAB>..." and an end line "name/<TAB>x", or
// "name/<TAB>+" when cut at 300. find streams, so a huge directory costs no more than its first entries.
const LIST_DIRS = `case $p in "") p=$HOME/ ;; "~/"*) p=$HOME/\${p#"~/"} ;; /*) ;; *) p=$HOME/$p ;; esac
cd -- "$p" 2>/dev/null || exit 0
echo __RW_DIRS__
k=0
find . -mindepth 1 -maxdepth 1 \\( -type d -o -type l \\) 2>/dev/null | head -n 2000 | while IFS= read -r e; do
  e=\${e#./}; [ -d "$e" ] || continue
  g=; [ -e "$e/.git" ] && g=1
  printf '%s\\t%s\\n' "$e" "$g"
  k=$((k + 1)); [ $k -le 200 ] || continue
  find "$e/" -mindepth 1 -maxdepth 1 \\( -type d -o -type l \\) 2>/dev/null | head -n 2000 | {
    n=0 s=x
    while IFS= read -r f; do
      f=\${f#"$e/"}; [ -d "$e/$f" ] || continue
      n=$((n + 1)); [ $n -le 300 ] || { s=+; break; }
      g=; [ -e "$e/$f/.git" ] && g=1
      printf '%s/%s\\t%s\\n' "$e" "$f" "$g"
    done
    printf '%s/\\t%s\\n' "$e" "$s"
  }
done`

// One round trip over the ssh connection rw shares (its options, no login shell: a listing needs no
// environment). It answers DIR's directories and caches each one's own, so taking one lists at once.
function fetchListing($: EngineInterface, p: Paths, host: string, dir: string): Promise<Dir[]> {
  const argv = ['ssh', ...p.sshOpts, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ControlMaster=auto']
  argv.push('-o', `ControlPath=${p.home}/.ssh/rw-%C`, '-o', 'ControlPersist=30m', host, 'sh -s')
  const run = detached($, () => $.process.run(argv, { stdin: `p=${quote(dir)}\n${LIST_DIRS}\n`, timeoutMs: 15_000 }))
  return run.then(r => {
    const [, out] = r.stdout.split('__RW_DIRS__\n')
    if (out === undefined) throw new Error(r.stderr.trim() || `no listing of ${host}:${dir}`)
    const top: Dir[] = []
    const below = new Map<string, Dir[]>()
    const complete = new Set<string>()
    for (const line of out.split('\n')) {
      const [path = '', flag] = line.split('\t')
      const slash = path.indexOf('/')
      if (!path) continue
      if (slash < 0) top.push({ name: path, isRepo: flag === '1' })
      else if (slash === path.length - 1) {
        if (flag === 'x') complete.add(path.slice(0, -1))
      } else {
        const parent = path.slice(0, slash)
        below.set(parent, [...(below.get(parent) ?? []), { name: path.slice(slash + 1), isRepo: flag === '1' }])
      }
    }
    const byName = (a: Dir, b: Dir) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const at = Date.now()
    for (const name of complete) {
      const key = `${host}\n${dir}${name}/`
      if (listings.get(key)?.deep) continue
      listings.set(key, { at, dirs: Promise.resolve((below.get(name) ?? []).sort(byName)), deep: false })
    }
    return top.sort(byName)
  })
}

// DIR's listing, two levels deep; a failure is not kept, and leaves the host alone for a few seconds.
function listDeep($: EngineInterface, p: Paths, host: string, dir: string): Promise<Dir[]> {
  const key = `${host}\n${dir}`
  const dirs = fetchListing($, p, host, dir)
  listings.set(key, { at: Date.now(), dirs, deep: true })
  dirs.catch(() => {
    if (listings.get(key)?.dirs === dirs) listings.delete(key)
    unreachable.set(host, Date.now())
  })
  return dirs
}

// DIR's listing from the cache, else from the remote; undefined while the host has just failed. A level
// that came with its parent's listing has its own children fetched now, to stay a level ahead.
function listDirs($: EngineInterface, p: Paths, host: string, dir: string): Promise<Dir[]> | undefined {
  const hit = listings.get(`${host}\n${dir}`)
  if (hit && Date.now() - hit.at < LISTING_MS) {
    if (!hit.deep && !hit.deepening) {
      hit.deepening = true
      void listDeep($, p, host, dir).catch(() => (hit.deepening = false))
    }
    return hit.dirs
  }
  if (Date.now() - (unreachable.get(host) ?? 0) < UNREACHABLE_MS) return undefined
  return listDeep($, p, host, dir)
}

// Runs `rw <target> skills`, which rewrites the cache file; one at a time per target.
function refresh($: EngineInterface, p: Paths, target: string) {
  const now = Date.now()
  if (refreshing.has(target) || now - (lastTry.get(target) ?? 0) < RETRY_MS) return
  refreshing.add(target)
  lastTry.set(target, now)
  void detached($, () => $.process.run([p.rw, target, 'skills'], { timeoutMs: 60_000 }))
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
// which lists the host's directories next. Once the word names a single host, its home and its root
// are listed ahead.
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
  const matching = known.filter(h => !names.has(h.name) && h.name.startsWith(typed))
  for (const h of matching) rows.push({ text: `${h.name}:`, label: h.name, description: h.address || 'ssh host' })
  const only = typed && (matching.find(h => h.name === typed) ?? (matching.length === 1 ? matching[0] : undefined))
  if (only) for (const dir of ['~/', '/']) void listDirs($, p, only.name, dir)?.catch(() => undefined)
  return rows
}

// "host:PATH" with PATH being typed: the directories its last segment can still become.
async function dirRows($: EngineInterface, host: string, typed: string): Promise<PromptAutocompleteSuggestion[]> {
  const cut = typed.lastIndexOf('/')
  const dir = cut >= 0 ? typed.slice(0, cut + 1) : typed === '' || typed === '~' ? '~/' : ''
  const part = cut >= 0 ? typed.slice(cut + 1) : typed === '~' ? '' : typed
  const listing = listDirs($, await locate($), host, dir)
  if (!listing) return []
  const dirs = await Promise.race([listing, $.clock.sleep(WAIT_MS).then(() => undefined)]).catch(() => undefined)
  return (dirs ?? [])
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
  // the prompt box asks for no word after a bare "/rw ", so "/rw" itself offers every target; it also
  // lists the home and root of the hosts the aliases and recent targets name, which opens their shared
  // ssh connections ahead of the listings and commands that follow
  if (token === '/rw' && /^\s*$/.test(before)) {
    const p = await locate($)
    const [named, used] = await Promise.all([aliases($, p), recent($, p)])
    const targets = [...named.map(a => a.target), ...used].filter(t => t.includes(':'))
    for (const host of [...new Set(targets.map(t => t.slice(0, t.indexOf(':'))))].slice(0, 5)) {
      for (const dir of ['~/', '/']) void listDirs($, p, host, dir)?.catch(() => undefined)
    }
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
