import type { EngineInterface, PromptAutocompleteSuggestion, Register } from 'claude-code'

// Completion for the rw skill in the prompt box:
//   /rw a<Tab>          -> the aliases (~/.config/claude-rw/aliases, or $RW_ALIASES), and `ls`
//   /rw api /r<Tab>     -> the agent skills on api's host, as `rw api skills` lists them
// Skill lists come from the cache `rw` writes (~/.cache/claude-rw/skills/<target>.tsv) on every
// `info` or `skills` call, so typing never waits on ssh. A missing or old list is refreshed in the
// background; the next keystroke shows it.

const STALE_MS = 10 * 60 * 1000 // refresh a cached list in the background after this
const RETRY_MS = 60 * 1000 // don't retry a failing target sooner than this

type Paths = { rw: string; aliases: string; cache: string }
type Skill = { name: string; isUserOnly: boolean; description: string }

let paths: Promise<Paths> | undefined
const refreshing = new Set<string>()
const lastTry = new Map<string, number>()

// The same locations `rw` uses: its aliases file and its skill-list cache.
function locate($: EngineInterface): Promise<Paths> {
  paths ??= $.process
    .run([
      'sh',
      '-c',
      'printf "%s\\n%s\\n%s" "$HOME" "${XDG_CACHE_HOME:-$HOME/.cache}" "${RW_ALIASES:-${XDG_CONFIG_HOME:-$HOME/.config}/claude-rw/aliases}"',
    ])
    .then(r => {
      const [home, cache, aliases] = r.stdout.split('\n')
      return { rw: `${home}/.claude/skills/rw/rw`, aliases: aliases ?? '', cache: `${cache}/claude-rw/skills` }
    })
  return paths
}

async function aliases($: EngineInterface, p: Paths) {
  const text = await $.fs.read(p.aliases).catch(() => '')
  return text
    .split('\n')
    .map(line => line.replace(/#.*/, '').trim().split(/\s+/))
    .filter(([name, target]) => name && target)
    .map(([name, target]) => ({ name, target }))
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
  const file = `${p.cache}/${target.replace(/[^A-Za-z0-9._-]/g, '_')}.tsv`
  const stat = await $.fs.stat(file).catch(() => undefined)
  if (!stat || Date.now() - stat.mtimeMs > STALE_MS) refresh($, p, target)
  if (!stat) return []
  const text = await $.fs.read(file).catch(() => '')
  return text
    .split('\n')
    .map(line => line.split('\t'))
    .filter(([name]) => name)
    .map(([name, userOnly, description]) => ({ name, isUserOnly: userOnly === '1', description: description ?? '' }))
}

async function suggest($: EngineInterface, text: string, start: number, token: string) {
  const before = text.slice(0, start)
  const rows: PromptAutocompleteSuggestion[] = []

  if (/^\s*\/rw\s+$/.test(before)) {
    for (const { name, target } of await aliases($, await locate($))) {
      if (name.startsWith(token)) rows.push({ text: name, description: target })
    }
    if ('ls'.startsWith(token)) rows.push({ text: 'ls', description: 'list the aliases' })
    return rows
  }

  const target = before.match(/^\s*\/rw\s+(\S+)\s+$/)?.[1]
  if (!target || !token.startsWith('/')) return rows
  const typed = token.slice(1)
  for (const s of await skills($, await locate($), target)) {
    if (!s.name.startsWith(typed)) continue
    const tag = s.isUserOnly ? '[user-invoked] ' : ''
    rows.push({ text: `/${s.name}`, description: `${target} · ${tag}${s.description}` })
  }
  return rows
}

export const register: Register = on => {
  on('prompt.autocomplete', async ($, e, next) => {
    const own = await next(e)
    const mine = await suggest($, e.text, e.start, e.token)
    return { suggestions: [...own.suggestions, ...mine] }
  })
}
