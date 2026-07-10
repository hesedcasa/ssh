/**
 * Safety guard for `ssh artisan`.
 *
 * Migration commands are destructive operations that can cause data loss or
 * corruption; the original `pod-shell.sh` skill explicitly banned them. We keep
 * that contract here by blocking them before any command reaches a pod.
 *
 * Matching is by the artisan subcommand token (the first whitespace-delimited
 * segment of the command), so e.g. `migrate:status` is blocked but a harmless
 * flag like `--path=migrations` is not. A blacklist entry may itself contain
 * spaces (e.g. `migrate:fresh --seed`) to match multi-token subcommands.
 */

interface BlacklistCheckResult {
  allowed: boolean
  blockedCommand?: string
  reason?: string
}

/** Result of a built-in deletion-permission check. */
export interface PermissionCheckResult {
  allowed: boolean
  /** The command, token, or pattern that triggered the block. */
  matchedPattern?: string
  reason?: string
}

/**
 * Normalize a command for matching: trimmed, collapsed internal whitespace,
 * lower-cased. We compare case-insensitively so `MIGRATE` and `migrate` are
 * treated identically.
 */
function normalize(cmd: string): string {
  return cmd.trim().toLowerCase().replaceAll(/\s+/g, ' ')
}

/**
 * Check whether an artisan subcommand is allowed.
 *
 * @param command      the artisan argument (everything after `php artisan`),
 *                     e.g. `migrate:status` or `cache:clear`.
 * @param blacklisted  subcommand prefixes to block, e.g. `['migrate', ...]`.
 */
/*
 * ---------------------------------------------------------------------------
 * Built-in deletion guard (AI permission layer)
 * ---------------------------------------------------------------------------
 *
 * This plugin is designed to be driven by AI agents, so — unlike the
 * per-profile artisan blacklist above, which is opt-in and editable via
 * `ssh servers safety` — the checks below are hard-coded and always on.
 * No flag, profile setting, or config edit can disable them.
 *
 * They refuse, before anything reaches a pod, any command that would:
 *   • delete a file or folder (`rm`, `rmdir`, `unlink`, `shred`,
 *     `find -delete`, PHP `unlink()`, `File::delete*`, `Storage::delete*`, …)
 *   • drop or wipe a database (`DROP DATABASE/SCHEMA/TABLE`,
 *     `mysqladmin drop`, `db:wipe`, `migrate:fresh/refresh/reset/rollback`,
 *     `Schema::drop*`, …)
 *
 * Matching is deliberately conservative: a false positive costs a human a
 * manual run outside this tool, a false negative costs data.
 */

const DELETION_GUARD_NOTICE =
  'This tool does not permit AI-driven deletion of files, folders, or databases. ' +
  'If this operation is genuinely required, a human must run it manually outside this tool.'

const ALLOWED: PermissionCheckResult = {allowed: true}

function deny(matchedPattern: string, what: string): PermissionCheckResult {
  return {
    allowed: false,
    matchedPattern,
    reason: `${what} ("${matchedPattern}") is blocked by the built-in deletion guard. ${DELETION_GUARD_NOTICE}`,
  }
}

/** Binaries whose purpose is deleting files or directories. */
const FILE_DELETION_BINARIES = new Set(['rm', 'rmdir', 'shred', 'srm', 'unlink'])

/** Standalone binaries whose purpose is dropping databases (PostgreSQL ships these). */
const DB_DROP_BINARIES = new Set(['dropdb', 'dropuser'])

/**
 * Wrappers that execute the token that follows them, so `sudo rm`,
 * `xargs rm`, or `env FOO=1 rm` resolve to `rm` rather than the wrapper.
 * Shell interpreters, shell keywords, command-running builtins
 * (`eval`, `source`, `.`), and applet multiplexers (`busybox`, `toybox`)
 * are treated the same way: in `bash -c 'rm …'`, `do rm "$f"`, `eval rm …`,
 * or `busybox rm …` the effective command is the `rm` that follows, not
 * `bash`/`do`/`eval`/`busybox`.
 */
const COMMAND_WRAPPERS = new Set([
  '.',
  'ash',
  'bash',
  'builtin',
  'busybox',
  'command',
  'dash',
  'do',
  'doas',
  'elif',
  'else',
  'env',
  'eval',
  'exec',
  'if',
  'ionice',
  'ksh',
  'nice',
  'nohup',
  'sh',
  'source',
  'stdbuf',
  'sudo',
  'then',
  'time',
  'timeout',
  'toybox',
  'until',
  'while',
  'xargs',
  'zsh',
])

/**
 * Artisan subcommand prefixes that drop tables or wipe the database. These
 * are irreversible without a backup, so the guard treats them all as
 * database deletion.
 */
const DESTRUCTIVE_ARTISAN_PREFIXES = ['db:wipe', 'migrate:fresh', 'migrate:refresh', 'migrate:reset', 'migrate:rollback']

/**
 * SQL that removes a database object — in any quoting or case. Covers the
 * whole destructive DDL family (database, schema, table, view, index,
 * function, extension, type, …), including modifiers like `DROP TEMPORARY
 * TABLE`, `DROP MATERIALIZED VIEW`, and `DROP FOREIGN TABLE`. This list can
 * never be exhaustive — {@link SQL_CLIENT_BINARIES} below backstops it by
 * blocking ANY `DROP` handed to a known SQL client.
 */
const SQL_DROP_PATTERN =
  /\bdrop\s+(?:temporary\s+|materialized\s+|foreign\s+|if\s+exists\s+)*(?:access\s+method|aggregate|cast|collation|conversion|data\s+wrapper|database|domain|event|extension|function|index|language|operator|owned|package|policy|procedure|publication|role|routine|rule|schema|sequence|server|statistics|subscription|table|tablespace|transform|trigger|type|user|view)\b/i

/**
 * SQL client binaries. A segment invoking one of these with `drop` anywhere
 * in it is blocked outright, whatever the object type — this is the
 * non-enumerated backstop for {@link SQL_DROP_PATTERN}.
 */
const SQL_CLIENT_BINARIES = new Set([
  'clickhouse-client',
  'mariadb',
  'mongo',
  'mongosh',
  'mysql',
  'mysqlsh',
  'psql',
  'sqlcmd',
  'sqlite3',
])

/** PHP snippets tinker must never run: file deletion, DB drops, shell escapes. */
const TINKER_DELETION_PATTERNS: Array<{label: string; pattern: RegExp; what: string}> = [
  {label: 'unlink()', pattern: /\bunlink\s*\(/i, what: 'PHP file deletion'},
  {label: 'rmdir()', pattern: /\brmdir\s*\(/i, what: 'PHP directory deletion'},
  {
    label: 'File::delete*/cleanDirectory',
    pattern: /\bFile::(?:delete\w*|cleanDirectory)\s*\(/i,
    what: 'Filesystem facade deletion',
  },
  {
    label: 'Storage::delete*',
    pattern: /\bStorage::(?:disk\s*\([^)]*\)\s*->\s*)?delete\w*\s*\(/i,
    what: 'Storage facade deletion',
  },
  {
    // Any static ::drop*() call, whatever the class name — covers Schema::
    // directly AND aliased facades (`use …\Facades\Schema as S; S::drop…`).
    label: '::drop*()',
    pattern: /::\s*drop\w*\s*\(/i,
    what: 'Static schema drop call',
  },
  {
    // Chained drops on any builder: Schema::connection('x')->dropAllTables(),
    // DB::connection()->getSchemaBuilder()->dropAllTables(), …
    label: '->drop*()',
    pattern: /->\s*drop\w*\s*\(/i,
    what: 'Chained schema/builder drop',
  },
  {
    // The DB facade runs raw SQL, so ANY `drop` keyword in the same payload
    // is treated as database deletion — the object-type list can't enumerate
    // everything (DROP TEXT SEARCH CONFIGURATION, …), and there is no shell
    // SQL client here for the client backstop to match.
    label: 'DB::… with DROP',
    pattern: /(?=[\s\S]*\bDB::)(?=[\s\S]*\bdrop\b)/i,
    what: 'SQL DROP via the DB facade (any object type)',
  },
  {
    // Aliasing a guarded facade would defeat every facade pattern above
    // (`use …\Facades\File as F; F::deleteDirectory(…)`), so it is blocked
    // outright.
    label: String.raw`use …\Facades\X as Y`,
    pattern: /use\s+illuminate\\+support\\+facades\\+(?:artisan|db|file|schema|storage)\s+as\s+/i,
    what: 'Aliasing a guarded facade from tinker',
  },
  {
    // Blocked categorically, not just for destructive subcommands: the
    // subcommand string can be assembled at runtime ('migrate:'.'fresh'),
    // so pattern-matching it is evadable. Guarded artisan access exists
    // via `ssh artisan`.
    label: 'Artisan::call()/queue()',
    pattern: /\bArtisan::(?:call|queue)\s*\(/i,
    what: 'Artisan invocation from tinker (use `ssh artisan` instead, which is guarded)',
  },
  {
    // Service-locator route to the same console service: app('artisan'),
    // resolve('artisan'), App::make('artisan').
    label: "app('artisan')/resolve('artisan')",
    pattern: /\b(?:app|resolve|make)\s*\(\s*['"]artisan['"]\s*\)/i,
    what: 'Artisan service-locator access from tinker (use `ssh artisan` instead, which is guarded)',
  },
  {
    // Console kernel resolution (app(Illuminate\Contracts\Console\Kernel::class))
    // is the other spelling of the same escape hatch.
    label: String.raw`Console\Kernel`,
    pattern: /console\\{1,2}kernel/i,
    what: 'Console kernel access from tinker (use `ssh artisan` instead, which is guarded)',
  },
  {
    // Destructive artisan subcommand strings anywhere in the PHP — catches
    // invocation routes no pattern anticipates ($kernel->call('db:wipe')).
    label: 'db:wipe/migrate:fresh/…',
    pattern: /\b(?:db:wipe|migrate:(?:fresh|refresh|reset|rollback))\b/i,
    what: 'Destructive artisan subcommand referenced from tinker',
  },
  {
    label: 'exec()/shell_exec()/system()/…',
    pattern: /\b(?:exec|shell_exec|system|passthru|proc_open|popen|pcntl_exec)\s*\(/i,
    what: 'Shell execution from tinker (could delete files)',
  },
  {label: '`…` (shell-exec operator)', pattern: /`[^`]*`/, what: 'Shell execution from tinker (could delete files)'},
]

/**
 * Resolve the effective command word(s) of one shell segment: skip leading
 * `VAR=value` assignments, option flags, and command wrappers (`sudo`,
 * `xargs`, …), then strip any path prefix so `/bin/rm` matches `rm`.
 *
 * Without a wrapper the first real token is the only command word. Once a
 * wrapper is seen, EVERY later non-flag token is a candidate — a wrapper's
 * operand can otherwise shadow the real command (`sudo -u postgres rm …`
 * would resolve to `postgres`, `timeout 30 rm foo` to `30`). This over-counts
 * arguments in wrapper segments (`sudo echo rm` is blocked), which the guard
 * accepts as a conservative trade-off.
 */
function resolveCommandWords(segment: string): string[] {
  const words: string[] = []
  let sawWrapper = false

  for (const rawToken of segment.trim().split(/\s+/)) {
    // Remove ALL quote characters and backslashes, not just wrapping ones:
    // the pod shell concatenates quoted fragments and drops escapes before
    // execution, so `'rm'`, `rm''`, `r"m"`, and `\rm` all run rm.
    const token = rawToken.replaceAll(/["'\\]/g, '')
    if (token.length === 0 || token.startsWith('-') || /^\w+=/.test(token)) {
      continue
    }

    const bare = (token.split('/').pop() ?? token).toLowerCase()
    if (COMMAND_WRAPPERS.has(bare)) {
      sawWrapper = true
      continue
    }

    words.push(bare)
    if (!sawWrapper) {
      break
    }
  }

  return words
}

/** Match an artisan subcommand against the built-in destructive prefixes. */
function matchDestructiveArtisanPrefix(subcommand: string): string | undefined {
  const normalized = normalize(subcommand)
  return DESTRUCTIVE_ARTISAN_PREFIXES.find(
    (entry) =>
      normalized === entry || normalized.startsWith(`${entry} `) || normalized.startsWith(`${entry}:`),
  )
}

/** First tinker deletion pattern matching the given PHP, if any. */
function matchTinkerDeletionPattern(php: string): (typeof TINKER_DELETION_PATTERNS)[number] | undefined {
  return TINKER_DELETION_PATTERNS.find(({pattern}) => pattern.test(php))
}

/**
 * Guard an artisan invocation found inside a larger command: destructive
 * subcommand prefixes, plus — when the subcommand is `tinker` — the full
 * tinker PHP pattern scan, so `php artisan tinker --execute="…"` routed
 * through `ssh exec`/`ssh artisan` passes the same checks as `ssh tinker`.
 */
function checkEmbeddedArtisanArg(artisanArg: string): PermissionCheckResult {
  const prefix = matchDestructiveArtisanPrefix(artisanArg)
  if (prefix) {
    return deny(prefix, 'Artisan command that deletes database structures')
  }

  if (/^tinker\b/i.test(artisanArg.trim())) {
    const hit = matchTinkerDeletionPattern(artisanArg)
    if (hit) {
      return deny(hit.label, hit.what)
    }
  }

  return ALLOWED
}

/**
 * Sentinel a shell variable expands to when its value is dynamic (assigned
 * from command substitution or another opaque variable). It stands in for
 * "a command word we cannot verify statically"; the scan loop refuses any
 * segment that runs it as a command. Deliberately not a real binary name,
 * so it can only appear here.
 */
const OPAQUE_COMMAND_TOKEN = 'opaque-substituted-command'

/**
 * Inline simple shell variable assignments so a deletion hidden behind a
 * variable is caught: `cmd=rm; $cmd -rf storage` becomes `cmd=rm; rm -rf
 * storage` before scanning. Repeated until no further substitution occurs so
 * chained aliases (`a=rm; b=$a; $b …`) collapse too, with a small iteration
 * cap as a backstop.
 *
 * Values that are themselves dynamic — command substitution (`x=$(…)`,
 * backticks) or a reference to another variable — cannot be resolved
 * statically. We can't know what `x=$(printf rm)` produces, so such a
 * variable expands to {@link OPAQUE_COMMAND_TOKEN}: harmless as an argument
 * (`cat $files`), but refused if used as the command word (`$cmd -rf …`).
 */
function expandShellAssignments(command: string): string {
  const literals = new Map<string, string>()
  const opaque = new Set<string>()
  for (const [, name, rawValue] of command.matchAll(/(\b\w+)=("[^"]*"|'[^']*'|\S+)/g)) {
    if (/[$`]/.test(rawValue)) {
      // Value contains a substitution or another variable — unresolvable.
      opaque.add(name)
    } else {
      literals.set(name, rawValue.replaceAll(/["']/g, ''))
    }
  }

  if (literals.size === 0 && opaque.size === 0) {
    return command
  }

  let expanded = command
  for (let i = 0; i < 5; i++) {
    // Replace `$VAR` and `${VAR}` with the assigned value (or the opaque
    // sentinel, space-isolated so it reads as its own token).
    const next = expanded.replaceAll(/\$\{(\w+)\}|\$(\w+)/g, (match, braced, bare) => {
      const name = braced ?? bare
      if (literals.has(name)) {
        return literals.get(name)!
      }

      return opaque.has(name) ? ` ${OPAQUE_COMMAND_TOKEN} ` : match
    })
    if (next === expanded) {
      break
    }

    expanded = next
  }

  return expanded
}

/**
 * Permission check for `ssh exec`: refuse bash commands that delete files or
 * folders, or drop a database. The command is split on shell separators and
 * grouping syntax (`;`, `&&`, `|`, `$(…)`, `(…)`, `{…}`, backticks, newlines)
 * so a deletion hidden behind a harmless first command (`ls && rm -rf
 * storage`), inside a loop or group, or behind a nested shell
 * (`bash -c 'rm …'`) is still caught. Simple variable assignments are
 * expanded first so `cmd=rm; $cmd …` is caught too.
 */
export function checkShellDeletionPermission(rawCommand: string): PermissionCheckResult {
  const command = expandShellAssignments(rawCommand)
  const sqlDrop = command.match(SQL_DROP_PATTERN)
  if (sqlDrop) {
    return deny(sqlDrop[0], 'SQL that drops a database object')
  }

  // Catch artisan invocations smuggled through `ssh exec` (`php artisan
  // migrate:fresh`, `php artisan tinker --execute="…"`). Checked on the
  // WHOLE command, before segment splitting, because splitting on `(`
  // would tear apart the tinker PHP patterns.
  const artisanArg = command.match(/\bartisan\s+(.+)/is)
  if (artisanArg) {
    const artisanCheck = checkEmbeddedArtisanArg(artisanArg[1])
    if (!artisanCheck.allowed) {
      return artisanCheck
    }
  }

  // Split on separators AND grouping syntax — `(`, `)`, `{`, `}` — so a
  // deletion inside a subshell, brace group, or `$(…)` starts its own
  // segment (`( rm -rf storage )`, `{ rm foo; }`, `echo $(rm foo)`).
  for (const segment of command.split(/[\n;&|(){}]|`/)) {
    const words = resolveCommandWords(segment)
    if (words.length === 0) {
      continue
    }

    // A command word built from command substitution or another opaque
    // variable (`cmd=$(printf rm); $cmd …`) can't be verified statically, so
    // running it as a command is refused outright.
    if (words.includes(OPAQUE_COMMAND_TOKEN)) {
      return deny('$(…) command word', 'Command word built from substitution or an opaque variable (cannot be verified)')
    }

    const deletionWord = words.find((w) => FILE_DELETION_BINARIES.has(w))
    if (deletionWord) {
      return deny(deletionWord, 'File/folder deletion command')
    }

    const dbDropWord = words.find((w) => DB_DROP_BINARIES.has(w))
    if (dbDropWord) {
      return deny(dbDropWord, 'Database deletion command')
    }

    if (words.includes('find')) {
      if (/\s-delete\b/.test(segment)) {
        return deny('find -delete', 'File/folder deletion command')
      }

      // Whatever -exec/-execdir/-ok/-okdir runs is a command of its own, so
      // recurse into the full check — this resolves wrappers inside it too
      // (`find . -exec rm {} \;`, `find . -exec sh -c 'rm …' \;`).
      const execArg = segment.match(/\s-(?:exec|execdir|ok|okdir)\s+(.+)/i)
      if (execArg) {
        const execCheck = checkShellDeletionPermission(execArg[1])
        if (!execCheck.allowed) {
          return execCheck
        }
      }
    }

    if (words.includes('mysqladmin') && /\bdrop\b/i.test(segment)) {
      return deny('mysqladmin drop', 'Database deletion command')
    }

    // Backstop for SQL object types the DROP pattern doesn't enumerate
    // (DROP EXTENSION, DROP TYPE, DROP OWNED BY, …): any DROP handed to a
    // SQL client is treated as database deletion.
    const sqlClient = words.find((w) => SQL_CLIENT_BINARIES.has(w))
    if (sqlClient && /\bdrop\b/i.test(segment)) {
      return deny(`${sqlClient} … drop`, 'Database deletion command')
    }
  }

  return ALLOWED
}

/**
 * Permission check for `ssh artisan`: refuse subcommands that drop or wipe
 * database structures. The artisan argument ultimately runs inside a remote
 * `bash -c`, so it is also scanned for smuggled shell deletions
 * (e.g. `cache:clear; rm -rf storage`).
 */
export function checkArtisanDeletionPermission(subcommand: string): PermissionCheckResult {
  // Destructive prefixes, plus the tinker PHP scan when the subcommand is
  // `tinker --execute="…"` — tinker reached through artisan must pass the
  // same checks as `ssh tinker`.
  const artisanCheck = checkEmbeddedArtisanArg(subcommand)
  if (!artisanCheck.allowed) {
    return artisanCheck
  }

  return checkShellDeletionPermission(subcommand)
}

/**
 * Permission check for `ssh tinker`: refuse PHP that deletes files or
 * folders, drops database structures, or escapes to a shell. The PHP is
 * embedded in a remote `bash -c` string, so it is also scanned for shell
 * deletions in case of quote break-out.
 */
export function checkTinkerDeletionPermission(php: string): PermissionCheckResult {
  for (const {label, pattern, what} of TINKER_DELETION_PATTERNS) {
    if (pattern.test(php)) {
      return deny(label, what)
    }
  }

  return checkShellDeletionPermission(php)
}

export function checkArtisanBlacklist(command: string, blacklisted: string[]): BlacklistCheckResult {
  const normalizedCommand = normalize(command)

  for (const raw of blacklisted) {
    const entry = normalize(raw)
    // Block if the command *starts with* the blacklist entry followed by either
    // end-of-string or a word boundary (`:`, space). This stops `migrate` from
    // matching `migratelog` while still matching `migrate`, `migrate:status`,
    // and `migrate:fresh --seed`.
    if (
      normalizedCommand === entry ||
      normalizedCommand.startsWith(`${entry} `) ||
      normalizedCommand.startsWith(`${entry}:`)
    ) {
      return {
        allowed: false,
        blockedCommand: raw,
        reason: `Artisan command "${raw}" is blacklisted: migrations are destructive and require explicit review, approval, and backups.`,
      }
    }
  }

  return {allowed: true}
}
