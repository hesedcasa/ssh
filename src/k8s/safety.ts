/**
 * Safety guards for `ssh artisan` and `ssh exec`.
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

interface AllowlistCheckResult {
  allowed: boolean
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

/**
 * Check whether an exec command is allowed by a profile's exec allowlist.
 *
 * An empty (or omitted) allowlist disables the guard: every command may run.
 * Otherwise the command must *start with* one of the allowlist entries,
 * followed by end-of-string or a space — so an entry like `tail` matches
 * `tail -20 log` but not `tailscale status`.
 *
 * @param command  the full shell command passed to `ssh exec`.
 * @param allowed  command prefixes permitted for this profile, e.g. `['tail', 'grep']`.
 */
export function checkExecAllowlist(command: string, allowed: string[]): AllowlistCheckResult {
  const entries = allowed.map((entry) => normalize(entry)).filter(Boolean)
  if (entries.length === 0) {
    return {allowed: true}
  }

  const normalizedCommand = normalize(command)
  for (const entry of entries) {
    if (normalizedCommand === entry || normalizedCommand.startsWith(`${entry} `)) {
      return {allowed: true}
    }
  }

  return {
    allowed: false,
    reason: `Command is not in the profile's exec allowlist. Allowed command prefixes: ${allowed.join(', ')}.`,
  }
}
