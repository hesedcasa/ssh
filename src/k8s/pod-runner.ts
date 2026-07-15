import type {ApiResult} from '@hesed/plugin-lib'

/**
 * Pod execution engine for SSH-to-Kubernetes-pod commands.
 *
 * This is the TypeScript counterpart of the reference skill's `pod-shell.sh`:
 * it reaches application pods via an SSH bastion chain (local → bastion →
 * kubectl host → `kubectl exec`), supports running on the first pod or fanning
 * out across every running pod with labelled output, and base64-encodes the
 * inner command so it survives both SSH hops without manual escaping.
 *
 * Each call here is a short-lived SSH process, so there is no connection pool
 * to close — `closeAll()` is a no-op kept for symmetry with the auth-command
 * `clearClients` contract.
 */
import {execFile} from 'node:child_process'

import type {ServerConnection} from './config-loader.js'

/** Default per-command timeout: 30 seconds (matches a reasonable pod round-trip). */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Output of a single pod execution. For `--all` fan-out the engine returns one
 * entry per pod; for a single-pod run it returns a single entry.
 */
export interface PodExecResult {
  /** Remote command exit code. Non-zero is not necessarily an error (e.g. `grep` exits 1 on zero matches). */
  exitCode: number
  /** Pod name (without the `pod/` prefix) this output came from. */
  pod: string
  stderr: string
  stdout: string
}

export interface ExecData {
  result?: string
  results?: PodExecResult[]
}

export type ExecResult = ApiResult & {data?: ExecData}

/** Connection-test payload returned by {@link PodRunner.testConnection}. */
export interface ConnectionTestData {
  pods: string[]
  result?: string
}

export type ConnectionTestResult = ApiResult & {data?: ConnectionTestData}

/** One distinct component/role combination and how many running pods carry it. */
export interface PodLabelCombo {
  component: string
  count: number
  role: string
}

/** Label-discovery payload returned by {@link PodRunner.discoverLabels}. */
export interface DiscoverLabelsData {
  combos: PodLabelCombo[]
  components: string[]
  namespace: string
  result?: string
  roles: string[]
}

export type DiscoverLabelsResult = ApiResult & {data?: DiscoverLabelsData}

/**
 * Runs an SSH command locally. Isolated as a parameter so tests can stub it
 * instead of making real network calls.
 */
export type SshRunner = (
  args: string[],
  timeoutMs: number,
) => Promise<{exitCode: number; stderr: string; stdout: string}>

/**
 * Default SSH runner using Node's `child_process.execFile`. Commands run
 * non-interactively (no `-it`) so output can be captured.
 *
 * A non-zero remote exit code RESOLVES (with the code) rather than rejecting:
 * commands like `grep -c` exit 1 on zero matches while still printing a valid
 * `0`, and rejecting would swallow that stdout. Only failures with no remote
 * exit code — spawn errors (ssh binary missing) and timeout kills — reject.
 */
export const defaultSshRunner: SshRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile('ssh', args, {maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs}, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) {
        reject(error)
        return
      }

      resolve({exitCode: error ? (error.code as number) : 0, stderr, stdout})
    })
  })

/**
 * Wrap a remote command in the SSH-hop argument list for `conn`.
 *
 * With a bastion:  ssh <user>@<bastion> -- ssh <sshHost> -- '<remoteCommand>'
 * Without one:     ssh <user>@<sshHost> -- <remoteCommand>
 *
 * The single quotes exist only for the bastion hop, and there they are
 * load-bearing: the bastion's login shell parses the forwarded string, and
 * without quoting it — not the k8s host — evaluates any `$(...)`, `|`, and
 * `;` in remoteCommand before the nested `ssh` ever sees it, so
 * `sudo kubectl` silently runs against the bastion instead of the k8s host.
 *
 * On a direct connection there is no intermediate shell to strip quotes:
 * the target's shell is the first to parse the string, so literal quotes
 * would survive quote-removal as a single word and bash would try to
 * execute the whole command line as one command name ("command not found").
 */
function wrapForHops(conn: ServerConnection, remoteCommand: string): string[] {
  if (conn.bastionHost) {
    return [`${conn.sshUser}@${conn.bastionHost}`, '--', 'ssh', conn.sshHost, '--', `'${remoteCommand}'`]
  }

  return [`${conn.sshUser}@${conn.sshHost}`, '--', remoteCommand]
}

/**
 * Kubernetes namespace/label/container names are DNS-1123-ish: letters,
 * digits, `-`, `_`, `.`. Nothing in that set can break out of the remote
 * shell string these values are interpolated into below.
 */
const SAFE_K8S_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/

/**
 * Reject any `ServerConnection` field — whether it came from a stored profile
 * or a CLI override like `--namespace`/`--component` — before it is
 * interpolated into a remote shell command. Without this, a value such as
 * `sa-test; rm -rf /` would terminate the intended `kubectl` argument and run
 * an attacker-controlled command on the SSH target (or bastion) instead of
 * merely failing to match a namespace.
 */
function assertSafeK8sValue(value: string, field: string): void {
  if (!SAFE_K8S_NAME.test(value)) {
    throw new Error(`Invalid ${field} "${value}": only letters, numbers, "-", "_", and "." are allowed.`)
  }
}

/**
 * Build the remote `kubectl exec` invocation for a single pod.
 *
 * The inner command is base64-encoded and decoded on the remote host so any
 * quoting, single quotes, or `$` variables in it survive both SSH hops
 * untouched — the same technique the original bash script used.
 */
export function buildPodExecArgs(conn: ServerConnection, pod: string, command: string): string[] {
  assertSafeK8sValue(conn.namespace, 'namespace')
  assertSafeK8sValue(conn.container, 'container')
  const encoded = Buffer.from(command).toString('base64')
  // `$(` and `$CMD` are not `${}` interpolations, so they stay literal here —
  // the remote bash receives `CMD=$(... | base64 -d); ... bash -c "$CMD"`.
  const remoteCommand = `CMD=$(echo ${encoded} | base64 -d); sudo kubectl -n ${conn.namespace} exec ${pod} -c ${conn.container} -- bash -c "$CMD"`
  return wrapForHops(conn, remoteCommand)
}

/**
 * Build the artisan subcommand for a tinker `--execute` run.
 *
 * The PHP is single-quoted, with embedded `'` escaped as `'\''`. This is
 * load-bearing: the pod runs the decoded command line through
 * `bash -c "$CMD"`, and that inner bash re-parses it — an inline
 * `--execute="${php}"` would have every `$var` in the PHP expanded away (and
 * any `"` would break the quoting) before PHP ever ran. Single quotes
 * suppress all expansion, so the PHP reaches tinker byte-for-byte using only
 * bash itself — no `base64` binary required inside the container image.
 */
export function buildTinkerCommand(php: string): string {
  const escaped = php.replaceAll("'", String.raw`'\''`)
  return `tinker --execute='${escaped}'`
}

/** Build the remote `kubectl get pod` invocation used to discover pods. */
export function buildListPodsArgs(conn: ServerConnection): string[] {
  assertSafeK8sValue(conn.namespace, 'namespace')
  assertSafeK8sValue(conn.component, 'component')
  assertSafeK8sValue(conn.role, 'role')
  // --field-selector=status.phase=Running restricts to running pods; -o=name
  // yields `pod/<name>` lines, which we strip below.
  // Both labels must live in ONE -l flag: kubectl's --selector is a plain
  // string flag, so a repeated -l silently replaces the earlier one.
  const remoteCommand = `sudo kubectl -n ${conn.namespace} get pod -l component=${conn.component},role=${conn.role} -o=name --field-selector=status.phase=Running`
  return wrapForHops(conn, remoteCommand)
}

/**
 * Build the unfiltered `kubectl get pod` invocation used by label discovery:
 * every running pod in the namespace with its component/role label values.
 */
export function buildDiscoverLabelsArgs(conn: ServerConnection): string[] {
  assertSafeK8sValue(conn.namespace, 'namespace')
  const columns = 'NAME:.metadata.name,COMPONENT:.metadata.labels.component,ROLE:.metadata.labels.role'
  const remoteCommand = `sudo kubectl -n ${conn.namespace} get pod -o custom-columns=${columns} --no-headers --field-selector=status.phase=Running`
  return wrapForHops(conn, remoteCommand)
}

/**
 * Parse `kubectl get pod -o custom-columns=...` (no headers) output into
 * distinct component/role combinations with pod counts. kubectl prints
 * `<none>` for pods missing a label; that value is kept verbatim.
 */
export function parsePodLabels(stdout: string): PodLabelCombo[] {
  const counts = new Map<string, PodLabelCombo>()
  for (const line of stdout.split('\n')) {
    const [pod, component, role] = line.trim().split(/\s+/)
    if (!pod || !component || !role) continue
    const key = `${component} ${role}`
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
    } else {
      counts.set(key, {component, count: 1, role})
    }
  }

  return [...counts.values()].sort((a, b) => a.component.localeCompare(b.component) || a.role.localeCompare(b.role))
}

/** Parse `kubectl get pod -o=name` output into bare pod names. */
export function parsePodNames(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^pod\//, ''))
}

export class PodRunner {
  private sshRunner: SshRunner
  private timeoutMs: number

  constructor(options?: {sshRunner?: SshRunner; timeoutMs?: number}) {
    this.sshRunner = options?.sshRunner ?? defaultSshRunner
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** No-op; SSH calls are stateless. Provided for the `clearClients` contract. */
  async closeAll(): Promise<void> {}

  /**
   * Discover the component/role label values on every running pod in the
   * connection's namespace — no selector applied. Used by `ssh servers discover`
   * so users can see what `--component`/`--role` values are valid.
   */
  async discoverLabels(conn: ServerConnection): Promise<DiscoverLabelsResult> {
    try {
      const {exitCode, stderr, stdout} = await this.sshRunner(buildDiscoverLabelsArgs(conn), this.timeoutMs)
      if (exitCode !== 0) {
        throw new Error(`kubectl get pod failed (exit code ${exitCode})${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
      }

      const combos = parsePodLabels(stdout)
      if (combos.length === 0) {
        throw new Error(`No running pods found in namespace=${conn.namespace}.`)
      }

      const components = [...new Set(combos.map((c) => c.component))]
      const roles = [...new Set(combos.map((c) => c.role))]
      const lines = combos.map((c) => `  • component=${c.component} role=${c.role} — ${c.count} pod(s)`)
      const result =
        `Running pods in namespace '${conn.namespace}':\n\n${lines.join('\n')}\n\n` +
        `Profile '${conn.profileName}' selects: component=${conn.component} role=${conn.role}`

      return {
        data: {combos, components, namespace: conn.namespace, result, roles},
        success: true,
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        error: `ERROR: ${errorMessage}`,
        success: false,
      }
    }
  }

  /**
   * Execute a command in the first running pod.
   *
   * Returns a formatted human-readable `result` plus the raw per-pod entry in
   * `results` for machine consumers.
   *
   * A non-zero remote exit code is reported, not treated as a failure: the
   * command's stdout/stderr are still returned (e.g. `grep -c` exits 1 on
   * zero matches while printing a perfectly valid `0`), with the exit code
   * appended so callers can tell the run wasn't clean.
   */
  async exec(conn: ServerConnection, command: string): Promise<ExecResult> {
    try {
      const [pod] = await this.listPods(conn)
      const {exitCode, stderr, stdout} = await this.sshRunner(buildPodExecArgs(conn, pod, command), this.timeoutMs)
      const entry: PodExecResult = {exitCode, pod, stderr, stdout}
      const result =
        exitCode === 0
          ? stdout
          : [stdout.trimEnd(), stderr.trimEnd(), `[remote command exited with code ${exitCode}]`]
              .filter(Boolean)
              .join('\n')
      return {
        data: {
          result,
          results: [entry],
        },
        success: true,
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        error: `ERROR: ${errorMessage}`,
        success: false,
      }
    }
  }

  /**
   * Execute a command in every running pod, labelling each output block with
   * `===== <pod> =====` — matching the skill's `--all` behaviour. Essential for
   * log scanning, since requests are load-balanced across pods.
   */
  async execAll(conn: ServerConnection, command: string): Promise<ExecResult> {
    try {
      const pods = await this.listPods(conn)
      const entries: PodExecResult[] = []

      for (const pod of pods) {
        // Run pods sequentially to keep labelled blocks ordered and readable.
        // eslint-disable-next-line no-await-in-loop -- intentional: ordered output
        const {exitCode, stderr, stdout} = await this.sshRunner(buildPodExecArgs(conn, pod, command), this.timeoutMs)
        entries.push({exitCode, pod, stderr, stdout})
      }

      const formatted = entries
        .map((entry) => {
          const label = entry.exitCode === 0 ? entry.pod : `${entry.pod} (exit code ${entry.exitCode})`
          return `===== ${label} =====\n${entry.stdout}${entry.stderr ? `\n${entry.stderr}` : ''}`
        })
        .join('\n\n')

      return {
        data: {
          result: formatted,
          results: entries,
        },
        success: true,
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        error: `ERROR: ${errorMessage}`,
        success: false,
      }
    }
  }

  /**
   * List running pods matching the connection's selector.
   *
   * @throws if the SSH/kubectl invocation fails or returns no pods.
   */
  async listPods(conn: ServerConnection): Promise<string[]> {
    const {exitCode, stderr, stdout} = await this.sshRunner(buildListPodsArgs(conn), this.timeoutMs)
    if (exitCode !== 0) {
      // Pod listing output is machine-parsed, so a failed kubectl/ssh call
      // must surface as an error — otherwise an auth failure would masquerade
      // as "No running pods found".
      throw new Error(`kubectl get pod failed (exit code ${exitCode})${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
    }

    const pods = parsePodNames(stdout)
    if (pods.length === 0) {
      throw new Error(
        `No running pods found for namespace=${conn.namespace} component=${conn.component} role=${conn.role}.`,
      )
    }

    return pods
  }

  /**
   * Smoke-test a server profile: list its running pods. Used by `ssh servers
   * test` to validate the SSH chain and credentials without running a command.
   */
  async testConnection(conn: ServerConnection): Promise<ConnectionTestResult> {
    try {
      const pods = await this.listPods(conn)
      return {
        data: {
          pods,
          result: `Connection successful!\n\nProfile: ${conn.profileName}\nBastion: ${conn.bastionHost ?? '(none — direct connection)'}\nSSH host: ${conn.sshHost}\nNamespace: ${conn.namespace}\nRunning pods (${pods.length}):\n${pods.map((p) => `  • ${p}`).join('\n')}`,
        },
        success: true,
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        error: `ERROR: ${errorMessage}`,
        success: false,
      }
    }
  }
}
