import { spawn } from "node:child_process";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Message,
	type Model,
	type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";

type ExtensionApi = {
	registerProvider(
		name: string,
		config: {
			api: string;
			baseUrl: string;
			models: ClaudeModelConfig[];
			streamSimple(
				model: Model<Api>,
				context: Context,
				options?: SimpleStreamOptions,
			): AssistantMessageEventStream;
		},
	): void;
};

type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

type ClaudeModelConfig = {
	id: string;
	name: string;
	input: string[];
	contextWindow: number;
	maxTokens: number;
	supportsTools: boolean;
	reasoning: boolean;
	thinking?: { mode: "effort"; efforts: ClaudeEffort[]; defaultLevel?: ClaudeEffort };
};

const opusEffort: ClaudeModelConfig["thinking"] = {
	mode: "effort",
	efforts: ["low", "medium", "high", "xhigh", "max"],
	defaultLevel: "medium",
};

const sonnetEffort: ClaudeModelConfig["thinking"] = {
	mode: "effort",
	efforts: ["low", "medium", "high", "xhigh", "max"],
	defaultLevel: "high",
};

export const claudeModels: ClaudeModelConfig[] = [
	{
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsTools: false,
		reasoning: true,
		thinking: opusEffort,
	},
	{
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5",
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsTools: false,
		reasoning: true,
		thinking: sonnetEffort,
	},
	{
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		input: ["text", "image"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		supportsTools: false,
		reasoning: false,
	},
	{
		id: "opus",
		name: "Claude Opus (latest via Claude Code)",
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsTools: false,
		reasoning: true,
		thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
	},
	{
		id: "sonnet",
		name: "Claude Sonnet (latest via Claude Code)",
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsTools: false,
		reasoning: true,
		thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
	},
	{
		id: "haiku",
		name: "Claude Haiku (latest via Claude Code)",
		input: ["text", "image"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		supportsTools: false,
		reasoning: false,
	},
];

export function buildClaudeArgs(modelId: string, effort?: ClaudeEffort): string[] {
	const args = [
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model",
		modelId,
	];
	if (effort) args.push("--effort", effort);
	return args;
}

function resolveClaudeEffort(
	effort: SimpleStreamOptions["reasoning"] | undefined,
	defaultLevel: ClaudeEffort | undefined,
): ClaudeEffort | undefined {
	if (effort === "minimal") return "low";
	return effort ?? defaultLevel;
}

type ClaudeContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

type OmpBlock = { type: string } & object;

function pushBlock(blocks: ClaudeContentBlock[], block: ClaudeContentBlock): void {
	if (block.type !== "text") {
		blocks.push(block);
		return;
	}
	if (!block.text) return;
	const last = blocks.at(-1);
	if (last?.type === "text") last.text += block.text;
	else blocks.push({ ...block });
}

function imageBlock(block: OmpBlock): ClaudeContentBlock | undefined {
	if (!("data" in block) || typeof block.data !== "string") return undefined;
	if (!("mimeType" in block) || typeof block.mimeType !== "string") return undefined;
	return { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } };
}

function renderParts(content: string | OmpBlock[], renderBlock: (block: OmpBlock) => ClaudeContentBlock | undefined): ClaudeContentBlock[] {
	const parts: ClaudeContentBlock[] = [];
	if (typeof content === "string") {
		pushBlock(parts, { type: "text", text: content });
		return parts;
	}
	for (const block of content) {
		const rendered = renderBlock(block);
		if (!rendered || (rendered.type === "text" && !rendered.text)) continue;
		if (parts.length) pushBlock(parts, { type: "text", text: "\n" });
		pushBlock(parts, rendered);
	}
	return parts;
}

function renderUserBlock(block: OmpBlock): ClaudeContentBlock | undefined {
	if (block.type === "text" && "text" in block && typeof block.text === "string") return { type: "text", text: block.text };
	if (block.type === "image") return imageBlock(block);
	return undefined;
}

function renderAssistantBlock(block: OmpBlock): ClaudeContentBlock | undefined {
	if (block.type === "toolCall" && "name" in block && typeof block.name === "string" && "arguments" in block) {
		return { type: "text", text: `[OMP tool call: ${block.name} ${JSON.stringify(block.arguments)}]` };
	}
	return renderUserBlock(block);
}

function renderMessage(message: Message): ClaudeContentBlock[] {
	const blocks: ClaudeContentBlock[] = [];
	const append = (header: string, parts: ClaudeContentBlock[]) => {
		pushBlock(blocks, { type: "text", text: header });
		for (const part of parts) pushBlock(blocks, part);
	};
	if (message.role === "user" || message.role === "developer") {
		append(`[${message.role}]\n`, renderParts(message.content, renderUserBlock));
	} else if (message.role === "assistant") {
		append("[assistant]\n", renderParts(message.content, renderAssistantBlock));
	} else {
		append(`[tool result: ${message.toolName}]\n`, renderParts(message.content, renderUserBlock));
	}
	return blocks;
}

export function formatContext(context: Context): ClaudeContentBlock[] {
	const system = context.systemPrompt?.length ? context.systemPrompt.join("\n\n") : "";
	const blocks: ClaudeContentBlock[] = [];
	const text = (value: string) => pushBlock(blocks, { type: "text", text: value });
	text(
		"You are Claude Code running as the selected model in OMP. Complete the current task in this working directory using Claude Code's own tools. Treat the OMP transcript below as conversation context. Do not claim to have used OMP tools.",
	);
	if (system) text(`\n\n## OMP system instructions\n${system}`);
	text("\n\n## OMP conversation\n");
	context.messages.forEach((message, index) => {
		if (index) text("\n\n");
		for (const block of renderMessage(message)) pushBlock(blocks, block);
	});
	return blocks;
}

export function buildClaudeInput(blocks: ClaudeContentBlock[]): string {
	return `${JSON.stringify({ type: "user", message: { role: "user", content: blocks } })}\n`;
}

export function decodeClaudeEvent(
	line: string,
): { text: string } | { thinking: string } | { result: string } | { error: string } | null {
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		throw new Error(`Invalid JSON from Claude Code CLI: ${line.slice(0, 200)}`);
	}
	if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
	if ("type" in event && event.type === "stream_event" && "event" in event) {
		const streamEvent = event.event;
		if (
			streamEvent !== null &&
			typeof streamEvent === "object" &&
			"delta" in streamEvent &&
			streamEvent.delta !== null &&
			typeof streamEvent.delta === "object" &&
			"type" in streamEvent.delta
		) {
			const { delta } = streamEvent;
			if (delta.type === "text_delta") return { text: "text" in delta && typeof delta.text === "string" ? delta.text : "" };
			if (delta.type === "thinking_delta")
				return { thinking: "thinking" in delta && typeof delta.thinking === "string" ? delta.thinking : "" };
		}
	}
	if ("type" in event && event.type === "result") {
		const result = "result" in event && typeof event.result === "string" ? event.result : "";
		return "is_error" in event && event.is_error === true
			? { error: result || "Claude Code reported an error" }
			: { result };
	}
	return null;
}

function streamClaudeCode(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const partial = (): AssistantMessage => ({ ...message, content: message.content.slice() });
	const startedAt = Date.now();
	let fullText = "";
	let fullThinking = "";
	let thinkingIndex = -1;
	let thinkingOpen = false;
	let textIndex = -1;
	let settled = false;

	const fail = (reason: "aborted" | "error", detail: string) => {
		if (settled) return;
		settled = true;
		message.stopReason = reason;
		message.errorMessage = detail;
		message.duration = Date.now() - startedAt;
		closeThinking();
		stream.push({ type: "error", reason, error: partial() });
	};

	const closeThinking = () => {
		if (!thinkingOpen) return;
		thinkingOpen = false;
		stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: fullThinking, partial: partial() });
	};

	const pushThinking = (thinking: string) => {
		// The CLI streams empty thinking deltas when it withholds reasoning text; open a thinking block only for real text.
		if (!thinking || textIndex >= 0) return;
		if (!thinkingOpen) {
			thinkingOpen = true;
			thinkingIndex = message.content.length;
			message.content.push({ type: "thinking", thinking: "" });
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: partial() });
		}
		fullThinking += thinking;
		message.content[thinkingIndex] = { type: "thinking", thinking: fullThinking };
		stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: thinking, partial: partial() });
	};

	const pushText = (text: string) => {
		if (!text) return;
		if (textIndex < 0) {
			closeThinking();
			textIndex = message.content.length;
			message.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: textIndex, partial: partial() });
		}
		fullText += text;
		message.content[textIndex] = { type: "text", text: fullText };
		stream.push({ type: "text_delta", contentIndex: textIndex, delta: text, partial: partial() });
	};

	try {
		stream.push({ type: "start", partial: partial() });
		if (options?.signal?.aborted) {
			fail("aborted", "Claude Code request was cancelled");
			return stream;
		}
		const input = buildClaudeInput(formatContext(context));
		const env = { ...process.env };
		for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"]) delete env[key];
		const selectedModel = claudeModels.find(candidate => candidate.id === model.id);
		const effort = selectedModel?.thinking
			? resolveClaudeEffort(options?.reasoning, selectedModel.thinking.defaultLevel)
			: undefined;
		const command = process.env.CLAUDE_CODE_CLI || "claude";
		const child = spawn(command, buildClaudeArgs(model.id, effort), {
			cwd: process.cwd(),
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		// A failed spawn or early CLI exit surfaces through "error"/"close"; a broken stdin pipe adds nothing.
		child.stdin.on("error", () => {});
		child.stdin.end(input);

		let stdoutBuffer = "";
		let stderr = "";
		let finalResult: string | undefined;
		let finalError: string | undefined;
		let streamError: Error | undefined;

		const consumeLine = (line: string) => {
			if (!line.trim()) return;
			const decoded = decodeClaudeEvent(line);
			if (!decoded) return;
			if ("text" in decoded) pushText(decoded.text);
			else if ("thinking" in decoded) pushThinking(decoded.thinking);
			else if ("result" in decoded) finalResult = decoded.result;
			else finalError = decoded.error;
		};

		const onAbort = () => child.kill("SIGINT");
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			let newline = stdoutBuffer.indexOf("\n");
			while (newline >= 0) {
				try {
					consumeLine(stdoutBuffer.slice(0, newline));
				} catch (error) {
					streamError = error instanceof Error ? error : new Error(String(error));
					child.kill("SIGINT");
					return;
				}
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				newline = stdoutBuffer.indexOf("\n");
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-8192);
		});
		child.once("error", error => fail("error", `Unable to start Claude Code CLI (${command}): ${error.message}`));
		child.once("close", (code, exitSignal) => {
			options?.signal?.removeEventListener("abort", onAbort);
			try {
				if (!streamError && stdoutBuffer.trim()) consumeLine(stdoutBuffer);
			} catch (error) {
				streamError = error instanceof Error ? error : new Error(String(error));
			}
			if (streamError) return fail("error", streamError.message);
			if (options?.signal?.aborted) return fail("aborted", "Claude Code request was cancelled");
			if (finalError) return fail("error", finalError);
			if (code !== 0)
				return fail("error", stderr.trim() || `Claude Code exited with ${code ?? exitSignal ?? "unknown status"}`);
			if (!fullText.trim() && finalResult) pushText(finalResult);
			if (!fullText.trim()) return fail("error", "Claude Code CLI exited without returning an answer");

			settled = true;
			message.timestamp = Date.now();
			message.duration = Date.now() - startedAt;
			closeThinking();
			stream.push({ type: "text_end", contentIndex: textIndex, content: fullText, partial: partial() });
			stream.push({ type: "done", reason: "stop", message: partial() });
		});
	} catch (error) {
		fail("error", error instanceof Error ? error.message : String(error));
	}
	return stream;
}

export default function claudeCodeProviderExtension(pi: ExtensionApi): void {
	pi.registerProvider("claude-code-cli", {
		api: "claude-code-cli",
		// OMP requires a credential marker for custom providers; this value never leaves this extension.
		apiKey: "claude-code-cli-local",
		baseUrl: "https://api.anthropic.com",
		models: claudeModels,
		streamSimple: streamClaudeCode,
	});
}
