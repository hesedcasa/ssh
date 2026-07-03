/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai'
import esmock from 'esmock'
import {type SinonStub, stub} from 'sinon'

describe('ssh:artisan', () => {
  let SshArtisan: any
  let runArtisanStub: SinonStub
  let closeConnectionsStub: SinonStub
  let getArtisanBlacklistStub: SinonStub
  let checkArtisanBlacklistStub: SinonStub

  const mockResult = {
    data: {result: 'Cache cleared successfully.\n'},
    success: true,
  }

  beforeEach(async () => {
    runArtisanStub = stub().resolves(mockResult)
    closeConnectionsStub = stub().resolves()
    // Default: allow everything; individual tests override the impl.
    getArtisanBlacklistStub = stub().resolves(['migrate', 'migrate:fresh --seed'])
    // The real checkArtisanBlacklist is used by default so the allow/block
    // logic is exercised through the command path too.
    const {checkArtisanBlacklist} = await import('../../../src/k8s/safety.js')
    checkArtisanBlacklistStub = stub().callsFake(checkArtisanBlacklist)

    const imported = await esmock('../../../src/commands/ssh/artisan.js', {
      '../../../src/k8s/index.js': {
        checkArtisanBlacklist: checkArtisanBlacklistStub,
        closeConnections: closeConnectionsStub,
        getArtisanBlacklist: getArtisanBlacklistStub,
        runArtisan: runArtisanStub,
      },
    })
    SshArtisan = imported.default
  })

  function makeCmd(argv: string[]) {
    const cmd = new SshArtisan(argv, {
      root: process.cwd(),
      runHook: stub().resolves({failures: [], successes: []}),
    } as any)
    stub(cmd, 'log')
    return cmd
  }

  it('runs a safe artisan command and logs the result', async () => {
    const cmd = makeCmd(['cache:clear'])
    await cmd.run()

    expect(getArtisanBlacklistStub.calledOnce).to.be.true
    expect(checkArtisanBlacklistStub.calledOnce).to.be.true
    // (config, subcommand, profile, overrides, all)
    const {args} = runArtisanStub.firstCall
    expect(args[1]).to.equal('cache:clear') // subcommand
    expect(args[2]).to.be.undefined // profile
    expect(args[3]).to.deep.equal({component: undefined, container: undefined, namespace: undefined, role: undefined})
    expect(args[4]).to.be.false // all
    expect(closeConnectionsStub.calledOnce).to.be.true
  })

  it('passes --all and -p through to runArtisan', async () => {
    const cmd = makeCmd(['route:list', '--all', '-p', 'prod'])
    await cmd.run()

    expect(runArtisanStub.firstCall.args[2]).to.equal('prod') // profile
    expect(runArtisanStub.firstCall.args[4]).to.be.true // all
  })

  it('blocks migrate before reaching the runner', async () => {
    const cmd = makeCmd(['migrate'])
    try {
      await cmd.run()
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/blacklisted|migrat/i)
    }

    expect(runArtisanStub.called).to.be.false
  })

  it('blocks migrate:fresh', async () => {
    // `migrate:fresh --seed` cannot be passed positionally because oclif parses
    // `--seed` as its own flag; use `--` for that. The bare subcommand still
    // exercises the multi-token blacklist entry (migrate:fresh --seed) via the
    // `migrate:`-prefix match.
    const cmd = makeCmd(['migrate:fresh'])
    try {
      await cmd.run()
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/blacklisted|migrat/i)
    }

    expect(runArtisanStub.called).to.be.false
  })

  it('errors when the runner reports failure', async () => {
    runArtisanStub.resolves({error: 'ERROR: pod not found', success: false})
    const cmd = makeCmd(['cache:clear'])
    try {
      await cmd.run()
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/pod not found/)
    }

    expect(closeConnectionsStub.calledOnce).to.be.true
  })
})
