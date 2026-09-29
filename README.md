# OMP Claude Code Adapter

An OMP custom model provider that runs the locally installed Claude Code CLI. It uses Claude Code's existing sign-in and exposes Claude's `opus`, `sonnet`, and `haiku` aliases, with OMP thinking levels forwarded as Claude Code effort settings.

## Requirements

- OMP 18.4.3
- Claude Code CLI installed and signed in on the same device
- Access to this GitHub repository (it is private)

## Install

Install the pinned release from OMP:

```sh
omp install github:Farrely-F/omp-claude-code-adapter#v1.0.0
```

Start a new OMP session after installation. Confirm discovery with:

```sh
omp models claude-code-cli
```

The model IDs are `claude-code-cli/opus`, `claude-code-cli/sonnet`, and `claude-code-cli/haiku`. In the TUI, select a model with `/model`, then choose an OMP thinking level. CLI example:

```sh
omp --model claude-code-cli/sonnet --thinking high
```

Supported effort levels: `low`, `medium`, `high`, `xhigh`, and `max`; the default is `medium`. Claude Code and the signed-in account determine which models and effort levels are actually available.

## Security and behavior

- The adapter starts `claude -p` in OMP's current working directory and forwards the OMP system prompt and conversation.
- Claude Code handles its own tools and permissions. OMP's tool approval settings do not control actions taken by the nested CLI. The adapter does not set a permissive Claude Code permission mode; headless actions that require a prompt may be denied unless configured in Claude Code itself.
- The adapter removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_OAUTH_TOKEN` from the child environment so Claude Code uses its own local authentication.
- OMP context is text-only. Image context is rejected.
- Set `CLAUDE_CODE_CLI` if the executable is not available as `claude` on `PATH`.

## Local development

```sh
bun install --frozen-lockfile
bun test
omp --extension . --model claude-code-cli/haiku --thinking low
```

The last command loads the extension directly from this checkout for a one-off session.
