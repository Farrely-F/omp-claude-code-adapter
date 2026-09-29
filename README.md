# OMP Claude Code Adapter

An OMP custom model provider that runs the locally authenticated Claude Code CLI. It pins the current Claude Opus 5.5, Sonnet 5.5, and Haiku 4.5 model IDs and exposes supported effort controls for Opus and Sonnet.

## Requirements

- OMP 18.4.3
- Claude Code CLI installed and signed in on the same device
- Access to this GitHub repository (it is private)

## Install

Install from a tagged checkout. This repository is private, so the device must have GitHub access configured first:

```sh
gh auth login
gh auth setup-git
gh repo clone Farrely-F/omp-claude-code-adapter
cd omp-claude-code-adapter
git checkout v1.0.1
bun install --frozen-lockfile
omp install .
```

Start a new OMP session after installation. Confirm discovery with:

```sh
omp models claude-code-cli
```

Select the explicitly versioned models with `/model`:

- `claude-code-cli/claude-opus-5-5` — 1M context, 128K output; effort levels `low`, `medium`, `high`, `xhigh`, `max` (default `medium`).
- `claude-code-cli/claude-sonnet-5-5` — 1M context, 128K output; effort levels `low`, `medium`, `high`, `xhigh`, `max` (default `high`).
- `claude-code-cli/claude-haiku-4-5` — 200K context, 64K output; Haiku supports extended thinking, but this adapter does not expose its budget control.

These IDs are passed to Claude Code as pinned model IDs instead of mutable `opus`/`sonnet`/`haiku` aliases. Use OMP's `--thinking` flag for Opus and Sonnet, for example:

```sh
omp --model claude-code-cli/claude-sonnet-5-5 --thinking high
```

Specs: [Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview), [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), [Haiku 4.5](https://platform.claude.com/docs/en/models/haiku-4-5/overview). OMP displays the published model limits; Claude Code's account and local context settings may further restrict effective capacity.

## Security and behavior

- The adapter starts `claude -p` in OMP's current working directory and forwards the OMP system prompt and conversation.
- Claude Code handles its own tools and permissions. OMP's tool approval settings do not control actions taken by the nested CLI. The adapter does not set a permissive Claude Code permission mode; headless actions that require a prompt may be denied unless configured in Claude Code itself.
- The adapter removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_OAUTH_TOKEN` from the child environment so Claude Code uses its own local authentication.
- All three upstream models accept images, but this adapter currently forwards only text and rejects image blocks; it does not transfer OMP's inline image data to Claude Code.
- Set `CLAUDE_CODE_CLI` if the executable is not available as `claude` on `PATH`.

## Local development

```sh
bun install --frozen-lockfile
bun test
omp --extension . --model claude-code-cli/claude-sonnet-5-5 --thinking high
```

The last command loads the extension directly from this checkout for a one-off session.
