# gt-cli

This package contains two tools:
1. `gt`: a cli tool meant to fully replace Graphite's `gt` cli, with the same interface.
2. `gt-cli`: a cli for configuring behavior of `gt`. 

## Install

To install the package, run:

```sh
npm login && npx -y @tianrendong/gt-cli@latest install
```

## Enable

To select our `gt` implementation as the global default, run:

```sh
gt-cli enable --global
```

Alternatively, select our implementation for a single repository:

```sh
gt-cli enable --repo PATH_TO_REPO
```

### Revert to using Graphite

```sh
gt-cli disable          # Current repository and its worktrees
gt-cli disable --global # All repositories
```

## Update

To install the latest release, run:

```sh
gt-cli update
```

## Publish to Graphite

Publishing to graphite.dev can be enabled to use their PR review UI. Note this will incur higher latency with `gt submit`.

1. To enable automatic publishing to graphite, run `gt-cli graphite enable`.
2. To disable, run `gt-cli graphite disable`.
3. To see whether graphite publishing is turned on, run `gt-cli graphite status`.
