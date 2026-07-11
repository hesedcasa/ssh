# ssh

CLI for SSH access to Kubernetes pods

[![Version](https://img.shields.io/npm/v/@hesed/ssh.svg)](https://npmjs.org/package/@hesed/ssh)
[![Downloads/week](https://img.shields.io/npm/dw/@hesed/ssh.svg)](https://npmjs.org/package/@hesed/ssh)

# Install

```bash
sdkck plugins install @hesed/ssh
```

<!-- toc -->
* [ssh](#ssh)
* [Install](#install)
* [SSH to Kubernetes pods](#ssh-to-kubernetes-pods)
* [1. Add a server profile (interactive, or pass the flags below)](#1-add-a-server-profile-interactive-or-pass-the-flags-below)
* [With a bastion (two-hop chain):](#with-a-bastion-two-hop-chain)
* [Without a bastion (direct to kubectl host):](#without-a-bastion-direct-to-kubectl-host)
* [2. Run a bash command in the first running pod](#2-run-a-bash-command-in-the-first-running-pod)
* [3. Fan out across ALL pods (labelled output — useful for log scanning)](#3-fan-out-across-all-pods-labelled-output--useful-for-log-scanning)
* [4. Laravel artisan](#4-laravel-artisan)
* [Artisan subcommand flags need `--` to separate them from oclif flags:](#artisan-subcommand-flags-need----to-separate-them-from-oclif-flags)
* [5. PHP tinker (no escaping needed — pass raw PHP)](#5-php-tinker-no-escaping-needed--pass-raw-php)
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->

# SSH to Kubernetes pods

This plugin reaches application pods via an SSH chain. By default it uses a
bastion jump host (local → bastion → kubectl host → `kubectl exec`), but the
bastion is optional — omit it to SSH directly to the kubectl host. Every
connection detail (bastion host, kubectl host, namespace, pod labels, container,
SSH user) lives in a **server profile** stored in `ssh-servers.json` under
oclif's config dir.

```bash
# 1. Add a server profile (interactive, or pass the flags below)
# With a bastion (two-hop chain):
ssh ssh servers add -p prod --bastionHost sglogin.example.com \
  --sshHost k8s.example.com -u allen -n sa-prod

# Without a bastion (direct to kubectl host):
ssh ssh servers add -p dev --sshHost k8s-dev.example.com -u allen -n sa-dev

# 2. Run a bash command in the first running pod
ssh ssh exec pwd -p prod

# 3. Fan out across ALL pods (labelled output — useful for log scanning)
ssh ssh exec --all "tail -20 storage/logs/laravel-$(date +%Y-%m-%d).log" -p prod

# 4. Laravel artisan
ssh ssh artisan cache:clear -p prod
# Artisan subcommand flags need `--` to separate them from oclif flags:
ssh ssh artisan -- queue:work --timeout=60

# 5. PHP tinker (no escaping needed — pass raw PHP)
ssh ssh tinker "App\\Models\\User::count()" -p prod
```

> **Migration safety:** `ssh artisan` blocks nothing by default — each
> profile has its own opt-in artisan blacklist (empty until you configure
> it). Migrations are destructive, so lock them down per profile:
>
> ```bash
> ssh ssh artisan block -p prod --add migrate --add migrate:fresh \
>   --add "migrate:fresh --seed" --add migrate:rollback --add migrate:reset \
>   --add migrate:refresh --add migrate:install --add migrate:status \
>   --add migrate:change
> ssh ssh artisan block -p prod  # view the current blacklist
> ```

> **Exec allowlist:** `ssh exec` runs any command by default. To restrict a
> profile to a set of command prefixes, use `ssh exec allow`:
>
> ```bash
> ssh ssh exec allow -p prod --add tail --add grep --add "php artisan cache:clear"
> ssh ssh exec allow -p prod  # view the current allowlist
> ```
>
> An empty (or unset) allowlist disables the guard — every command may run.

# Usage

<!-- usage -->
```sh-session
$ npm install -g @hesed/ssh
$ ssh COMMAND
running command...
$ ssh (--version)
@hesed/ssh/0.5.0 linux-x64 node-v22.23.1
$ ssh --help [COMMAND]
USAGE
  $ ssh COMMAND
...
```
<!-- usagestop -->

# Commands

<!-- commands -->
* [`ssh ssh artisan COMMAND`](#ssh-ssh-artisan-command)
* [`ssh ssh artisan block`](#ssh-ssh-artisan-block)
* [`ssh ssh exec COMMAND`](#ssh-ssh-exec-command)
* [`ssh ssh exec allow`](#ssh-ssh-exec-allow)
* [`ssh ssh servers add`](#ssh-ssh-servers-add)
* [`ssh ssh servers delete`](#ssh-ssh-servers-delete)
* [`ssh ssh servers discover`](#ssh-ssh-servers-discover)
* [`ssh ssh servers list`](#ssh-ssh-servers-list)
* [`ssh ssh servers profile`](#ssh-ssh-servers-profile)
* [`ssh ssh servers test`](#ssh-ssh-servers-test)
* [`ssh ssh servers update`](#ssh-ssh-servers-update)
* [`ssh ssh tinker PHP`](#ssh-ssh-tinker-php)

## `ssh ssh artisan COMMAND`

Run a Laravel artisan command

```
USAGE
  $ ssh ssh artisan COMMAND [--json] [--all] [--component <value>] [--container <value>] [--namespace <value>]
    [-p <value>] [--role <value>]

ARGUMENTS
  COMMAND  Artisan command to run (e.g. cache:clear, route:list, queue:restart)

FLAGS
  -p, --profile=<value>    SSH server profile name from config
      --all                Run on ALL running pods; output is labelled per pod
      --component=<value>  Override pod component label (default: from profile)
      --container=<value>  Override container name (default: from profile)
      --namespace=<value>  Override Kubernetes namespace (default: from profile)
      --role=<value>       Override pod role label (default: from profile)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Run a Laravel artisan command

EXAMPLES
  $ ssh ssh artisan cache:clear

  $ ssh ssh artisan route:list -p prod

  $ ssh ssh artisan queue:restart --namespace sa-testqa
```

_See code: [src/commands/ssh/artisan/index.ts](https://github.com/hesedcasa/ssh/blob/v0.5.0/src/commands/ssh/artisan/index.ts)_

## `ssh ssh artisan block`

View or edit a server profile's artisan blacklist

```
USAGE
  $ ssh ssh artisan block [--json] [--add <value>...] [--clear] [-p <value>] [--remove <value>...]

FLAGS
  -p, --profile=<value>    SSH server profile name from config
      --add=<value>...     Add a command prefix to the blacklist (repeatable)
      --clear              Remove every entry from the profile's blacklist
      --remove=<value>...  Remove a command prefix from the blacklist (repeatable)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  View or edit a server profile's artisan blacklist

EXAMPLES
  $ ssh ssh artisan block

  $ ssh ssh artisan block -p prod

  $ ssh ssh artisan block -p prod --add migrate --add migrate:fresh

  $ ssh ssh artisan block -p prod --remove migrate:fresh

  $ ssh ssh artisan block -p prod --clear
```

_See code: [src/commands/ssh/artisan/block.ts](https://github.com/hesedcasa/ssh/blob/v0.5.0/src/commands/ssh/artisan/block.ts)_

## `ssh ssh exec COMMAND`

Execute a bash command

```
USAGE
  $ ssh ssh exec COMMAND [--json] [--all] [--component <value>] [--container <value>] [--namespace <value>]
    [-p <value>] [--role <value>]

ARGUMENTS
  COMMAND  Command to execute

FLAGS
  -p, --profile=<value>    SSH server profile name from config
      --all                Run on ALL running pods; output is labelled per pod
      --component=<value>  Override pod component label (default: from profile)
      --container=<value>  Override container name (default: from profile)
      --namespace=<value>  Override Kubernetes namespace (default: from profile)
      --role=<value>       Override pod role label (default: from profile)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Execute a bash command

EXAMPLES
  $ ssh ssh exec pwd

  $ ssh ssh exec "tail -20 storage/logs/laravel-$(date +%Y-%m-%d).log" --all

  $ ssh ssh exec "grep ERROR storage/logs/laravel.log" --namespace sa-testqa
```

_See code: [src/commands/ssh/exec/index.ts](https://github.com/hesedcasa/ssh/blob/v0.5.0/src/commands/ssh/exec/index.ts)_

## `ssh ssh exec allow`

View or edit a server profile's exec allowlist

```
USAGE
  $ ssh ssh exec allow [--json] [--add <value>...] [--clear] [-p <value>] [--remove <value>...]

FLAGS
  -p, --profile=<value>    SSH server profile name from config
      --add=<value>...     Add a command prefix to the allowlist (repeatable)
      --clear              Remove every entry from the profile's allowlist
      --remove=<value>...  Remove a command prefix from the allowlist (repeatable)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  View or edit a server profile's exec allowlist

EXAMPLES
  $ ssh ssh exec allow

  $ ssh ssh exec allow -p prod

  $ ssh ssh exec allow -p prod --add tail --add grep

  $ ssh ssh exec allow -p prod --remove grep

  $ ssh ssh exec allow -p prod --clear
```

_See code: [src/commands/ssh/exec/allow.ts](https://github.com/hesedcasa/ssh/blob/v0.5.0/src/commands/ssh/exec/allow.ts)_

## `ssh ssh servers add`

Add SSH Server authentication

```
USAGE
  $ ssh ssh servers add -p <value> --bastionHost <value> --sshHost <value> -u <value> -n <value> --component <value>
    --role <value> --container <value> [--json]

FLAGS
  -n, --namespace=<value>    (required) Kubernetes namespace
  -p, --profile=<value>      (required) Profile name
  -u, --sshUser=<value>      (required) SSH username for both hops
      --bastionHost=<value>  (required) Bastion host
      --component=<value>    (required) Pod component label
      --container=<value>    (required) Container name within the pod
      --role=<value>         (required) Pod role label
      --sshHost=<value>      (required) Kubernetes host

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Add SSH Server authentication

EXAMPLES
  $ ssh ssh servers add

  $ ssh ssh servers add -p prod
```

_See code: [src/commands/ssh/servers/add.ts](https://github.com/hesedcasa/ssh/blob/v0.5.0/src/commands/ssh/servers/add.ts)_

## `ssh ssh servers delete`

Delete an authentication profile

```
USAGE
  $ ssh ssh servers delete [--json] [-p <value>]

FLAGS
  -p, --profile=<value>  Profile to delete

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Delete an authentication profile

EXAMPLES
  $ ssh ssh servers delete

  $ ssh ssh servers delete -p prod
```

_See code: [src/commands/ssh/servers/delete.ts](https://github.com/hesedcasa/ssh/blob/v0.5.0/src/commands/ssh/servers/delete.ts)_

## `ssh ssh servers discover`

Discover the component/role label values on a namespace's running pods (valid --component/--role targets)

```
USAGE
  $ ssh ssh servers discover [--json] [--namespace <value>] [-p <value>]

FLAGS
  -p, --profile=<value>    SSH server profile name from config
      --namespace=<value>  Override Kubernetes namespace (default: from profile)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Discover the component/role label values on a namespace's running pods (valid --component/--role targets)

EXAMPLES
  $ ssh ssh servers discover

  $ ssh ssh servers discover -p prod

  $ ssh ssh servers discover --namespace sa-testqa
```

_See code: [src/commands/ssh/servers/discover.ts](https://github.com/hesedcasa/ssh/blob/v0.5.0/src/commands/ssh/servers/discover.ts)_

## `ssh ssh servers list`

List authentication profiles

```
USAGE
  $ ssh ssh servers list [--json]

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List authentication profiles

EXAMPLES
  $ ssh ssh servers list
```

_See code: [src/commands/ssh/servers/list.ts](https://github.com/hesedcasa/ssh/blob/v0.5.0/src/commands/ssh/servers/list.ts)_

## `ssh ssh servers profile`

Set or show the default authentication profile

```
USAGE
  $ ssh ssh servers profile [--json] [--default <value>]

FLAGS
  --default=<value>  Profile to set as default

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Set or show the default authentication profile

EXAMPLES
  $ ssh ssh servers profile

  $ ssh ssh servers profile --default test
```

_See code: [src/commands/ssh/servers/profile.ts](https://github.com/hesedcasa/ssh/blob/v0.5.0/src/commands/ssh/servers/profile.ts)_

## `ssh ssh servers test`

Test authentication and connection

```
USAGE
  $ ssh ssh servers test [--json] [-p <value>]

FLAGS
  -p, --profile=<value>  Authentication profile name

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Test authentication and connection

EXAMPLES
  $ ssh ssh servers test

  $ ssh ssh servers test -p prod
```

_See code: [src/commands/ssh/servers/test.ts](https://github.com/hesedcasa/ssh/blob/v0.5.0/src/commands/ssh/servers/test.ts)_

## `ssh ssh servers update`

Update SSH Server authentication

```
USAGE
  $ ssh ssh servers update -p <value> --bastionHost <value> --sshHost <value> -u <value> -n <value> --component <value>
    --role <value> --container <value> [--json]

FLAGS
  -n, --namespace=<value>    (required) Kubernetes namespace
  -p, --profile=<value>      (required) Profile name
  -u, --sshUser=<value>      (required) SSH username for both hops
      --bastionHost=<value>  (required) Bastion host
      --component=<value>    (required) Pod component label
      --container=<value>    (required) Container name within the pod
      --role=<value>         (required) Pod role label
      --sshHost=<value>      (required) Kubernetes host

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Update SSH Server authentication

EXAMPLES
  $ ssh ssh servers update

  $ ssh ssh servers update -p test
```

_See code: [src/commands/ssh/servers/update.ts](https://github.com/hesedcasa/ssh/blob/v0.5.0/src/commands/ssh/servers/update.ts)_

## `ssh ssh tinker PHP`

Execute PHP code in Laravel tinker

```
USAGE
  $ ssh ssh tinker PHP [--json] [--all] [--component <value>] [--container <value>] [--namespace <value>] [-p
    <value>] [--role <value>]

ARGUMENTS
  PHP  PHP code to execute via tinker

FLAGS
  -p, --profile=<value>    SSH server profile name from config
      --all                Run on ALL running pods; output is labelled per pod
      --component=<value>  Override pod component label (default: from profile)
      --container=<value>  Override container name (default: from profile)
      --namespace=<value>  Override Kubernetes namespace (default: from profile)
      --role=<value>       Override pod role label (default: from profile)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Execute PHP code in Laravel tinker

EXAMPLES
  $ ssh ssh tinker "App\\Models\\User::count()"

  $ ssh ssh tinker "echo User::first()->email;" -p prod

  $ ssh ssh tinker "Cache::forget('some_key')"
```

_See code: [src/commands/ssh/tinker.ts](https://github.com/hesedcasa/ssh/blob/v0.5.0/src/commands/ssh/tinker.ts)_
<!-- commandsstop -->
