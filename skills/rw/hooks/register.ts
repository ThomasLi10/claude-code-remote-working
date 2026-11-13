import type { EngineInterface, PromptAutocompleteSuggestion, Register } from 'claude-code'

// The prompt box side of the rw skill:
//   /rw                 -> every alias, recent target and ssh host, to pick from
//   /rw a<Tab>          -> the aliases, recent targets and ssh hosts (~/.ssh/config) starting with "a", and `ls`
//   /rw host:<Tab>      -> the directories in host's home; taking one lists its subdirectories, and so on
//   /rw api /r<Tab>     -> the agent skills on api's host, as `rw api skills` lists them
//   /r<Tab>             -> once the session works in a target, its skills too: registered as the session's
//                          own commands, `/run-tests args` running `/rw <target> /run-tests args`
// The dim hint after "/rw " names the aliases, and the prompt footer shows the target rw last worked in.
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
// `rw` itself is the one beside this module, wherever the plugin was installed: ~/.claude/skills/rw,
// or the plugin cache for an install from a marketplace.
function locate($: EngineInterface): Promise<Paths> {
  if (paths) return paths
  const rw = `${$.plugin.root}/rw`
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
        rw,
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
  // the first call to a host starts the master that rw's own calls then share, so it takes rw's connection options
  const argv = ['ssh', ...p.sshOpts, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ControlMaster=auto']
  argv.push('-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4', '-o', 'Compression=yes')
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

// The skill's command: /rw, or /rw:rw, its full name when the plugin came from a marketplace.
const COMMAND = /^\/rw(?::rw)?$/
const AFTER_COMMAND = /^\s*\/rw(?::rw)?\s+$/
const AFTER_TARGET = /^\s*\/rw(?::rw)?\s+(\S+)\s+$/

async function suggest($: EngineInterface, text: string, start: number, token: string) {
  const before = text.slice(0, start)
  // the prompt box asks for no word after a bare "/rw ", so "/rw" itself offers every target; it also
  // lists the home and root of the hosts the aliases and recent targets name, which opens their shared
  // ssh connections ahead of the listings and commands that follow
  if (COMMAND.test(token) && /^\s*$/.test(before)) {
    const p = await locate($)
    const [named, used] = await Promise.all([aliases($, p), recent($, p)])
    const targets = [...named.map(a => a.target), ...used].filter(t => t.includes(':'))
    for (const host of [...new Set(targets.map(t => t.slice(0, t.indexOf(':'))))].slice(0, 5)) {
      for (const dir of ['~/', '/']) void listDirs($, p, host, dir)?.catch(() => undefined)
    }
    return (await targetRows($, '')).map(r => ({ ...r, text: `${token} ${r.text}`, label: r.label ?? r.text }))
  }
  if (AFTER_COMMAND.test(before)) {
    const m = token.match(/^([^\s:/]+):(.*)$/)
    return m ? dirRows($, m[1] ?? '', m[2] ?? '') : targetRows($, token)
  }
  const target = before.match(AFTER_TARGET)?.[1]
  if (target && token.startsWith('/')) return skillRows($, target, token.slice(1))
  return /^\s*$/.test(before) ? workingRows($, token) : []
}

// The skills of the target the session works in, as this session's own slash commands: the typeahead
// ranks /fix-and-commit among the local commands (rows a plugin adds only ever come after all of those),
// and `/fix-and-commit args` runs `/rw <target> /fix-and-commit args`. The target is written as the alias
// that names it, when one does, and its skill list is the one `/rw <alias> /…` completes from. The engine
// keeps a registered command for the whole session, so one of a target the session has left is hidden,
// and says so when typed in full.
type Offer = { target: string; skills: Skill[]; commands: Set<string> }
let offer: Offer | undefined
const registered = new Map<string, string>() // command name -> the description it was registered with
let offering: Promise<void> = Promise.resolve()
let offeredAt = 0
const OFFER_MS = 30 * 1000 // when the typeahead asks, look at the target's skill list again after this
const COMMAND_NAME = /^[A-Za-z0-9_-]{1,64}$/ // what $.command.register takes

async function written($: EngineInterface, p: Paths, working: string): Promise<string> {
  return (await aliases($, p)).find(a => a.target === working)?.name ?? working
}

// One at a time, so two target changes in a row register in order.
function offerSkills($: EngineInterface) {
  offeredAt = Date.now()
  offering = offering.then(() => syncOffer($)).catch(() => undefined)
}

async function syncOffer($: EngineInterface) {
  const working = lastTarget
  const p = await locate($)
  const target = working === undefined ? undefined : await written($, p, working)
  const list = target === undefined ? [] : await skills($, p, target)
  const local = new Set((await $.command.list()).filter(c => !registered.has(c.name)).map(c => c.name))
  const commands = new Set<string>()
  for (const s of list) {
    if (!COMMAND_NAME.test(s.name) || local.has(s.name)) continue
    const description = `rw ${target} · ${s.isUserOnly ? '[user-invoked] ' : ''}${s.description}`
    if (registered.get(s.name) !== description) {
      const done = await $.command.register({ name: s.name, description, argumentHint: '[args]' }).then(
        () => true,
        () => false,
      )
      if (!done) continue
      registered.set(s.name, description)
    }
    commands.add(s.name)
  }
  offer = target === undefined ? undefined : { target, skills: list, commands }
  $.ui.invalidate('command.describe')
}

// The skills the session's target has that are not commands (a local command has the name, say): a bare
// "/name" opening the prompt lists them beneath the local commands, and taking one writes
// "/rw <target> /name ". Asking also keeps the commands in step with the target's skill list.
async function workingRows($: EngineInterface, token: string): Promise<PromptAutocompleteSuggestion[]> {
  if (!lastTarget || !/^\/[^\s/]*$/.test(token)) return []
  if (Date.now() - offeredAt > OFFER_MS) offerSkills($)
  const current = offer
  if (!current) return []
  return current.skills.flatMap(s =>
    s.name.startsWith(token.slice(1)) && !current.commands.has(s.name)
      ? [
          {
            text: `/rw ${current.target} /${s.name} `,
            label: `/${s.name}`,
            description: `rw ${current.target} · ${s.isUserOnly ? '[user-invoked] ' : ''}${s.description}`,
          },
        ]
      : [],
  )
}

// Any rw call names its target: `info` prints the resolved one, the other commands take HOST:DIR.
const RW_CALL = /(?:^|[\s;&|(])(?:\S*\/)?rw["']?\s+(\S+)\s+(info|run|path|pull|push|diff|status|skills|job)\b/

// The target rw last worked in this session, as the prompt footer shows it. A reload of the plugin, a
// restart or `claude --resume` starts this module without it, so each session's is also kept in the
// plugin's store and read back at load; a session the store has none for falls back to the newest rw
// call its transcript holds (sessions that used rw before the store kept targets, say).
let lastTarget: string | undefined
const KEPT_PREFIX = 'target:' // store key of a session's target: "target:<session id>"
const KEPT_SESSIONS = 200 // the store forgets the targets of older sessions than this many

function workedIn(command: string, output: string | undefined) {
  const m = command.match(RW_CALL)
  if (!m) return undefined
  if (m[2] === 'info') return output?.match(/^target: (\S+)$/m)?.[1]
  return m[1]?.includes(':/') ? m[1] : undefined
}

function show($: EngineInterface, target: string | undefined) {
  if (target === lastTarget) return
  lastTarget = target
  $.ui.invalidate('ui.render')
  offerSkills($)
}

async function remember($: EngineInterface, target: string) {
  const key = KEPT_PREFIX + (await $.session.id())
  await $.store.delete(key) // so the key moves to the end: the store lists keys in insertion order
  await $.store.set(key, target)
  const kept = (await $.store.keys()).filter(k => k.startsWith(KEPT_PREFIX))
  for (const old of kept.slice(0, -KEPT_SESSIONS)) await $.store.delete(old)
}

async function recall($: EngineInterface): Promise<string | undefined> {
  const kept = await $.store.get(KEPT_PREFIX + (await $.session.id()))
  if (typeof kept === 'string') return kept
  const messages = await $.session.messages()
  for (let i = messages.length - 1; i >= 0; i--) {
    const uses = messages[i]?.toolUses ?? []
    for (let j = uses.length - 1; j >= 0; j--) {
      const use = uses[j]
      const command = use?.input.command
      const target = use?.tool === 'Bash' && typeof command === 'string' ? workedIn(command, use.text) : undefined
      if (target) return target
    }
  }
  return undefined
}

// Shows the target of the session the engine runs now, on a timer outside the hook that asks. After a
// /clear or a resume (`ended` is the session that ended), it waits until the engine runs another one.
function restore($: EngineInterface, ended?: string, tries = 20) {
  $.clock.after(ended === undefined ? 0 : 250, () => {
    void (async () => {
      if (ended !== undefined && (await $.session.id()) === ended) {
        if (tries > 1) restore($, ended, tries - 1)
        return
      }
      const target = await recall($)
      if (target === undefined || lastTarget !== undefined) return // an rw call since knows better
      show($, target)
      await remember($, target)
    })().catch(() => undefined)
  })
}

export const register: Register = on => {
  on('prompt.autocomplete', async ($, e, next) => {
    const own = await next(e)
    const mine = await suggest($, e.text, e.start, e.token)
    return { suggestions: [...own.suggestions, ...mine] }
  })

  on('command.describe', { command: ['rw', 'rw:rw'] }, async ($, e, next) => {
    const described = await next(e)
    const names = (await aliases($, await locate($))).map(a => a.name)
    hinted = names.join(' ')
    if (!names.length) return described
    return { ...described, argumentHint: `${names.join(' | ')} | <host>[:<dir>] | ls   [task | /remote-skill]` }
  })

  // A remote skill registered for a target the session has since left stays out of the typeahead.
  on('command.describe', async ($, e, next) => {
    const described = await next(e)
    return registered.has(e.command) && !offer?.commands.has(e.command) ? { ...described, isHidden: true } : described
  })

  // `/fix-and-commit args` runs `/rw <target> /fix-and-commit args` once this command is done.
  on('command.run', async ($, e, next) => {
    if (!registered.has(e.command)) return next(e)
    const current = offer
    if (!current?.commands.has(e.command)) {
      const where = current ? `rw ${current.target} has no skill /${e.command}` : 'this session works in no rw target'
      return { text: `/${e.command} is a remote skill of an rw target; ${where}.` }
    }
    const args = `${current.target} /${e.command}${e.args.trim() ? ` ${e.args.trim()}` : ''}`
    // on a timer, outside this hook: a run from inside it would wait on the command this hook is holding
    // the skill is /rw, or rw:rw when the plugin came from a marketplace
    $.clock.after(0, () => {
      void $.command
        .list()
        .then(all => $.command.run({ command: all.some(c => c.name === 'rw') ? 'rw' : 'rw:rw', args }))
        .catch(err => $.ui.toast(`rw: /rw ${args} did not run: ${String(err)}`))
    })
    return { text: `→ /rw ${args}` }
  })

  // Earlier versions pinned the target as a status line; clear one left from before a reload. Then
  // show the session's target again: this fires at every load of the module, the first included.
  on('session.start', ($, e, next) => {
    $.ui.status(undefined)
    restore($)
    return next(e)
  })

  // A /clear goes on in a conversation that has not used rw; a resume brings back one that may have.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear' || e.reason === 'resume') {
      show($, undefined)
      restore($, e.sessionId)
    }
    return ended
  })

  // The target sits at the right of the prompt footer's first row (beside a configured status line),
  // after the engine's own dim mode labels, rather than on a status line of its own. It keeps the
  // color the engine gave it as a plugin status line (the theme's warning color), so it stands out.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const own = await next(e)
    if (!lastTarget) return own
    const { Box, Text } = $.ui.resolve(e)
    const label = Text({ color: 'warning', children: `rw: ${lastTarget}` })
    return Box({ gap: 2, children: e.props.modes.length ? [own, label] : [label] })
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const target = workedIn(e.command, ran.text)
    if (target && target !== lastTarget) {
      show($, target)
      void remember($, target).catch(() => undefined)
    } else if (/^(info|skills)$/.test(e.command.match(RW_CALL)?.[2] ?? '')) offerSkills($) // a skill list was read again
    return ran
  })
}
