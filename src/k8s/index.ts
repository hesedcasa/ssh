/**
 * Client-facing functions for SSH-to-Kubernetes-pod commands.
 *
 * Load the server profile from `ssh-servers.json` via `createProfileManager`,
 * resolve it into a fully-defaulted {@link ServerConnection}, then hand it to
 * the {@link PodRunner} engine. CLI flag overrides (`--namespace`,
 * `--component`, etc.) are applied on top of the profile so a single command
 * can target an ad-hoc namespace without editing config.
 */
import type {Config} from '@oclif/core'

import {createProfileManager} from '@hesed/plugin-lib'

import {getServerConnectionOptions, type K8sConfig, type ServerConnection, type ServerProfile} from './config-loader.js'
import {type ConnectionTestResult, type ExecResult, PodRunner} from './pod-runner.js'

export type {ServerConnection, ServerProfile} from './config-loader.js'

export {type ConnectionTestResult, type ExecResult, type PodExecResult, type SshRunner} from './pod-runner.js'

/** File (relative to oclif `configDir`) that stores server profiles. */
export const SERVER_CONFIG_FILE = 'ssh-servers.json'

let podRunner: null | PodRunner = null

/** Flags that override profile values for a single invocation. */
export interface ExecOverrides {
  component?: string
  container?: string
  namespace?: string
  role?: string
}

function getRunner(): PodRunner {
  if (!podRunner) {
    podRunner = new PodRunner()
  }

  return podRunner
}

/**
 * Read all profiles and resolve which profile name a call should target:
 * the explicit `profile` argument, else the recorded default, else (if no
 * default is recorded yet) the first profile on disk.
 */
async function resolveProfiles(
  config: Config,
  profile?: string,
): Promise<{profileName: string; profiles: Record<string, ServerProfile>}> {
  const pm = createProfileManager<ServerProfile>(config, undefined, SERVER_CONFIG_FILE)

  const profiles = await pm.readProfiles()
  if (!profiles || Object.keys(profiles).length === 0) {
    throw new Error('No SSH server profile found. Add one with `ssh servers add`.')
  }

  let defaultProfile: string
  try {
    defaultProfile = await pm.getDefaultProfile()
  } catch {
    // Fall back to the first profile if no default is recorded yet.
    defaultProfile = Object.keys(profiles)[0]
  }

  return {profileName: profile ?? defaultProfile, profiles}
}

async function initConfig(config: Config, profile?: string): Promise<ServerConnection> {
  const {profileName, profiles} = await resolveProfiles(config, profile)
  const k8s: K8sConfig = {defaultProfile: profileName, profiles}
  return getServerConnectionOptions(k8s, profileName)
}

/** Apply CLI overrides on top of the resolved profile connection. */
function applyOverrides(conn: ServerConnection, overrides: ExecOverrides): ServerConnection {
  return {
    ...conn,
    ...(overrides.component ? {component: overrides.component} : {}),
    ...(overrides.container ? {container: overrides.container} : {}),
    ...(overrides.namespace ? {namespace: overrides.namespace} : {}),
    ...(overrides.role ? {role: overrides.role} : {}),
  }
}

export async function execInPod(
  config: Config,
  command: string,
  profile?: string,
  overrides?: ExecOverrides,
): Promise<ExecResult> {
  const conn = await initConfig(config, profile)
  return getRunner().exec(applyOverrides(conn, overrides ?? {}), command)
}

export async function execInAllPods(
  config: Config,
  command: string,
  profile?: string,
  overrides?: ExecOverrides,
): Promise<ExecResult> {
  const conn = await initConfig(config, profile)
  return getRunner().execAll(applyOverrides(conn, overrides ?? {}), command)
}

/**
 * Run an artisan subcommand. The profile's `artisanPrefix` (default
 * `php artisan`) is prepended to `subcommand` here, so callers pass only the
 * artisan argument (e.g. `cache:clear`) — not the full shell command.
 */
// eslint-disable-next-line max-params -- mirrors executeQuery's signature
export async function runArtisan(
  config: Config,
  subcommand: string,
  profile?: string,
  overrides?: ExecOverrides,
  all = false,
): Promise<ExecResult> {
  const conn = await initConfig(config, profile)
  const fullCommand = `${conn.artisanPrefix} ${subcommand}`
  const target = applyOverrides(conn, overrides ?? {})
  return all ? getRunner().execAll(target, fullCommand) : getRunner().exec(target, fullCommand)
}

/**
 * Run a snippet of PHP via `artisan tinker --execute`. The caller passes raw
 * PHP (e.g. `User::count()`); it is wrapped and base64-encoded by the runner,
 * so — unlike the original skill — the user never needs to escape `$` or `"`.
 */
// eslint-disable-next-line max-params -- mirrors executeQuery's signature
export async function runTinker(
  config: Config,
  php: string,
  profile?: string,
  overrides?: ExecOverrides,
  all = false,
): Promise<ExecResult> {
  return runArtisan(config, `tinker --execute="${php}"`, profile, overrides, all)
}

/**
 * Artisan blacklist for a single profile; used by the `artisan` command.
 * `profile` is threaded through so this resolves the same profile the caller
 * is about to run against, rather than always falling back to the default
 * profile (which may not exist even when `-p` names a valid one).
 */
export async function getArtisanBlacklist(config: Config, profile?: string): Promise<string[]> {
  const conn = await initConfig(config, profile)
  return conn.blacklistedArtisanCommands
}

/**
 * Resolve a profile name (explicit or default) and read its current artisan
 * blacklist. Used by `ssh servers safety` to view/seed edits.
 */
export async function getProfileBlacklist(
  config: Config,
  profile?: string,
): Promise<{blacklist: string[]; profileName: string}> {
  const conn = await initConfig(config, profile)
  return {blacklist: conn.blacklistedArtisanCommands, profileName: conn.profileName}
}

/** Overwrite a profile's artisan blacklist on disk. Used by `ssh servers safety`. */
export async function setProfileBlacklist(config: Config, profileName: string, blacklist: string[]): Promise<void> {
  const pm = createProfileManager<ServerProfile>(config, undefined, SERVER_CONFIG_FILE)
  const profiles = await pm.readProfiles()
  const profile = profiles[profileName]
  if (!profile) {
    const availableProfiles = Object.keys(profiles).join(', ') || '(none)'
    throw new Error(`Profile "${profileName}" not found. Available profiles: ${availableProfiles}`)
  }

  profiles[profileName] = {...profile, blacklistedArtisanCommands: blacklist}
  await pm.saveProfiles(profiles)
}

/**
 * Connection test used by `ssh servers test`. Accepts a raw profile (from the
 * auth command's `testConnection` hook) rather than a profile name, since the
 * auth flow tests credentials before they're saved.
 */
export async function testServerConnection(profile: ServerProfile): Promise<ConnectionTestResult> {
  const testConfig: K8sConfig = {
    defaultProfile: 'default',
    profiles: {default: profile},
  }
  const conn = getServerConnectionOptions(testConfig, 'default')
  const runner = new PodRunner()
  const result = await runner.testConnection(conn)
  await runner.closeAll()
  return result
}

export async function closeConnections(): Promise<void> {
  if (podRunner) {
    await podRunner.closeAll()
    podRunner = null
  }
}

export {
  checkArtisanBlacklist,
  checkArtisanDeletionPermission,
  checkShellDeletionPermission,
  checkTinkerDeletionPermission,
} from './safety.js'
