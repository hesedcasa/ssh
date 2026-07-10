import {expect} from 'chai'

import {
  checkArtisanBlacklist,
  checkArtisanDeletionPermission,
  checkShellDeletionPermission,
  checkTinkerDeletionPermission,
} from '../../src/k8s/safety.js'

describe('k8s:safety', () => {
  // Representative blacklist a profile might configure via `ssh servers
  // safety --add`; checkArtisanBlacklist itself has no built-in defaults.
  const blacklist = [
    'migrate',
    'migrate:rollback',
    'migrate:fresh',
    'migrate:fresh --seed',
    'migrate:status',
    'migrate:install',
    'migrate:reset',
    'migrate:refresh',
    'migrate:change',
  ]

  describe('checkArtisanBlacklist', () => {
    it('blocks bare migrate', () => {
      const result = checkArtisanBlacklist('migrate', blacklist)
      expect(result.allowed).to.be.false
      expect(result.blockedCommand).to.equal('migrate')
    })

    it('blocks migrate:status', () => {
      const result = checkArtisanBlacklist('migrate:status', blacklist)
      expect(result.allowed).to.be.false
    })

    it('blocks migrate:fresh --seed (matched via the migrate prefix entry)', () => {
      // `migrate:fresh --seed` starts with `migrate:`, so it matches the bare
      // `migrate` blacklist entry (listed first) rather than the multi-token
      // `migrate:fresh --seed` entry. Either way it is blocked.
      const result = checkArtisanBlacklist('migrate:fresh --seed', blacklist)
      expect(result.allowed).to.be.false
      expect(result.blockedCommand).to.equal('migrate')
    })

    it('reports the exact multi-token entry when it is the only match', () => {
      const result = checkArtisanBlacklist('migrate:fresh --seed', ['migrate:fresh --seed'])
      expect(result.allowed).to.be.false
      expect(result.blockedCommand).to.equal('migrate:fresh --seed')
    })

    it('blocks migrate variants regardless of case', () => {
      expect(checkArtisanBlacklist('MIGRATE', blacklist).allowed).to.be.false
      expect(checkArtisanBlacklist('Migrate:Rollback', blacklist).allowed).to.be.false
    })

    it('blocks migrate with leading/trailing whitespace', () => {
      expect(checkArtisanBlacklist('  migrate  ', blacklist).allowed).to.be.false
    })

    it('allows safe commands', () => {
      expect(checkArtisanBlacklist('cache:clear', blacklist).allowed).to.be.true
      expect(checkArtisanBlacklist('route:list', blacklist).allowed).to.be.true
      expect(checkArtisanBlacklist('queue:restart', blacklist).allowed).to.be.true
      expect(checkArtisanBlacklist('tinker', blacklist).allowed).to.be.true
    })

    it('does not false-positive on commands that merely contain the substring', () => {
      // "migrate" as a substring inside another token must not match.
      expect(checkArtisanBlacklist('migratelog:show', blacklist).allowed).to.be.true
      expect(checkArtisanBlacklist('db:show-migrations', blacklist).allowed).to.be.true
    })

    it('returns an empty allowed result (no blockedCommand) for safe commands', () => {
      const result = checkArtisanBlacklist('cache:clear', blacklist)
      expect(result.allowed).to.be.true
      expect(result.blockedCommand).to.be.undefined
      expect(result.reason).to.be.undefined
    })

    it('respects a custom blacklist', () => {
      expect(checkArtisanBlacklist('cache:clear', ['cache:clear']).allowed).to.be.false
      expect(checkArtisanBlacklist('migrate', []).allowed).to.be.true
    })
  })

  describe('checkShellDeletionPermission (built-in deletion guard)', () => {
    it('blocks plain rm', () => {
      const result = checkShellDeletionPermission('rm storage/logs/laravel.log')
      expect(result.allowed).to.be.false
      expect(result.matchedPattern).to.equal('rm')
      expect(result.reason).to.match(/deletion guard/i)
    })

    it('blocks rm -rf, rmdir, unlink, and shred', () => {
      expect(checkShellDeletionPermission('rm -rf storage').allowed).to.be.false
      expect(checkShellDeletionPermission('rmdir storage/tmp').allowed).to.be.false
      expect(checkShellDeletionPermission('unlink foo.txt').allowed).to.be.false
      expect(checkShellDeletionPermission('shred -u secrets.env').allowed).to.be.false
    })

    it('blocks deletion hidden behind another command or subshell', () => {
      expect(checkShellDeletionPermission('ls && rm -rf storage').allowed).to.be.false
      expect(checkShellDeletionPermission('echo hi; rm foo').allowed).to.be.false
      expect(checkShellDeletionPermission('cat $(rm foo)').allowed).to.be.false
      expect(checkShellDeletionPermission('echo `rm foo`').allowed).to.be.false
      expect(checkShellDeletionPermission('true | rm foo').allowed).to.be.false
    })

    it('blocks deletion behind wrappers and path prefixes', () => {
      expect(checkShellDeletionPermission('sudo rm -rf /var/www').allowed).to.be.false
      expect(checkShellDeletionPermission('find . -name "*.log" | xargs rm').allowed).to.be.false
      expect(checkShellDeletionPermission('env FOO=1 rm foo').allowed).to.be.false
      expect(checkShellDeletionPermission('/bin/rm foo').allowed).to.be.false
    })

    it('blocks deletion hidden behind wrapper operands', () => {
      expect(checkShellDeletionPermission('sudo -u postgres rm -rf storage').allowed).to.be.false
      expect(checkShellDeletionPermission('nice -n 10 rm -rf storage').allowed).to.be.false
      expect(checkShellDeletionPermission('timeout 30 rm foo').allowed).to.be.false
      expect(checkShellDeletionPermission("sudo -u postgres psql -c 'DROP EXTENSION x'").allowed).to.be.false
      // ...but a wrapper running a safe command stays allowed.
      expect(checkShellDeletionPermission('sudo -u www-data php artisan cache:clear').allowed).to.be.true
      expect(checkShellDeletionPermission('timeout 30 tail -f storage/logs/laravel.log').allowed).to.be.true
    })

    it('blocks deletion behind nested shell interpreters', () => {
      expect(checkShellDeletionPermission("bash -c 'rm -rf storage'").allowed).to.be.false
      expect(checkShellDeletionPermission('sh -c "rm foo"').allowed).to.be.false
      expect(checkShellDeletionPermission("sudo bash -c 'rm -rf /var/www'").allowed).to.be.false
    })

    it('blocks deletion binaries obfuscated with quote fragments or backslashes', () => {
      expect(checkShellDeletionPermission("rm'' -rf storage").allowed).to.be.false
      expect(checkShellDeletionPermission("r''m -rf storage").allowed).to.be.false
      expect(checkShellDeletionPermission('r"m" -rf storage').allowed).to.be.false
      expect(checkShellDeletionPermission(String.raw`\rm -rf storage`).allowed).to.be.false
      expect(checkShellDeletionPermission(String.raw`r\m -rf storage`).allowed).to.be.false
    })

    it('blocks deletion dispatched through a BusyBox/Toybox applet', () => {
      expect(checkShellDeletionPermission('busybox rm -rf storage').allowed).to.be.false
      expect(checkShellDeletionPermission('sudo busybox rm -rf /var/www').allowed).to.be.false
      expect(checkShellDeletionPermission('toybox rm foo').allowed).to.be.false
      // A BusyBox applet that isn't a deletion command stays allowed.
      expect(checkShellDeletionPermission('busybox ls -la').allowed).to.be.true
    })

    it('blocks deletion behind the eval builtin', () => {
      expect(checkShellDeletionPermission("bash -c 'eval rm -rf storage'").allowed).to.be.false
      expect(checkShellDeletionPermission('eval rm -rf storage').allowed).to.be.false
      expect(checkShellDeletionPermission('eval "rm foo"').allowed).to.be.false
      expect(checkShellDeletionPermission('eval sudo rm foo').allowed).to.be.false
    })

    it('blocks deletion inside loops, brace groups, and subshells', () => {
      expect(checkShellDeletionPermission('for f in storage/*.log; do rm "$f"; done').allowed).to.be.false
      expect(checkShellDeletionPermission('while true; do rm foo; done').allowed).to.be.false
      expect(checkShellDeletionPermission('if true; then rm foo; fi').allowed).to.be.false
      expect(checkShellDeletionPermission('{ rm -rf storage; }').allowed).to.be.false
      expect(checkShellDeletionPermission('( rm -rf storage )').allowed).to.be.false
    })

    it('blocks find -delete and find -exec rm', () => {
      expect(checkShellDeletionPermission('find storage -name "*.tmp" -delete').allowed).to.be.false
      expect(checkShellDeletionPermission(String.raw`find . -name "*.log" -exec rm {} \;`).allowed).to.be.false
    })

    it('blocks find -exec running a nested shell or wrapper', () => {
      expect(checkShellDeletionPermission(String.raw`find . -exec sh -c 'rm -rf storage' \;`).allowed).to.be.false
      expect(checkShellDeletionPermission(String.raw`find . -execdir bash -c "rm {}" \;`).allowed).to.be.false
      expect(checkShellDeletionPermission(String.raw`find . -ok sudo rm {} \;`).allowed).to.be.false
      // Benign -exec commands stay allowed.
      expect(checkShellDeletionPermission(String.raw`find . -name "*.log" -exec grep ERROR {} \;`).allowed).to.be.true
    })

    it('blocks database drops in any casing', () => {
      expect(checkShellDeletionPermission('mysql -e "DROP DATABASE app"').allowed).to.be.false
      expect(checkShellDeletionPermission("psql -c 'drop schema public cascade'").allowed).to.be.false
      expect(checkShellDeletionPermission('mysql -e "Drop Table users"').allowed).to.be.false
      expect(checkShellDeletionPermission('mysqladmin drop app').allowed).to.be.false
    })

    it('blocks drops of other database objects (view, index, function, …)', () => {
      expect(checkShellDeletionPermission("psql -c 'DROP VIEW user_data'").allowed).to.be.false
      expect(checkShellDeletionPermission('mysql -e "drop index idx_users_email on users"').allowed).to.be.false
      expect(checkShellDeletionPermission("psql -c 'DROP FUNCTION compute_totals()'").allowed).to.be.false
      expect(checkShellDeletionPermission("psql -c 'DROP MATERIALIZED VIEW report_cache'").allowed).to.be.false
      expect(checkShellDeletionPermission('mysql -e "DROP TEMPORARY TABLE tmp_import"').allowed).to.be.false
      expect(checkShellDeletionPermission('mysql -e "DROP TABLE IF EXISTS users"').allowed).to.be.false
      expect(checkShellDeletionPermission("psql -c 'DROP TRIGGER audit_trigger ON users'").allowed).to.be.false
      expect(checkShellDeletionPermission("psql -c 'DROP EXTENSION pgcrypto'").allowed).to.be.false
      expect(checkShellDeletionPermission("psql -c 'DROP TYPE status_enum'").allowed).to.be.false
      expect(checkShellDeletionPermission("psql -c 'DROP FOREIGN TABLE remote_users'").allowed).to.be.false
      expect(checkShellDeletionPermission("psql -c 'DROP OWNED BY app_user'").allowed).to.be.false
    })

    it('blocks standalone database drop binaries', () => {
      expect(checkShellDeletionPermission('dropdb app_db').allowed).to.be.false
      expect(checkShellDeletionPermission('sudo -u postgres dropdb app_db').allowed).to.be.false
      expect(checkShellDeletionPermission('dropuser app_user').allowed).to.be.false
      // createdb and other neighbours stay allowed.
      expect(checkShellDeletionPermission('createdb app_db').allowed).to.be.true
    })

    it('blocks any DROP handed to a SQL client, even unrecognised object types', () => {
      expect(checkShellDeletionPermission("psql -c 'DROP FUTURE_OBJECT thing'").allowed).to.be.false
      expect(checkShellDeletionPermission('mysql -e "drop whatever"').allowed).to.be.false
      expect(checkShellDeletionPermission('sqlite3 app.db "DROP x"').allowed).to.be.false
      // …while non-DROP SQL through the same clients stays allowed.
      expect(checkShellDeletionPermission('psql -c "select count(*) from dropped_items"').allowed).to.be.true
    })

    it('blocks destructive artisan subcommands smuggled through exec', () => {
      expect(checkShellDeletionPermission('php artisan migrate:fresh').allowed).to.be.false
      expect(checkShellDeletionPermission('cd /var/www && php artisan db:wipe').allowed).to.be.false
    })

    it('blocks a destructive artisan command later in a compound command', () => {
      expect(checkShellDeletionPermission('php artisan cache:clear && php artisan db:wipe').allowed).to.be.false
      expect(checkShellDeletionPermission('php artisan route:list; php artisan migrate:fresh').allowed).to.be.false
      // A compound of only safe artisan commands stays allowed.
      expect(checkShellDeletionPermission('php artisan cache:clear && php artisan route:list').allowed).to.be.true
    })

    it('blocks tinker payloads smuggled through exec', () => {
      expect(checkShellDeletionPermission(`php artisan tinker --execute="Artisan::call('cache:clear')"`).allowed).to.be
        .false
      expect(checkShellDeletionPermission(`php artisan tinker --execute="unlink('/var/www/.env')"`).allowed).to.be
        .false
      expect(checkShellDeletionPermission('php artisan tinker --execute="Schema::dropAllTables()"').allowed).to.be
        .false
      // Non-destructive tinker payloads through exec stay allowed.
      expect(checkShellDeletionPermission('php artisan tinker --execute="User::count()"').allowed).to.be.true
    })

    it('blocks deletion after the |& pipe-stderr operator', () => {
      expect(checkShellDeletionPermission('ls |& rm -rf storage').allowed).to.be.false
    })

    it('blocks deletion hidden behind a shell variable', () => {
      expect(checkShellDeletionPermission('cmd=rm; $cmd -rf storage').allowed).to.be.false
      expect(checkShellDeletionPermission(`cmd=rm; $\{cmd} -rf storage`).allowed).to.be.false
      expect(checkShellDeletionPermission("cmd='rm'; $cmd -rf storage").allowed).to.be.false
      // Chained aliases collapse: a=rm; b=$a; $b -rf storage.
      expect(checkShellDeletionPermission('a=rm; b=$a; $b -rf storage').allowed).to.be.false
      // A variable holding a DB drop binary is caught too.
      expect(checkShellDeletionPermission('c=dropdb; $c app_db').allowed).to.be.false
      // A variable holding a harmless command stays allowed.
      expect(checkShellDeletionPermission('cmd=ls; $cmd -la').allowed).to.be.true
    })

    it('blocks command words built from command substitution or opaque variables', () => {
      expect(checkShellDeletionPermission('cmd=$(printf rm); $cmd -rf storage').allowed).to.be.false
      expect(checkShellDeletionPermission('cmd=`printf rm`; $cmd -rf storage').allowed).to.be.false
      expect(checkShellDeletionPermission('a=$(which rm); $a file').allowed).to.be.false
      // Opaque values used as ARGUMENTS (not the command word) stay allowed.
      expect(checkShellDeletionPermission('files=$(ls); cat $files').allowed).to.be.true
      expect(checkShellDeletionPermission('dir=$(pwd); cd $dir').allowed).to.be.true
    })

    it('blocks a direct command substitution used as the command word', () => {
      expect(checkShellDeletionPermission('$(printf rm) -rf storage').allowed).to.be.false
      expect(checkShellDeletionPermission('`printf rm` -rf storage').allowed).to.be.false
      expect(checkShellDeletionPermission('ls && $(printf rm) -rf storage').allowed).to.be.false
      expect(checkShellDeletionPermission('( $(evil) )').allowed).to.be.false
      // Command substitution as an ARGUMENT stays allowed.
      expect(checkShellDeletionPermission('grep $(cat patterns) file').allowed).to.be.true
      expect(checkShellDeletionPermission('echo $(date)').allowed).to.be.true
    })

    it('allows ordinary read/write commands', () => {
      expect(checkShellDeletionPermission('pwd').allowed).to.be.true
      expect(checkShellDeletionPermission('tail -20 storage/logs/laravel-$(date +%Y-%m-%d).log').allowed).to.be.true
      expect(checkShellDeletionPermission('grep ERROR storage/logs/laravel.log').allowed).to.be.true
      expect(checkShellDeletionPermission('php artisan cache:clear').allowed).to.be.true
      expect(checkShellDeletionPermission('mysql -e "select * from users limit 1"').allowed).to.be.true
    })

    it('does not false-positive on names that merely contain a blocked word', () => {
      expect(checkShellDeletionPermission('cat rm-notes.txt').allowed).to.be.true
      expect(checkShellDeletionPermission('ls format/').allowed).to.be.true
      expect(checkShellDeletionPermission('echo dropbox database').allowed).to.be.true
    })
  })

  describe('checkArtisanDeletionPermission (built-in deletion guard)', () => {
    it('blocks database-wiping artisan subcommands', () => {
      for (const cmd of ['db:wipe', 'migrate:fresh', 'migrate:refresh', 'migrate:reset', 'migrate:rollback']) {
        const result = checkArtisanDeletionPermission(cmd)
        expect(result.allowed, cmd).to.be.false
        expect(result.matchedPattern).to.equal(cmd)
      }
    })

    it('blocks destructive subcommands with extra arguments or casing', () => {
      expect(checkArtisanDeletionPermission('migrate:fresh --seed').allowed).to.be.false
      expect(checkArtisanDeletionPermission('DB:WIPE --force').allowed).to.be.false
    })

    it('blocks shell deletions smuggled into the artisan argument', () => {
      expect(checkArtisanDeletionPermission('cache:clear; rm -rf storage').allowed).to.be.false
      expect(checkArtisanDeletionPermission('cache:clear && sudo rm foo').allowed).to.be.false
    })

    it('runs the tinker PHP scan when the artisan subcommand is tinker', () => {
      expect(checkArtisanDeletionPermission(`tinker --execute="Artisan::call('db:wipe')"`).allowed).to.be.false
      expect(checkArtisanDeletionPermission('tinker --execute="Schema::dropAllTables()"').allowed).to.be.false
      expect(checkArtisanDeletionPermission(`tinker --execute="unlink('/var/www/.env')"`).allowed).to.be.false
      expect(checkArtisanDeletionPermission('tinker --execute="User::count()"').allowed).to.be.true
    })

    it('allows safe artisan subcommands (including plain migrate and migrate:status)', () => {
      expect(checkArtisanDeletionPermission('cache:clear').allowed).to.be.true
      expect(checkArtisanDeletionPermission('route:list').allowed).to.be.true
      expect(checkArtisanDeletionPermission('queue:restart').allowed).to.be.true
      // Plain migrate and migrate:status create/read — they delete nothing, so
      // the built-in guard leaves them to the per-profile blacklist.
      expect(checkArtisanDeletionPermission('migrate').allowed).to.be.true
      expect(checkArtisanDeletionPermission('migrate:status').allowed).to.be.true
      expect(checkArtisanDeletionPermission('db:seed').allowed).to.be.true
    })
  })

  describe('checkTinkerDeletionPermission (built-in deletion guard)', () => {
    it('blocks PHP file and directory deletion', () => {
      expect(checkTinkerDeletionPermission("unlink('/var/www/.env')").allowed).to.be.false
      expect(checkTinkerDeletionPermission("rmdir('/var/www/storage')").allowed).to.be.false
      expect(checkTinkerDeletionPermission("File::delete('foo.txt')").allowed).to.be.false
      expect(checkTinkerDeletionPermission("File::deleteDirectory('storage')").allowed).to.be.false
      expect(checkTinkerDeletionPermission("File::cleanDirectory('storage')").allowed).to.be.false
      expect(checkTinkerDeletionPermission("Storage::delete('foo.txt')").allowed).to.be.false
      expect(checkTinkerDeletionPermission("Storage::deleteDirectory('uploads')").allowed).to.be.false
      expect(checkTinkerDeletionPermission("Storage::disk('s3')->deleteDirectory('uploads')").allowed).to.be.false
    })

    it('blocks database drops from tinker', () => {
      expect(checkTinkerDeletionPermission('Schema::dropAllTables()').allowed).to.be.false
      expect(checkTinkerDeletionPermission("Schema::dropIfExists('users')").allowed).to.be.false
      expect(checkTinkerDeletionPermission('DB::statement("DROP DATABASE app")').allowed).to.be.false
    })

    it('blocks Artisan facade calls from tinker (guarded artisan access is `ssh artisan`)', () => {
      expect(checkTinkerDeletionPermission("Artisan::call('migrate:fresh')").allowed).to.be.false
      expect(checkTinkerDeletionPermission('Artisan::call("db:wipe")').allowed).to.be.false
      expect(checkTinkerDeletionPermission("Artisan::queue('migrate:fresh')").allowed).to.be.false
      // Categorical: even a non-destructive subcommand is refused, because the
      // string can be assembled at runtime and `ssh artisan` exists for this.
      expect(checkTinkerDeletionPermission("Artisan::call('cache:'.'clear')").allowed).to.be.false
      expect(checkTinkerDeletionPermission(String.raw`\Illuminate\Support\Facades\Artisan::call('db:wipe')`).allowed).to
        .be.false
    })

    it('blocks service-locator and console-kernel artisan access from tinker', () => {
      expect(checkTinkerDeletionPermission('app("artisan")->call("db:wipe")').allowed).to.be.false
      expect(checkTinkerDeletionPermission("resolve('artisan')->call('migrate:fresh')").allowed).to.be.false
      expect(checkTinkerDeletionPermission("App::make('artisan')->call('cache:clear')").allowed).to.be.false
      expect(
        checkTinkerDeletionPermission(String.raw`app(\Illuminate\Contracts\Console\Kernel::class)->call('up')`)
          .allowed,
      ).to.be.false
    })

    it('blocks chained schema/builder drops from tinker', () => {
      expect(checkTinkerDeletionPermission("Schema::connection('mysql')->dropAllTables()").allowed).to.be.false
      expect(
        checkTinkerDeletionPermission("DB::connection('mysql')->getSchemaBuilder()->dropAllTables()").allowed,
      ).to.be.false
    })

    it('blocks DB facade SQL containing DROP of any object type', () => {
      expect(
        checkTinkerDeletionPermission('DB::statement("DROP TEXT SEARCH CONFIGURATION english")').allowed,
      ).to.be.false
      // The drop keyword may precede the facade call (variable-passed SQL).
      expect(
        checkTinkerDeletionPermission('$sql = "drop text search dictionary d"; DB::unprepared($sql)').allowed,
      ).to.be.false
      // Ordinary DB facade use stays allowed, including drop-ish identifiers.
      expect(checkTinkerDeletionPermission("DB::table('users')->count()").allowed).to.be.true
      expect(checkTinkerDeletionPermission("DB::table('drop_logs')->count()").allowed).to.be.true
    })

    it('blocks aliased-facade drops and deletes from tinker', () => {
      expect(
        checkTinkerDeletionPermission(String.raw`use Illuminate\Support\Facades\Schema as S; S::dropAllTables()`)
          .allowed,
      ).to.be.false
      // The generic ::drop*() rule catches the aliased call even in isolation.
      expect(checkTinkerDeletionPermission('S::dropAllTables()').allowed).to.be.false
      // Aliasing any guarded facade is itself refused.
      expect(
        checkTinkerDeletionPermission(String.raw`use Illuminate\Support\Facades\File as F; F::exists('x')`).allowed,
      ).to.be.false
    })

    it('blocks destructive artisan subcommand strings from tinker regardless of invocation route', () => {
      expect(checkTinkerDeletionPermission('$kernel->call("db:wipe")').allowed).to.be.false
      expect(checkTinkerDeletionPermission("$runner('migrate:fresh')").allowed).to.be.false
    })

    it('blocks shell escapes from tinker', () => {
      expect(checkTinkerDeletionPermission("exec('rm -rf storage')").allowed).to.be.false
      expect(checkTinkerDeletionPermission("shell_exec('ls')").allowed).to.be.false
      expect(checkTinkerDeletionPermission("system('id')").allowed).to.be.false
      expect(checkTinkerDeletionPermission('`rm -rf storage`').allowed).to.be.false
    })

    it('allows ordinary PHP', () => {
      expect(checkTinkerDeletionPermission('User::count()').allowed).to.be.true
      expect(checkTinkerDeletionPermission('echo User::first()->email;').allowed).to.be.true
      expect(checkTinkerDeletionPermission("Cache::forget('some_key')").allowed).to.be.true
      expect(checkTinkerDeletionPermission('$user = User::find(1); echo $user->email;').allowed).to.be.true
    })
  })
})
