/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai'
import esmock from 'esmock'
import {type SinonStub, stub} from 'sinon'

describe('ssh:exec:allow', () => {
  let SshExecAllow: any
  let getProfileExecAllowlistStub: SinonStub
  let setProfileExecAllowlistStub: SinonStub

  beforeEach(async () => {
    getProfileExecAllowlistStub = stub().resolves({allowlist: ['tail', 'grep'], profileName: 'prod'})
    setProfileExecAllowlistStub = stub().resolves()

    const imported = await esmock('../../../../src/commands/ssh/exec/allow.js', {
      '../../../../src/k8s/index.js': {
        getProfileExecAllowlist: getProfileExecAllowlistStub,
        setProfileExecAllowlist: setProfileExecAllowlistStub,
      },
    })
    SshExecAllow = imported.default
  })

  function makeCmd(argv: string[]) {
    const cmd = new SshExecAllow(argv, {
      root: process.cwd(),
      runHook: stub().resolves({failures: [], successes: []}),
    } as any)
    stub(cmd, 'log')
    return cmd
  }

  it('views the current allowlist without mutating flags', async () => {
    const cmd = makeCmd(['-p', 'prod'])
    const result = await cmd.run()

    expect(getProfileExecAllowlistStub.firstCall.args[1]).to.equal('prod')
    expect(setProfileExecAllowlistStub.called).to.be.false
    expect(result.data.allowedExecCommands).to.deep.equal(['tail', 'grep'])
    expect(result.data.profile).to.equal('prod')
  })

  it('adds new entries without duplicating existing ones', async () => {
    const cmd = makeCmd(['-p', 'prod', '--add', 'tail', '--add', 'curl'])
    const result = await cmd.run()

    expect(setProfileExecAllowlistStub.firstCall.args[1]).to.equal('prod')
    expect(setProfileExecAllowlistStub.firstCall.args[2]).to.deep.equal(['tail', 'grep', 'curl'])
    expect(result.data.allowedExecCommands).to.deep.equal(['tail', 'grep', 'curl'])
  })

  it('removes entries case-insensitively', async () => {
    const cmd = makeCmd(['-p', 'prod', '--remove', 'GREP'])
    const result = await cmd.run()

    expect(result.data.allowedExecCommands).to.deep.equal(['tail'])
  })

  it('clears the entire allowlist', async () => {
    const cmd = makeCmd(['-p', 'prod', '--clear'])
    const result = await cmd.run()

    expect(setProfileExecAllowlistStub.firstCall.args[1]).to.equal('prod')
    expect(setProfileExecAllowlistStub.firstCall.args[2]).to.deep.equal([])
    expect(result.data.allowedExecCommands).to.deep.equal([])
  })

  it('applies --clear before --add so a clear+add replaces the list', async () => {
    const cmd = makeCmd(['-p', 'prod', '--clear', '--add', 'tail'])
    const result = await cmd.run()

    expect(result.data.allowedExecCommands).to.deep.equal(['tail'])
  })
})
