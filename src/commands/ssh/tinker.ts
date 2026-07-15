import type {ApiResult} from '@hesed/plugin-lib'

import {Args, Flags} from '@oclif/core'

import {BaseCommand} from '../../base-command.js'
import {closeConnections, runTinker} from '../../k8s/index.js'
import {ExecData} from '../../k8s/pod-runner.js'

export default class SshTinker extends BaseCommand {
  static override args = {
    php: Args.string({
      description: 'PHP code to execute via tinker',
      required: true,
    }),
  }
  static override description = 'Execute PHP code in Laravel tinker'
  static override enableJsonFlag = true
  static override examples = [
    String.raw`<%= config.bin %> <%= command.id %> "App\\Models\\User::count()"`,
    '<%= config.bin %> <%= command.id %> "echo User::first()->email;" -p prod',
    '<%= config.bin %> <%= command.id %> "Cache::forget(\'some_key\')"',
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
    const {args, flags} = await this.parse(SshTinker)

    const overrides = {
      component: flags.component,
      container: flags.container,
      namespace: flags.namespace,
      role: flags.role,
    }
    // The PHP is single-quote wrapped (see buildTinkerCommand) so the pod's
    // inner bash never expands it — the user passes raw PHP, including
    // `$variables` and quotes, with no `\$` or `\"` escaping.
    const result = await this.withSpinner('Running tinker command', () =>
      runTinker(this.config, args.php, flags.profile, overrides, flags.all),
    )
    await closeConnections()

    if (result.success) {
      this.log(typeof result.data?.result === 'string' ? result.data.result : '')

      delete (result.data as ExecData).result

      return result
    }

    this.error(String(result.error ?? 'Tinker command failed'))
  }
}
