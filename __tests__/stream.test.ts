import { describe, expect, it } from "bun:test";
import { buildClaudeArgs, claudeModels, decodeClaudeEvent, formatContext } from "../index";

describe("Claude Code model transport", () => {
	it("passes a pinned Claude model ID and supported effort to the CLI", () => {
		expect(buildClaudeArgs("prompt", "claude-opus-5-5", "high")).toEqual([
			"-p",
			"prompt",
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
		expect(buildClaudeArgs("prompt", "sonnet")).toEqual([
			"-p",
			"prompt",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--model",
			"sonnet",
		]);
	});

	it("omits CLI effort for Haiku, which does not support effort levels", () => {
		expect(buildClaudeArgs("prompt", "claude-haiku-4-5")).not.toContain("--effort");
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
		).toContain("Follow project instructions.\n\n## OMP conversation\n[user]\nFix the issue.");
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

	it("surfaces CLI-reported authentication failures", () => {
		expect(
			decodeClaudeEvent(JSON.stringify({ type: "result", is_error: true, result: "login required" })),
		).toEqual({ error: "login required" });
	});
});
