/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai'
import esmock from 'esmock'
import {type SinonStub, stub} from 'sinon'

describe('ssh:exec', () => {
  let SshExec: any
  let execInPodStub: SinonStub
  let execInAllPodsStub: SinonStub
  let closeConnectionsStub: SinonStub
  let getExecAllowlistStub: SinonStub
  let checkCommandAllowlistStub: SinonStub

  const mockResult = {
    data: {result: '/var/www\n', results: [{pod: 'api-1', stderr: '', stdout: '/var/www\n'}]},
    success: true,
  }

  beforeEach(async () => {
    execInPodStub = stub().resolves(mockResult)
    execInAllPodsStub = stub().resolves(mockResult)
    closeConnectionsStub = stub().resolves()
    // Default: empty allowlist (allowlist disabled — every command may run);
    // individual tests override the resolved list.
    getExecAllowlistStub = stub().resolves([])
    // The real checkCommandAllowlist is used by default so the allow/block logic
    // is exercised through the command path too.
    const {checkCommandAllowlist} = await import('../../../../src/k8s/safety.js')
    checkCommandAllowlistStub = stub().callsFake(checkCommandAllowlist)

    const imported = await esmock('../../../../src/commands/ssh/exec/index.js', {
      '../../../../src/k8s/index.js': {
        checkCommandAllowlist: checkCommandAllowlistStub,
        closeConnections: closeConnectionsStub,
        execInAllPods: execInAllPodsStub,
        execInPod: execInPodStub,
        getExecAllowlist: getExecAllowlistStub,
      },
    })
    SshExec = imported.default
  })

  function makeCmd(argv: string[]) {
    const cmd = new SshExec(argv, {
      root: process.cwd(),
      runHook: stub().resolves({failures: [], successes: []}),
    } as any)
    stub(cmd, 'log')
    return cmd
  }

  it('runs a command in a single pod (default) and logs the result', async () => {
    const cmd = makeCmd(['pwd'])
    await cmd.run()

    expect(execInPodStub.calledOnce).to.be.true
    expect(execInAllPodsStub.called).to.be.false
    // (config, command, profile, overrides)
    const {args} = execInPodStub.firstCall
    expect(args[1]).to.equal('pwd')
    expect(args[2]).to.be.undefined // profile defaults from config
  })

  it('fans out with --all', async () => {
    const cmd = makeCmd(['tail -20 log', '--all'])
    await cmd.run()

    expect(execInAllPodsStub.calledOnce).to.be.true
    expect(execInPodStub.called).to.be.false
    expect(execInAllPodsStub.firstCall.args[1]).to.equal('tail -20 log')
  })

  it('passes profile and namespace/component overrides through', async () => {
    const cmd = makeCmd(['pwd', '-p', 'prod', '--namespace', 'sa-testqa', '--component', 'worker'])
    await cmd.run()

    const {args} = execInPodStub.firstCall
    expect(args[2]).to.equal('prod')
    expect(args[3]).to.deep.equal({component: 'worker', container: undefined, namespace: 'sa-testqa', role: undefined})
  })

  it('always calls closeConnections', async () => {
    const cmd = makeCmd(['pwd'])
    await cmd.run()
    expect(closeConnectionsStub.calledOnce).to.be.true
  })

  it('runs any command when the allowlist is empty', async () => {
    const cmd = makeCmd(['rm -rf /tmp/cache'])
    await cmd.run()

    expect(getExecAllowlistStub.calledOnce).to.be.true
    expect(checkCommandAllowlistStub.calledOnce).to.be.true
    expect(execInPodStub.calledOnce).to.be.true
  })

  it('runs a command matching an allowlist entry', async () => {
    getExecAllowlistStub.resolves(['tail', 'grep'])
    const cmd = makeCmd(['tail -20 storage/logs/laravel.log'])
    await cmd.run()

    expect(execInPodStub.calledOnce).to.be.true
  })

  it('blocks a command not in the allowlist before reaching the runner', async () => {
    getExecAllowlistStub.resolves(['tail', 'grep'])
    const cmd = makeCmd(['rm -rf /'])
    try {
      await cmd.run()
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/allowlist/i)
    }

    expect(execInPodStub.called).to.be.false
    expect(execInAllPodsStub.called).to.be.false
  })

  it('resolves the allowlist for the requested profile', async () => {
    const cmd = makeCmd(['pwd', '-p', 'prod'])
    await cmd.run()

    expect(getExecAllowlistStub.firstCall.args[1]).to.equal('prod')
  })

  it('errors when the engine reports failure', async () => {
    execInPodStub.resolves({error: 'ERROR: boom', success: false})
    const cmd = makeCmd(['pwd'])
    // this.error() throws an oclif error wrapping the message.
    try {
      await cmd.run()
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/boom/)
    }

    expect(closeConnectionsStub.calledOnce).to.be.true
  })
})
