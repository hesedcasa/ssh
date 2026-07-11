/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai'
import esmock from 'esmock'
import {type SinonStub, stub} from 'sinon'

describe('ssh:servers:discover', () => {
  let SshServersDiscover: any
  let discoverPodLabelsStub: SinonStub
  let closeConnectionsStub: SinonStub

  const mockResult = {
    data: {
      combos: [
        {component: 'api', count: 2, role: 'app'},
        {component: 'api', count: 1, role: 'queue-worker'},
      ],
      components: ['api'],
      namespace: 'sa-test5',
      result: "Running pods in namespace 'sa-test5': ...",
      roles: ['app', 'queue-worker'],
    },
    success: true,
  }

  beforeEach(async () => {
    discoverPodLabelsStub = stub().resolves(structuredClone(mockResult))
    closeConnectionsStub = stub().resolves()

    const imported = await esmock('../../../../src/commands/ssh/servers/discover.js', {
      '../../../../src/k8s/index.js': {
        closeConnections: closeConnectionsStub,
        discoverPodLabels: discoverPodLabelsStub,
      },
    })
    SshServersDiscover = imported.default
  })

  function makeCmd(argv: string[]) {
    const cmd = new SshServersDiscover(argv, {
      root: process.cwd(),
      runHook: stub().resolves({failures: [], successes: []}),
    } as any)
    stub(cmd, 'log')
    return cmd
  }

  it('discovers labels for the default profile and logs the formatted result', async () => {
    const cmd = makeCmd([])
    const result = await cmd.run()

    expect(discoverPodLabelsStub.calledOnce).to.be.true
    // (config, profile, namespace)
    const {args} = discoverPodLabelsStub.firstCall
    expect(args[1]).to.be.undefined
    expect(args[2]).to.be.undefined
    expect((cmd.log as SinonStub).firstCall.args[0]).to.contain('sa-test5')
    // The human-readable string is stripped from the machine payload.
    expect(result.data.result).to.be.undefined
    expect(result.data.components).to.deep.equal(['api'])
  })

  it('passes profile and namespace overrides through', async () => {
    const cmd = makeCmd(['-p', 'prod', '--namespace', 'sa-testqa'])
    await cmd.run()

    const {args} = discoverPodLabelsStub.firstCall
    expect(args[1]).to.equal('prod')
    expect(args[2]).to.equal('sa-testqa')
  })

  it('always calls closeConnections', async () => {
    const cmd = makeCmd([])
    await cmd.run()
    expect(closeConnectionsStub.calledOnce).to.be.true
  })

  it('errors when discovery fails', async () => {
    discoverPodLabelsStub.resolves({error: 'ERROR: boom', success: false})
    const cmd = makeCmd([])
    try {
      await cmd.run()
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/boom/)
    }

    expect(closeConnectionsStub.calledOnce).to.be.true
  })
})
