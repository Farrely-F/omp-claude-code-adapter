import { describe, expect, it } from "bun:test";
import { buildClaudeArgs, claudeModels, decodeClaudeEvent, formatContext } from "../index";

describe("Claude Code model transport", () => {
	it("passes the selected model alias and thinking effort to Claude Code", () => {
		expect(buildClaudeArgs("prompt", "opus", "high")).toEqual([
			"-p",
			"prompt",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--model",
			"opus",
			"--effort",
			"high",
		]);
	});

	it("registers the three Claude model aliases with effort controls", () => {
		expect(claudeModels.map(model => model.id)).toEqual(["opus", "sonnet", "haiku"]);
		expect(claudeModels[0]?.thinking).toEqual({
			mode: "effort",
			efforts: ["low", "medium", "high", "xhigh", "max"],
			defaultLevel: "medium",
		});
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
