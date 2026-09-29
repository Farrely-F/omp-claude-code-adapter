# OMP Claude Code Adapter

```text
  ___  __  __ ____
 / _ \|  \/  |  _ \
| | | | |\/| | |_) |
| |_| | |  | |  __/
 \___/|_|  |_|_|

+-------+   prompt + history   +-----------------+   claude -p   +-----------------+
|  OMP  | ------------------>  | claude-code-cli | ------------> | Claude Code CLI |
|       | <------------------  |  (this adapter) | <------------ |  (local login)  |
+-------+    streamed reply    +-----------------+    stdout     +-----------------+
```

An OMP custom model provider that runs the locally authenticated Claude Code CLI. It pins the current Claude Opus 5.5, Sonnet 5.5, and Haiku 4.5 model IDs and exposes supported effort controls for Opus and Sonnet.

## Requirements

- OMP 18.4.3
- Claude Code CLI installed and signed in on the same device
- GitHub access is required only for private forks; the upstream repository is public.

## Install

Install the tagged extension directly:

```sh
omp install github:Farrely-F/omp-claude-code-adapter#v1.0.4
```

Start a new OMP session after installation. Confirm discovery with:

```sh
omp models claude-code-cli
```

For rolling selections, choose the Claude Code CLI aliases:

- `claude-code-cli/opus` — Claude Code's current Opus model
- `claude-code-cli/sonnet` — Claude Code's current Sonnet model
- `claude-code-cli/haiku` — Claude Code's current Haiku model

These are the recommended latest-model choices. They pass `opus`, `sonnet`, or `haiku` to the local CLI, which resolves the alias according to its installed version. The adapter does not force an effort setting unless OMP explicitly supplies one, so Claude Code's default for the resolved model applies. To use the rolling Sonnet alias:

```sh
omp --model claude-code-cli/sonnet
```

For reproducibility, select the pinned IDs:

- `claude-code-cli/claude-opus-5-5` — 1M context, 128K output; effort levels `low`, `medium`, `high`, `xhigh`, `max` (default `medium`).
- `claude-code-cli/claude-sonnet-5-5` — 1M context, 128K output; effort levels `low`, `medium`, `high`, `xhigh`, `max` (default `high`).
- `claude-code-cli/claude-haiku-4-5` — 200K context, 64K output; no effort selector in this adapter.

Pinned limits come from [Anthropic's current model specs](https://platform.claude.com/docs/en/models/overview). The rolling aliases' catalog limits reflect the current releases in this adapter version; if an alias advances to a model with different limits, update the adapter metadata. Claude Code must also be updated before its aliases resolve to a newly released model.

## Security and behavior

- The adapter starts `claude -p` in OMP's current working directory and forwards the OMP system prompt and conversation.
- Claude Code handles its own tools and permissions. OMP's tool approval settings do not control actions taken by the nested CLI. The adapter does not set a permissive Claude Code permission mode; headless actions that require a prompt may be denied unless configured in Claude Code itself.
- The adapter removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_OAUTH_TOKEN` from the child environment so Claude Code uses its own local authentication.
- Images in user, developer, assistant, and tool-result messages are forwarded to Claude Code as base64 image blocks, in their original position within the transcript. The prompt goes to the CLI on stdin (`--input-format stream-json`), not as a command-line argument.
- Thinking deltas from the CLI are forwarded to OMP as thinking blocks. In headless mode (`claude -p`) Claude Code currently sends empty thinking deltas, so no reasoning text appears yet; the adapter shows a thinking block only when the CLI supplies text and never invents any.
- Set `CLAUDE_CODE_CLI` if the executable is not available as `claude` on `PATH`.

## Local development

```sh
bun install --frozen-lockfile
bun test
omp --extension . --model claude-code-cli/claude-sonnet-5-5 --thinking high
```

The last command loads the extension directly from this checkout for a one-off session.
