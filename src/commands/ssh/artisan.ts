import type {ApiResult} from '@hesed/plugin-lib'

import {Args, Flags} from '@oclif/core'

import {BaseCommand} from '../../base-command.js'
import {
  checkArtisanBlacklist,
  checkArtisanDeletionPermission,
  closeConnections,
  getArtisanBlacklist,
  runArtisan,
} from '../../k8s/index.js'
import {ExecData} from '../../k8s/pod-runner.js'

export default class SshArtisan extends BaseCommand {
  static override args = {
    command: Args.string({
      description: 'Artisan command to run (e.g. cache:clear, route:list, queue:restart)',
      required: true,
    }),
  }
  static override description =
    "Run a Laravel artisan command in a Kubernetes pod (blocked by the profile's artisan blacklist, if any — see `ssh servers safety`)"
  static override enableJsonFlag = true
  static override examples = [
    '<%= config.bin %> <%= command.id %> cache:clear',
    '<%= config.bin %> <%= command.id %> route:list -p prod',
    '<%= config.bin %> <%= command.id %> queue:restart --namespace sa-testqa',
  ]
  static override flags = {
    all: Flags.boolean({default: false, description: 'Run on ALL running pods; output is labelled per pod'}),
    component: Flags.string({description: 'Override pod component label (default: from profile)'}),
    container: Flags.string({description: 'Override container name (default: from profile)'}),
    namespace: Flags.string({description: 'Override Kubernetes namespace (default: from profile)'}),
    profile: Flags.string({char: 'p', description: 'SSH server profile name from config', required: false}),
    role: Flags.string({description: 'Override pod role label (default: from profile)'}),
  }

  public async run(): Promise<ApiResult> {
    const {args, flags} = await this.parse(SshArtisan)

    // Built-in deletion guard: always on, cannot be disabled by config.
    const permission = checkArtisanDeletionPermission(args.command)
    if (!permission.allowed) {
      this.error(`${permission.reason ?? 'Command blocked by the deletion guard.'}\n\nThis operation cannot be executed.`)
    }

    // Safety guard: block destructive migration commands before they reach a pod.
    const blacklist = await getArtisanBlacklist(this.config, flags.profile)
    const check = checkArtisanBlacklist(args.command, blacklist)
    if (!check.allowed) {
      this.error(`${check.reason ?? 'Command blocked by safety rules.'}\n\nThis operation cannot be executed.`)
    }

    const overrides = {
      component: flags.component,
      container: flags.container,
      namespace: flags.namespace,
      role: flags.role,
    }
    const result = await this.withSpinner('Running artisan command', () =>
      runArtisan(this.config, args.command, flags.profile, overrides, flags.all),
    )
    await closeConnections()

    if (result.success) {
      this.log(typeof result.data?.result === 'string' ? result.data.result : '')

      delete (result.data as ExecData).result

      return result
    }

    this.error(String(result.error ?? 'Artisan command failed'))
  }
}
