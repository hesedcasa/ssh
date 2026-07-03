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
