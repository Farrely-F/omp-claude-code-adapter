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
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsTools: false,
		reasoning: true,
		thinking: opusEffort,
	},
	{
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5",
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsTools: false,
		reasoning: true,
		thinking: sonnetEffort,
	},
	{
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		supportsTools: false,
		reasoning: false,
	},
	{
		id: "opus",
		name: "Claude Opus (latest via Claude Code)",
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsTools: false,
		reasoning: true,
		thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
	},
	{
		id: "sonnet",
		name: "Claude Sonnet (latest via Claude Code)",
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsTools: false,
		reasoning: true,
		thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
	},
	{
		id: "haiku",
		name: "Claude Haiku (latest via Claude Code)",
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		supportsTools: false,
		reasoning: false,
	},
];

export function buildClaudeArgs(prompt: string, modelId: string, effort?: ClaudeEffort): string[] {
	const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", modelId];
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

function renderContent(content: string | Array<{ type: string } & object>): string {
	if (typeof content === "string") return content;
	return content
		.map(block => {
			if (block.type === "text" && "text" in block && typeof block.text === "string") return block.text;
			if (block.type === "image") throw new Error("Claude Code CLI model currently supports text-only OMP context");
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function renderMessage(message: Message): string {
	if (message.role === "user" || message.role === "developer") {
		return `[${message.role}]\n${renderContent(message.content)}`;
	}
	if (message.role === "assistant") {
		const content = message.content
			.map(block => {
				if (block.type === "text") return block.text;
				if (block.type === "toolCall") return `[OMP tool call: ${block.name} ${JSON.stringify(block.arguments)}]`;
				if (block.type === "image") throw new Error("Claude Code CLI model currently supports text-only OMP context");
				return "";
			})
			.filter(Boolean)
			.join("\n");
		return `[assistant]\n${content}`;
	}
	return `[tool result: ${message.toolName}]\n${renderContent(message.content)}`;
}

export function formatContext(context: Context): string {
	const system = context.systemPrompt?.length ? context.systemPrompt.join("\n\n") : "";
	const transcript = context.messages.map(renderMessage).filter(Boolean).join("\n\n");
	return [
		"You are Claude Code running as the selected model in OMP. Complete the current task in this working directory using Claude Code's own tools. Treat the OMP transcript below as conversation context. Do not claim to have used OMP tools.",
		system ? `## OMP system instructions\n${system}` : "",
		`## OMP conversation\n${transcript}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

export function decodeClaudeEvent(line: string): { text: string } | { result: string } | { error: string } | null {
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
			"type" in streamEvent.delta &&
			streamEvent.delta.type === "text_delta"
		) {
			return {
				text:
					"text" in streamEvent.delta && typeof streamEvent.delta.text === "string" ? streamEvent.delta.text : "",
			};
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
	let textStarted = false;
	let settled = false;

	const fail = (reason: "aborted" | "error", detail: string) => {
		if (settled) return;
		settled = true;
		message.stopReason = reason;
		message.errorMessage = detail;
		message.duration = Date.now() - startedAt;
		stream.push({ type: "error", reason, error: partial() });
	};

	const pushText = (text: string) => {
		if (!text) return;
		if (!textStarted) {
			textStarted = true;
			stream.push({ type: "text_start", contentIndex: 0, partial: partial() });
		}
		fullText += text;
		message.content = [{ type: "text", text: fullText }];
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: partial() });
	};

	try {
		stream.push({ type: "start", partial: partial() });
		if (options?.signal?.aborted) {
			fail("aborted", "Claude Code request was cancelled");
			return stream;
		}
		const prompt = formatContext(context);
		const env = { ...process.env };
		for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"]) delete env[key];
		const selectedModel = claudeModels.find(candidate => candidate.id === model.id);
		const effort = selectedModel?.thinking
			? resolveClaudeEffort(options?.reasoning, selectedModel.thinking.defaultLevel)
			: undefined;
		const command = process.env.CLAUDE_CODE_CLI || "claude";
		const child = spawn(command, buildClaudeArgs(prompt, model.id, effort), {
			cwd: process.cwd(),
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

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
			if (textStarted) stream.push({ type: "text_end", contentIndex: 0, content: fullText, partial: partial() });
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
