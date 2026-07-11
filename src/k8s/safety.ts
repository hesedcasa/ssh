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
  const normalizedCommand = normalize(command)

  for (const raw of blacklisted) {
    const entry = normalize(raw)
    if (entry && matchesEntry(normalizedCommand, entry)) {
      return {
        allowed: false,
        blockedCommand: raw,
        reason: `The ${commandKind} command "${raw}" is blacklisted for this profile: it is considered destructive and requires explicit review, approval, and backups.`,
      }
    }
  }

  return {allowed: true}
}

/**
 * Check a command against an allow-list. An empty (or all-blank) list disables
 * the guard: every command may run. Otherwise the command must match one of
 * the entries.
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

  const normalizedCommand = normalize(command)
  if (entries.some((entry) => matchesEntry(normalizedCommand, entry))) {
    return {allowed: true}
  }

  return {
    allowed: false,
    reason: `Command is not in the profile's ${commandKind} allowlist. Allowed command prefixes: ${allowed.join(', ')}.`,
  }
}
