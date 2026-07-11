/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai'
import esmock from 'esmock'
import {type SinonStub, stub} from 'sinon'

describe('ssh:artisan:block', () => {
  let SshArtisanBlock: any
  let getProfileBlacklistStub: SinonStub
  let setProfileBlacklistStub: SinonStub

  beforeEach(async () => {
    getProfileBlacklistStub = stub().resolves({blacklist: ['migrate', 'migrate:fresh'], profileName: 'prod'})
    setProfileBlacklistStub = stub().resolves()

    const imported = await esmock('../../../../src/commands/ssh/artisan/block.js', {
      '../../../../src/k8s/index.js': {
        getProfileBlacklist: getProfileBlacklistStub,
        setProfileBlacklist: setProfileBlacklistStub,
      },
    })
    SshArtisanBlock = imported.default
  })

  function makeCmd(argv: string[]) {
    const cmd = new SshArtisanBlock(argv, {
      root: process.cwd(),
      runHook: stub().resolves({failures: [], successes: []}),
    } as any)
    stub(cmd, 'log')
    return cmd
  }

  it('views the current blacklist without mutating flags', async () => {
    const cmd = makeCmd(['-p', 'prod'])
    const result = await cmd.run()

    expect(getProfileBlacklistStub.firstCall.args[1]).to.equal('prod')
    expect(setProfileBlacklistStub.called).to.be.false
    expect(result.data.blacklistedArtisanCommands).to.deep.equal(['migrate', 'migrate:fresh'])
    expect(result.data.profile).to.equal('prod')
  })

  it('adds new entries without duplicating existing ones', async () => {
    const cmd = makeCmd(['-p', 'prod', '--add', 'migrate', '--add', 'db:wipe'])
    const result = await cmd.run()

    expect(setProfileBlacklistStub.firstCall.args[1]).to.equal('prod')
    expect(setProfileBlacklistStub.firstCall.args[2]).to.deep.equal(['migrate', 'migrate:fresh', 'db:wipe'])
    expect(result.data.blacklistedArtisanCommands).to.deep.equal(['migrate', 'migrate:fresh', 'db:wipe'])
  })

  it('removes entries case-insensitively', async () => {
    const cmd = makeCmd(['-p', 'prod', '--remove', 'MIGRATE:FRESH'])
    const result = await cmd.run()

    expect(result.data.blacklistedArtisanCommands).to.deep.equal(['migrate'])
  })

  it('clears the entire blacklist', async () => {
    const cmd = makeCmd(['-p', 'prod', '--clear'])
    const result = await cmd.run()

    expect(setProfileBlacklistStub.firstCall.args[1]).to.equal('prod')
    expect(setProfileBlacklistStub.firstCall.args[2]).to.deep.equal([])
    expect(result.data.blacklistedArtisanCommands).to.deep.equal([])
  })

  it('applies --clear before --add so a clear+add replaces the list', async () => {
    const cmd = makeCmd(['-p', 'prod', '--clear', '--add', 'migrate'])
    const result = await cmd.run()

    expect(result.data.blacklistedArtisanCommands).to.deep.equal(['migrate'])
  })
})
