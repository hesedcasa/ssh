import type {ApiResult} from '@hesed/plugin-lib'

import {Args, Flags} from '@oclif/core'

import {BaseCommand} from '../../base-command.js'
import {checkShellDeletionPermission, closeConnections, execInAllPods, execInPod} from '../../k8s/index.js'
import {ExecData} from '../../k8s/pod-runner.js'

export default class SshExec extends BaseCommand {
  static override args = {
    command: Args.string({description: 'Command to execute in the pod', required: true}),
  }
  static override description =
    'Execute a bash command in a Kubernetes pod via SSH (local → bastion → kubectl host → pod)'
  static override enableJsonFlag = true
  static override examples = [
    '<%= config.bin %> <%= command.id %> pwd',
    '<%= config.bin %> <%= command.id %> "tail -20 storage/logs/laravel-$(date +%Y-%m-%d).log" --all -p prod',
    '<%= config.bin %> <%= command.id %> "grep ERROR storage/logs/laravel.log" --namespace sa-testqa',
  ]
  static override flags = {
    all: Flags.boolean({
      default: false,
      description: 'Run on ALL running pods; output is labelled per pod',
    }),
    component: Flags.string({description: 'Override pod component label (default: from profile)'}),
    container: Flags.string({description: 'Override container name (default: from profile)'}),
    namespace: Flags.string({description: 'Override Kubernetes namespace (default: from profile)'}),
    profile: Flags.string({char: 'p', description: 'SSH server profile name from config', required: false}),
    role: Flags.string({description: 'Override pod role label (default: from profile)'}),
  }

  public async run(): Promise<ApiResult> {
    const {args, flags} = await this.parse(SshExec)

    // Built-in deletion guard: always on, cannot be disabled by config.
    const permission = checkShellDeletionPermission(args.command)
    if (!permission.allowed) {
      this.error(`${permission.reason ?? 'Command blocked by the deletion guard.'}\n\nThis operation cannot be executed.`)
    }

    const overrides = {
      component: flags.component,
      container: flags.container,
      namespace: flags.namespace,
      role: flags.role,
    }
    const result = await this.withSpinner('Running command', () =>
      flags.all
        ? execInAllPods(this.config, args.command, flags.profile, overrides)
        : execInPod(this.config, args.command, flags.profile, overrides),
    )
    await closeConnections()

    if (result.success) {
      this.log(typeof result.data?.result === 'string' ? result.data.result : '')

      delete (result.data as ExecData).result

      return result
    }

    this.error(String(result.error ?? 'Command failed'))
  }
}
