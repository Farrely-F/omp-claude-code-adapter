import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import claudeCodeProviderExtension, {
	buildClaudeArgs,
	buildClaudeInput,
	claudeModels,
	decodeClaudeEvent,
	formatContext,
} from "../index";

const png = { type: "image" as const, data: "AAAA", mimeType: "image/png" };

describe("Claude Code model transport", () => {
	it("passes a pinned Claude model ID and supported effort to the CLI", () => {
		expect(buildClaudeArgs("claude-opus-5-5", "high")).toEqual([
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--model",
			"claude-opus-5-5",
			"--effort",
			"high",
		]);
	});

	it("offers rolling aliases that defer version resolution to Claude Code", () => {
		expect(claudeModels.filter(model => ["opus", "sonnet", "haiku"].includes(model.id)).map(model => model.id)).toEqual([
			"opus",
			"sonnet",
			"haiku",
		]);
		expect(claudeModels.find(model => model.id === "sonnet")?.thinking).toEqual({
			mode: "effort",
			efforts: ["low", "medium", "high", "xhigh", "max"],
		});
		expect(buildClaudeArgs("sonnet")).toEqual([
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--model",
			"sonnet",
		]);
	});

	it("omits CLI effort for Haiku, which does not support effort levels", () => {
		expect(buildClaudeArgs("claude-haiku-4-5")).not.toContain("--effort");
	});

	it("registers versioned models with their actual context and output limits", () => {
		expect(
			claudeModels.filter(model => model.id.startsWith("claude-")).map(({ id, name, contextWindow, maxTokens }) => ({
				id,
				name,
				contextWindow,
				maxTokens,
			})),
		).toEqual([
			{ id: "claude-opus-5-5", name: "Claude Opus 5.5", contextWindow: 1_000_000, maxTokens: 128_000 },
			{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", contextWindow: 1_000_000, maxTokens: 128_000 },
			{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, maxTokens: 64_000 },
		]);
	});

	it("exposes thinking levels only where Claude supports effort selection", () => {
		expect(claudeModels[0]?.thinking).toEqual({
			mode: "effort",
			efforts: ["low", "medium", "high", "xhigh", "max"],
			defaultLevel: "medium",
		});
		expect(claudeModels[1]?.thinking).toEqual({
			mode: "effort",
			efforts: ["low", "medium", "high", "xhigh", "max"],
			defaultLevel: "high",
		});
		expect(claudeModels[2]?.reasoning).toBe(false);
		expect(claudeModels[2]?.thinking).toBeUndefined();
	});

	it("preserves OMP system and user context for the nested CLI run", () => {
		expect(
			formatContext({
				systemPrompt: ["Follow project instructions."],
				messages: [{ role: "user", content: "Fix the issue.", timestamp: 1 }],
			}),
		).toEqual([
			{
				type: "text",
				text: expect.stringContaining("Follow project instructions.\n\n## OMP conversation\n[user]\nFix the issue."),
			},
		]);
	});

	it("keeps images in their original position between transcript text", () => {
		const blocks = formatContext({
			messages: [
				{ role: "user", content: [{ type: "text", text: "before" }, png, { type: "text", text: "after" }], timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "seen" }], timestamp: 2 } as never,
			],
		});
		expect(blocks.map(block => block.type)).toEqual(["text", "image", "text"]);
		expect(blocks[0]).toMatchObject({ text: expect.stringMatching(/\[user\]\nbefore\n$/) });
		expect(blocks[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
		expect(blocks[2]).toMatchObject({ text: expect.stringMatching(/^\nafter\n\n\[assistant\]\nseen$/) });
	});

	it("forwards images returned by tools", () => {
		const blocks = formatContext({
			messages: [
				{ role: "toolResult", toolCallId: "1", toolName: "screenshot", content: [png], isError: false, timestamp: 1 } as never,
			],
		});
		expect(blocks.filter(block => block.type === "image")).toHaveLength(1);
	});

	it("wraps content blocks as one stream-json user message on a single line", () => {
		const line = buildClaudeInput([{ type: "text", text: "a\nb" }]);
		expect(line.endsWith("\n")).toBe(true);
		expect(line.slice(0, -1)).not.toContain("\n");
		expect(JSON.parse(line)).toEqual({
			type: "user",
			message: { role: "user", content: [{ type: "text", text: "a\nb" }] },
		});
	});

	it("declares image input on every model so OMP sends images", () => {
		expect(claudeModels.every(model => model.input.includes("image"))).toBe(true);
	});

	it("extracts text deltas from Claude's JSON event stream", () => {
		expect(
			decodeClaudeEvent(
				JSON.stringify({
					type: "stream_event",
					event: { delta: { type: "text_delta", text: "hello" } },
				}),
			),
		).toEqual({ text: "hello" });
	});

	it("extracts thinking deltas from Claude's JSON event stream", () => {
		expect(
			decodeClaudeEvent(
				JSON.stringify({
					type: "stream_event",
					event: { delta: { type: "thinking_delta", thinking: "hmm" } },
				}),
			),
		).toEqual({ thinking: "hmm" });
	});

	it("surfaces CLI-reported authentication failures", () => {
		expect(
			decodeClaudeEvent(JSON.stringify({ type: "result", is_error: true, result: "login required" })),
		).toEqual({ error: "login required" });
	});

	describe("streaming through the CLI", () => {
		const run = async (events: unknown[], context: Parameters<typeof formatContext>[0]) => {
			const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
			const stdinFile = join(dir, "stdin.json");
			const script = join(dir, "claude");
			writeFileSync(
				script,
				`#!/bin/sh\ncat > '${stdinFile}'\ncat <<'EOF'\n${events.map(event => JSON.stringify(event)).join("\n")}\nEOF\n`,
			);
			chmodSync(script, 0o755);
			process.env.CLAUDE_CODE_CLI = script;
			try {
				let streamSimple: (model: never, context: never) => AsyncIterable<{ type: string } & Record<string, unknown>>;
				claudeCodeProviderExtension({
					registerProvider: (_name: string, config: { streamSimple: typeof streamSimple }) => {
						streamSimple = config.streamSimple;
					},
				} as never);
				const seen: Array<{ type: string } & Record<string, unknown>> = [];
				for await (const event of streamSimple!({ id: "sonnet", api: "claude-code-cli", provider: "claude-code-cli" } as never, context as never))
					seen.push(event);
				return { seen, stdin: readFileSync(stdinFile, "utf8") };
			} finally {
				delete process.env.CLAUDE_CODE_CLI;
			}
		};
		const delta = (type: string, key: string, value: string) => ({
			type: "stream_event",
			event: { delta: { type, [key]: value } },
		});

		it("sends the image to the CLI on stdin and streams thinking before text at distinct indexes", async () => {
			const { seen, stdin } = await run(
				[
					delta("thinking_delta", "thinking", ""),
					delta("thinking_delta", "thinking", "plan"),
					delta("text_delta", "text", "answer"),
					{ type: "result", result: "answer" },
				],
				{ messages: [{ role: "user", content: [{ type: "text", text: "look" }, png], timestamp: 1 }] },
			);
			const content = JSON.parse(stdin).message.content;
			expect(content.some((block: { type: string }) => block.type === "image")).toBe(true);
			expect(seen.map(event => `${event.type}:${event.contentIndex ?? ""}`)).toEqual([
				"start:",
				"thinking_start:0",
				"thinking_delta:0",
				"thinking_end:0",
				"text_start:1",
				"text_delta:1",
				"text_end:1",
				"done:",
			]);
			expect(seen.find(event => event.type === "thinking_end")).toMatchObject({ content: "plan" });
			const done = seen.at(-1) as { message: { content: unknown[] } };
			expect(done.message.content).toEqual([
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "answer" },
			]);
		});

		it("closes an open thinking block when the CLI reports an error", async () => {
			const { seen } = await run(
				[delta("thinking_delta", "thinking", "plan"), { type: "result", is_error: true, result: "failed" }],
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			);
			expect(seen.map(event => event.type)).toEqual([
				"start",
				"thinking_start",
				"thinking_delta",
				"thinking_end",
				"error",
			]);
			expect(seen.find(event => event.type === "thinking_end")).toMatchObject({ content: "plan" });
		});

		it("shows no thinking block when the CLI only sends empty thinking deltas", async () => {
			const { seen } = await run(
				[delta("thinking_delta", "thinking", ""), delta("text_delta", "text", "hi"), { type: "result", result: "hi" }],
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			);
			expect(seen.some(event => event.type.startsWith("thinking"))).toBe(false);
			expect(seen.find(event => event.type === "text_start")).toMatchObject({ contentIndex: 0 });
		});
	});
});
