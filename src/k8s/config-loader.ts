/**
 * Configuration model for SSH-to-Kubernetes-pod execution.
 *
 * A {@link ServerProfile} describes the topology needed to reach a set of
 * application pods from the local machine: an SSH bastion jump host, the SSH
 * host that runs `kubectl`, the Kubernetes namespace, and the pod selector
 * labels/container. Nothing about a specific deployment is hard-coded — every
 * connection detail is profile data.
 *
 * Profiles live on disk in `ssh-servers.json` as `{defaultProfile, profiles}`,
 * managed by `createProfileManager<ServerProfile>` from `@hesed/plugin-lib`.
 */

/** Default `php artisan` invocation prefix; overridable per profile. */
export const DEFAULT_ARTISAN_PREFIX = 'php artisan'

export interface ServerProfile {
  /** Prefix prepended to artisan subcommands, e.g. `php artisan`. */
  artisanPrefix?: string
  /** First SSH hop: the bastion / jump host, e.g. `sglogin.example.com`. */
  bastionHost: string
  /**
   * Artisan subcommand prefixes (e.g. `migrate`) that `ssh artisan` refuses to
   * run against this profile. Empty/omitted means nothing is blocked — manage
   * it with `ssh servers safety`.
   */
  blacklistedArtisanCommands?: string[]
  /** Pod selector `component` label. */
  component: string
  /** Container name within the pod. */
  container: string
  /** Full Kubernetes namespace, e.g. `sa-test1` (no prefix is assumed). */
  namespace: string
  /** Pod selector `role` label. */
  role: string
  /** Second SSH hop: the host that runs `kubectl`, e.g. `k8s-node.example.com`. */
  sshHost: string
  /** Username for both SSH hops, e.g. `allen`. */
  sshUser: string
}

export interface K8sConfig {
  defaultProfile: string
  profiles: Record<string, ServerProfile>
}

/**
 * Resolved, fully-defaulted connection details for a single profile.
 *
 * Returned by {@link getServerConnectionOptions} so the runner never has to
 * re-apply defaults itself.
 */
export interface ServerConnection {
  artisanPrefix: string
  bastionHost: string
  /** Resolved artisan blacklist for this profile; `[]` when none is configured. */
  blacklistedArtisanCommands: string[]
  component: string
  container: string
  namespace: string
  profileName: string
  role: string
  sshHost: string
  sshUser: string
}

/**
 * Resolve a named profile into fully-defaulted connection options.
 *
 * @throws if `profileName` is not present in `config.profiles` (mirrors the
 *   error behaviour of `getPgConnectionOptions`).
 */
export function getServerConnectionOptions(config: K8sConfig, profileName: string): ServerConnection {
  const profile = config.profiles[profileName]

  if (!profile) {
    const availableProfiles = Object.keys(config.profiles).join(', ') || '(none)'
    throw new Error(`Profile "${profileName}" not found. Available profiles: ${availableProfiles}`)
  }

  return {
    artisanPrefix: profile.artisanPrefix ?? DEFAULT_ARTISAN_PREFIX,
    bastionHost: profile.bastionHost,
    blacklistedArtisanCommands: profile.blacklistedArtisanCommands ?? [],
    component: profile.component,
    container: profile.container,
    namespace: profile.namespace,
    profileName,
    role: profile.role,
    sshHost: profile.sshHost,
    sshUser: profile.sshUser,
  }
}
