/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai'
import esmock from 'esmock'
import {type SinonStub, stub} from 'sinon'

describe('ssh:tinker', () => {
  let SshTinker: any
  let runTinkerStub: SinonStub
  let closeConnectionsStub: SinonStub

  const mockResult = {
    data: {result: '42\n'},
    success: true,
  }

  beforeEach(async () => {
    runTinkerStub = stub().resolves(mockResult)
    closeConnectionsStub = stub().resolves()

    const imported = await esmock('../../../src/commands/ssh/tinker.js', {
      '../../../src/k8s/index.js': {
        closeConnections: closeConnectionsStub,
        runTinker: runTinkerStub,
      },
    })
    SshTinker = imported.default
  })

  function makeCmd(argv: string[]) {
    const cmd = new SshTinker(argv, {
      root: process.cwd(),
      runHook: stub().resolves({failures: [], successes: []}),
    } as any)
    stub(cmd, 'log')
    return cmd
  }

  it('passes raw PHP through to runTinker without requiring escaping', async () => {
    const cmd = makeCmd(['User::count()'])
    await cmd.run()

    // (config, php, profile, overrides, all)
    const {args} = runTinkerStub.firstCall
    expect(args[1]).to.equal('User::count()') // php
    expect(args[2]).to.be.undefined // profile
    expect(args[3]).to.deep.equal({component: undefined, container: undefined, namespace: undefined, role: undefined})
    expect(args[4]).to.be.false // all
    expect(closeConnectionsStub.calledOnce).to.be.true
  })

  it('accepts PHP containing $ variables and quotes with no escaping rules', async () => {
    const php = '$user = User::find(1); echo $user->email;'
    const cmd = makeCmd([php])
    await cmd.run()

    expect(runTinkerStub.firstCall.args[1]).to.equal(php)
  })

  it('forwards --all and -p', async () => {
    const cmd = makeCmd(['User::count()', '--all', '-p', 'prod'])
    await cmd.run()

    expect(runTinkerStub.firstCall.args[2]).to.equal('prod')
    expect(runTinkerStub.firstCall.args[4]).to.be.true
  })

  it('errors when the runner fails', async () => {
    runTinkerStub.resolves({error: 'ERROR: class not found', success: false})
    const cmd = makeCmd(['Foo::bar()'])
    try {
      await cmd.run()
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/class not found/)
    }

    expect(closeConnectionsStub.calledOnce).to.be.true
  })
})
