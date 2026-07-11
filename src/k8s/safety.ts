/**
 * Safety guards for commands that run inside a pod.
 *
 * Two complementary, command-agnostic checks share one prefix matcher:
 *
 * - {@link checkCommandBlacklist} — deny-list: block a command matching any
 *   entry. Used by `ssh artisan` to keep destructive migrations out of pods
 *   (the contract inherited from the original `pod-shell.sh` skill).
 * - {@link checkCommandAllowlist} — allow-list: only run a command matching an
 *   entry; an empty list disables the guard entirely. Used by `ssh exec`.
 *
 * Neither knows anything about artisan or exec specifically — the
 * `commandKind` label ('artisan', 'exec', 'tinker', …) only shapes the
 * human-readable reason, so future commands can reuse these guards without
 * touching the matching logic.
 *
 * Matching is by whitespace/`:`-delimited prefix: a blacklist entry `migrate`
 * blocks `migrate`, `migrate:status`, and `migrate:fresh --seed` but not
 * `migratelog`; an allowlist entry `tail` permits `tail -20 log` but not
 * `tailscale status`. An entry may itself contain spaces (e.g.
 * `migrate:fresh --seed`) to match multi-token commands.
 *
 * The remote runner executes the whole command via `bash -c "$CMD"` (see
 * `pod-runner.ts`), so chaining (`;`, `&&`, `||`, `&`, a bare newline),
 * piping (`|`), and command substitution (`` ` `` / `$(...)`) all let one
 * exec argument run more than one command. Rather than reject chaining
 * outright, both checks split the command into every individual command it
 * would actually run (see {@link flattenCommands}) and check each one — so
 * `"grep ERROR log | tail -5"` is allowed when both `grep` and `tail` are
 * allowlisted, but `"tail -5 log && rm -rf /"` is still blocked because
 * `rm` isn't. Redirection (`<`, `>`) is rejected outright instead, since it
 * doesn't name a command to check — it lets an already-permitted command
 * read or overwrite an arbitrary file.
 */

export interface SafetyCheckResult {
  allowed: boolean
  /** The list entry that blocked the command (blacklist checks only). */
  blockedCommand?: string
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
 * True when `command` *starts with* `entry` followed by end-of-string or a
 * word boundary (space or `:`). Both arguments must already be normalized.
 */
function matchesEntry(command: string, entry: string): boolean {
  return command === entry || command.startsWith(`${entry} `) || command.startsWith(`${entry}:`)
}

/** True when `command` contains file redirection, which we refuse outright — see module docs. */
function hasRedirection(command: string): boolean {
  return /[<>]/.test(command)
}

/**
 * Split a command on top-level `;`, `&&`, `||`, `&`, `|`, and newlines
 * (bash treats an unquoted newline as a command terminator, same as `;`),
 * ignoring any that appear inside single or double quotes (so
 * `grep "a && b" file` stays one segment). Not a full shell parser — just
 * enough to stop quoted metacharacters from being mistaken for chain
 * operators.
 */
function splitChainOperators(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  let i = 0

  while (i < command.length) {
    const ch = command[i]

    if (quote) {
      current += ch
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[i + 1]
        i += 2
        continue
      }

      if (ch === quote) quote = undefined

      i += 1
      continue
    }

    if (ch === '\\' && i + 1 < command.length) {
      current += ch + command[i + 1]
      i += 2
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      i += 1
      continue
    }

    if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
      segments.push(current)
      current = ''
      i += 2
      continue
    }

    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') {
      segments.push(current)
      current = ''
      i += 1
      continue
    }

    current += ch
    i += 1
  }

  segments.push(current)
  return segments.map((segment) => segment.trim()).filter(Boolean)
}

/**
 * Extract the inner command text of every `` `...` `` and `$(...)` command
 * substitution in `text` (balancing nested parens for `$(...)`). Each
 * extracted command is itself run remotely, so it must pass the same check
 * as everything else.
 */
function extractSubstitutions(text: string): string[] {
  const found: string[] = []

  for (const match of text.matchAll(/`([^`]*)`/g)) {
    found.push(match[1])
  }

  let start = text.indexOf('$(')
  while (start !== -1) {
    let depth = 1
    let i = start + 2
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth += 1
      else if (text[i] === ')') depth -= 1

      i += 1
    }

    found.push(text.slice(start + 2, depth === 0 ? i - 1 : i))
    start = text.indexOf('$(', i)
  }

  return found
}

/**
 * Flatten a raw command into every individual command it would actually run:
 * top-level chain/pipe segments plus the contents of any command
 * substitutions, recursively (a substitution can itself chain or substitute
 * further).
 */
function flattenCommands(command: string): string[] {
  const flattened: string[] = []

  for (const segment of splitChainOperators(command)) {
    flattened.push(segment)
    for (const substitution of extractSubstitutions(segment)) {
      flattened.push(...flattenCommands(substitution))
    }
  }

  return flattened
}

/**
 * Check a command against a deny-list. Blank entries are ignored; an empty
 * list blocks nothing.
 *
 * @param command      the command as the user typed it (e.g. the artisan
 *                     argument `migrate:status`, or a full shell command).
 * @param blacklisted  command prefixes to block, e.g. `['migrate', ...]`.
 * @param commandKind  label for the reason message, e.g. `artisan`.
 */
export function checkCommandBlacklist(
  command: string,
  blacklisted: string[],
  commandKind = 'command',
): SafetyCheckResult {
  const entries = blacklisted.map((raw) => ({entry: normalize(raw), raw})).filter(({entry}) => entry)
  if (entries.length === 0) {
    return {allowed: true}
  }

  if (hasRedirection(command)) {
    return {
      allowed: false,
      reason: `The ${commandKind} command contains file redirection (<, >), which could read or overwrite a file outside this check. Remove the redirection and run the command directly.`,
    }
  }

  for (const segment of flattenCommands(command)) {
    const normalizedSegment = normalize(segment)
    for (const {entry, raw} of entries) {
      if (matchesEntry(normalizedSegment, entry)) {
        return {
          allowed: false,
          blockedCommand: raw,
          reason: `The ${commandKind} command "${raw}" is blacklisted for this profile.`,
        }
      }
    }
  }

  return {allowed: true}
}

/**
 * Check a command against an allow-list. An empty (or all-blank) list disables
 * the guard: every command may run. Otherwise every command in the chain
 * (see {@link flattenCommands}) must match one of the entries.
 *
 * @param command      the command as the user typed it.
 * @param allowed      command prefixes permitted, e.g. `['tail', 'grep']`.
 * @param commandKind  label for the reason message, e.g. `exec`.
 */
export function checkCommandAllowlist(command: string, allowed: string[], commandKind = 'command'): SafetyCheckResult {
  const entries = allowed.map((entry) => normalize(entry)).filter(Boolean)
  if (entries.length === 0) {
    return {allowed: true}
  }

  if (hasRedirection(command)) {
    return {
      allowed: false,
      reason: `Command contains file redirection (<, >), which could read or overwrite a file outside the profile's ${commandKind} allowlist. Remove the redirection and run the command directly.`,
    }
  }

  for (const segment of flattenCommands(command)) {
    const normalizedSegment = normalize(segment)
    if (!entries.some((entry) => matchesEntry(normalizedSegment, entry))) {
      return {
        allowed: false,
        reason: `The command "${segment}" is not in the profile's ${commandKind} allowlist.`,
      }
    }
  }

  return {allowed: true}
}

/**
 * Render a list of command prefixes for CLI display — one bullet per entry,
 * or `emptyMessage` when the list is empty. Shared by `ssh artisan block`
 * and `ssh exec allow`.
 */
export function formatCommandList(list: string[], emptyMessage: string): string {
  return list.length > 0 ? list.map((entry) => `  • ${entry}`).join('\n') : `  ${emptyMessage}`
}

/**
 * Apply `--add`/`--remove`/`--clear`-style edits to a list, in that order
 * (clear first, so a `--clear --add x` invocation replaces the list with
 * just `x`). Entries are compared case-insensitively; `--add` skips
 * duplicates. Shared by `ssh artisan block` and `ssh exec allow`.
 */
export function applyListEdits(current: string[], add?: string[], remove?: string[], clear?: boolean): string[] {
  let updated = clear ? [] : [...current]

  if (remove) {
    const toRemove = new Set(remove.map((entry) => entry.trim().toLowerCase()))
    updated = updated.filter((entry) => !toRemove.has(entry.trim().toLowerCase()))
  }

  if (add) {
    for (const raw of add) {
      const entry = raw.trim()
      if (entry && !updated.some((existing) => existing.toLowerCase() === entry.toLowerCase())) {
        updated.push(entry)
      }
    }
  }

  return updated
}
