/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai'
import esmock from 'esmock'
import {type SinonStub, stub} from 'sinon'

describe('ssh:exec', () => {
  let SshExec: any
  let execInPodStub: SinonStub
  let execInAllPodsStub: SinonStub
  let closeConnectionsStub: SinonStub

  const mockResult = {
    data: {result: '/var/www\n', results: [{pod: 'api-1', stderr: '', stdout: '/var/www\n'}]},
    success: true,
  }

  beforeEach(async () => {
    execInPodStub = stub().resolves(mockResult)
    execInAllPodsStub = stub().resolves(mockResult)
    closeConnectionsStub = stub().resolves()

    const imported = await esmock('../../../src/commands/ssh/exec.js', {
      '../../../src/k8s/index.js': {
        closeConnections: closeConnectionsStub,
        execInAllPods: execInAllPodsStub,
        execInPod: execInPodStub,
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
