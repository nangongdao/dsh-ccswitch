import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, IMAGE_OFFLOAD_REQUIRED_CODE, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId, ToolCallId, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError, offloadedImageText, projectOffloadedImages, requestImageHandleText, requiredImageOffload, resolveImageAttachmentAccess } from "@deepseek-ai/dsh-llm";
import { calculateCost, createAssistantMessageEventStream, createModels, createProvider, getCurrentTools, getInitialSystemMessage, getSupportedThinkingLevels, getSystemMessageText, isContextOverflow } from "@earendil-works/pi-ai";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as nativePath from "node:path";
import { requestImageDimensions } from "@deepseek-ai/dsh-attachment";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { convertMessages, convertTools, mapStopReasonString, resolveGoogleFunctionCallingMode, retainThoughtSignature, supportsGoogleStrictToolSampling } from "@earendil-works/pi-ai/api/google-shared";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
//#region src/paths.ts
/** Tauri application identifier of CC Switch, which is also its settings directory name. */
const CC_SWITCH_APP_ID = "com.ccswitch.desktop";
const CC_SWITCH_APP_PATHS = "app_paths.json";
const CC_SWITCH_DATABASE = "cc-switch.db";
/** Key CC Switch writes when the user relocates its data directory. */
const CC_SWITCH_DATA_DIR_KEY = "app_config_dir_override";
const nativeProbe = {
	isDirectory(path) {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	},
	readText(path) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return;
		}
	}
};
/**
* Per-user settings directories the host platform uses for a Tauri application
* with CC Switch's identifier: Windows roaming app data, the XDG config home,
* and the macOS application support directory. All three are probed because
* only one of them exists on a real machine, which keeps this platform-neutral.
*/
function ccSwitchSettingsDirs(home, paths) {
	return [
		paths.join(home, "AppData", "Roaming", CC_SWITCH_APP_ID),
		paths.join(home, ".config", CC_SWITCH_APP_ID),
		paths.join(home, "Library", "Application Support", CC_SWITCH_APP_ID)
	];
}
function isAbsolute(path) {
	return nativePath.win32.isAbsolute(path) || nativePath.posix.isAbsolute(path);
}
/**
* Read `app_config_dir_override` from CC Switch's own `app_paths.json`.
*
* CC Switch relocates its entire data directory when the user picks a custom
* folder, so the live `cc-switch.db` can sit far from `~/.cc-switch` while a
* stale copy remains there. The override names a directory, and CC Switch
* itself falls back to its default location when that directory is gone; this
* mirrors both rules exactly rather than second-guessing a half-migrated state.
*/
function configuredDataDirectory(home, paths, probe) {
	for (const directory of ccSwitchSettingsDirs(home, paths)) {
		const raw = probe.readText(paths.join(directory, CC_SWITCH_APP_PATHS));
		if (raw === void 0) continue;
		let override;
		try {
			override = JSON.parse(raw.replace(/^\uFEFF/, ""))[CC_SWITCH_DATA_DIR_KEY];
		} catch {
			continue;
		}
		if (typeof override !== "string") continue;
		const candidate = override.trim();
		if (candidate.length === 0 || !isAbsolute(candidate)) continue;
		if (probe.isDirectory(candidate)) return candidate;
	}
}
/**
* Resolve every user-level path with the host platform's path semantics.
*
* An explicit `database` always wins; otherwise the directory CC Switch records
* in `app_paths.json` is used when it still exists, and `~/.cc-switch` is the
* final fallback. The OAuth sidecar files follow whichever database directory wins.
*/
function resolveCcSwitchPaths(home = homedir(), database = void 0, paths = nativePath, probe = nativeProbe) {
	const resolvedDatabase = database ?? paths.join(configuredDataDirectory(home, paths, probe) ?? paths.join(home, ".cc-switch"), CC_SWITCH_DATABASE);
	return {
		database: resolvedDatabase,
		providerSelection: paths.join(home, ".dsh", "ccswitch-providers.json"),
		codexOAuthStore: paths.join(paths.dirname(resolvedDatabase), "codex_oauth_auth.json"),
		codexAuth: paths.join(home, ".codex", "auth.json"),
		geminiOAuthCredentials: paths.join(home, ".gemini", "oauth_creds.json")
	};
}
//#endregion
//#region src/auth.ts
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GEMINI_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_CLIENT_SECRET = "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";
const TOKEN_REFRESH_BUFFER_MS = 6e4;
const execFileAsync = promisify(execFile);
const cache = /* @__PURE__ */ new Map();
function objectValue$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function nonEmpty$1(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function configValue(record, path) {
	let current = record.settings;
	for (const key of path) current = objectValue$1(current)[key];
	return nonEmpty$1(current);
}
function settingValue$1(record, ...paths) {
	for (const path of paths) {
		const value = configValue(record, path);
		if (value !== void 0) return value;
	}
}
async function readJson(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return;
	}
}
function normalizeGeminiCredentials(value) {
	if (typeof value === "string") {
		const raw = value.trim();
		if (raw.length === 0) return void 0;
		try {
			return normalizeGeminiCredentials(JSON.parse(raw));
		} catch {
			return raw.startsWith("ya29.") ? {
				access_token: raw,
				expiry_date: Number.MAX_SAFE_INTEGER
			} : void 0;
		}
	}
	if (value === null || typeof value !== "object") return void 0;
	const root = value;
	const token = root.token !== null && typeof root.token === "object" ? root.token : root;
	const accessToken = nonEmpty$1(token.access_token) ?? nonEmpty$1(token.accessToken);
	const refreshToken = nonEmpty$1(token.refresh_token) ?? nonEmpty$1(token.refreshToken);
	if (accessToken === void 0 && refreshToken === void 0) return void 0;
	const expiry = typeof token.expiry_date === "number" ? token.expiry_date : typeof token.expiresAt === "number" ? token.expiresAt : void 0;
	return {
		...accessToken === void 0 ? {} : { access_token: accessToken },
		...refreshToken === void 0 ? {} : { refresh_token: refreshToken },
		...typeof token.client_id === "string" ? { client_id: token.client_id } : {},
		...typeof token.client_secret === "string" ? { client_secret: token.client_secret } : {},
		...expiry === void 0 ? {} : { expiry_date: expiry }
	};
}
async function readGeminiOAuthCredentials(path) {
	if (process.platform === "darwin") try {
		const result = await execFileAsync("security", [
			"find-generic-password",
			"-s",
			"gemini-cli-oauth",
			"-a",
			"main-account",
			"-w"
		], {
			timeout: 3e3,
			maxBuffer: 262144
		});
		const parsed = normalizeGeminiCredentials(JSON.parse(result.stdout.trim()));
		if (parsed !== void 0) return parsed;
	} catch {}
	return normalizeGeminiCredentials(await readJson(path));
}
async function refreshOAuthToken(cacheKey, url, form, expiresInDefault = 3600) {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: form
	});
	if (!response.ok) throw new Error("CC Switch OAuth refresh failed (HTTP " + response.status + ")");
	const body = await response.json();
	const token = nonEmpty$1(body.access_token);
	if (token === void 0) throw new Error("CC Switch OAuth refresh returned no access token");
	const expiresAt = Date.now() + Math.max(60, body.expires_in ?? expiresInDefault) * 1e3;
	cache.set(cacheKey, {
		token,
		expiresAt
	});
	return token;
}
async function codexOAuthCredential(route, repository) {
	const paths = resolveCcSwitchPaths(void 0, repository.config.dbPath);
	const store = await readJson(paths.codexOAuthStore);
	const accounts = store?.accounts ?? {};
	const native = await readJson(paths.codexAuth);
	const nativeAccountId = nonEmpty$1(native?.tokens?.account_id);
	const accountId = route.accountId ?? nonEmpty$1(store?.default_account_id) ?? Object.keys(accounts)[0] ?? nativeAccountId;
	if (accountId === void 0) throw new Error("CC Switch Codex OAuth account is not available");
	const account = accounts[accountId];
	const nativeMatchesRoute = nativeAccountId === void 0 || nativeAccountId === accountId;
	const accessToken = nonEmpty$1(account?.access_token) ?? (nativeMatchesRoute ? nonEmpty$1(native?.tokens?.access_token) : void 0);
	const refreshToken = nonEmpty$1(account?.refresh_token) ?? (nativeMatchesRoute ? nonEmpty$1(native?.tokens?.refresh_token) : void 0);
	if (refreshToken === void 0 && accessToken === void 0) throw new Error("CC Switch Codex OAuth token is not available");
	const cacheKey = "codex:" + accountId;
	const cached = cache.get(cacheKey);
	return {
		token: cached !== void 0 && cached.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS ? cached.token : refreshToken === void 0 ? accessToken : await refreshOAuthToken(cacheKey, CODEX_TOKEN_URL, new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CODEX_CLIENT_ID,
			scope: "openid profile email"
		})),
		headers: {
			"chatgpt-account-id": accountId,
			originator: "cc-switch"
		}
	};
}
async function geminiOAuthCredential(route, repository, record) {
	const paths = resolveCcSwitchPaths(void 0, repository.config.dbPath);
	const credentials = normalizeGeminiCredentials(settingValue$1(record, ["env", "GEMINI_API_KEY"], ["apiKey"], ["api_key"])) ?? await readGeminiOAuthCredentials(paths.geminiOAuthCredentials);
	if (credentials === void 0) throw new Error("CC Switch Gemini OAuth credentials are not available");
	const cacheKey = "gemini:" + route.sourceId;
	const cached = cache.get(cacheKey);
	const current = nonEmpty$1(credentials.access_token);
	const expiry = typeof credentials.expiry_date === "number" ? credentials.expiry_date : 0;
	const token = cached !== void 0 && cached.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS ? cached.token : current !== void 0 && expiry > Date.now() + TOKEN_REFRESH_BUFFER_MS ? current : await refreshOAuthToken(cacheKey, GOOGLE_TOKEN_URL, new URLSearchParams({
		client_id: nonEmpty$1(credentials.client_id) ?? GEMINI_CLIENT_ID,
		client_secret: nonEmpty$1(credentials.client_secret) ?? GEMINI_CLIENT_SECRET,
		refresh_token: nonEmpty$1(credentials.refresh_token) ?? "",
		grant_type: "refresh_token"
	}));
	return {
		token,
		headers: {
			authorization: "Bearer " + token,
			"x-goog-api-client": "gemini-cli/1.0"
		}
	};
}
async function resolveCredential(route, repository) {
	const record = repository.record(route);
	if (record === void 0) throw new Error("CC Switch provider disappeared: " + route.sourceId);
	if (route.authKind === "codex-oauth") return codexOAuthCredential(route, repository);
	if (route.authKind === "gemini-oauth") return geminiOAuthCredential(route, repository, record);
	const key = route.appType === "claude" ? settingValue$1(record, ["env", "ANTHROPIC_AUTH_TOKEN"], ["env", "ANTHROPIC_API_KEY"], ["apiKey"], ["api_key"]) : route.appType === "codex" ? settingValue$1(record, ["auth", "OPENAI_API_KEY"], ["OPENAI_API_KEY"], ["apiKey"], ["api_key"]) : settingValue$1(record, ["env", "GEMINI_API_KEY"], ["apiKey"], ["api_key"]);
	if (key === void 0) throw new Error("CC Switch provider " + route.sourceId + " has no usable credential");
	return { token: key };
}
//#endregion
//#region src/replay.ts
/**
* Durable pi-ai replay metadata and assistant-history reconstruction.
*
* Harness content remains the durable source for text and tool calls. This
* module stores only the provider-native metadata needed to reconstruct a
* pi-ai assistant message on a later request.
*
* @module dsh-llm-pi-ai/replay
*/
/** Parse tool-call argument JSON; tolerate model malformations with {}. */
function parseArguments(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
	} catch {}
	return {};
}
/** Construct the zero usage value required by historical pi-ai messages. */
function emptyPiUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
/**
* Project a successful pi-ai response into the minimal durable replay state.
* The per-block half is index-aligned with the streamed blocks (pi-ai content
* order), so `BlockAssembler` prunes an entry with its block whenever assembly
* removes one.
* @param message - completed native pi-ai assistant response.
* @param requestedModel - request identity stored in the assistant source; defaults to the native model.
* @returns the versioned lossless-JSON replay projection.
*/
function toPiReplayState(message, requestedModel = message.model) {
	return {
		response: {
			kind: "pi-ai",
			version: 2,
			api: message.api,
			provider: message.provider,
			model: requestedModel,
			...message.responseModel === void 0 ? {} : { responseModel: message.responseModel },
			...message.responseId === void 0 ? {} : { responseId: message.responseId },
			...message.providerThinkingLevel === void 0 ? {} : { providerThinkingLevel: message.providerThinkingLevel },
			stopReason: message.stopReason
		},
		blocks: message.content.map((block) => {
			switch (block.type) {
				case "text": return {
					type: "text",
					...block.textSignature === void 0 ? {} : { textSignature: block.textSignature }
				};
				case "thinking": return {
					type: "reasoning",
					...block.thinkingSignature === void 0 ? {} : { thinkingSignature: block.thinkingSignature },
					...block.redacted === void 0 ? {} : { redacted: block.redacted }
				};
				case "toolCall": return {
					type: "tool-call",
					...block.thoughtSignature === void 0 ? {} : { thoughtSignature: block.thoughtSignature }
				};
			}
		})
	};
}
function invalidReplay(message) {
	throw new LlmError(`invalid pi-ai replay state: ${message}`, "INVALID_REPLAY_STATE");
}
/** Validate the durable adapter-private envelope before it reaches pi-ai. */
function readReplayState(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidReplay("expected a replay envelope");
	const envelope = value;
	const rawResponse = envelope["response"];
	if (typeof rawResponse !== "object" || rawResponse === null || Array.isArray(rawResponse)) return invalidReplay("expected a response object");
	const response = rawResponse;
	if (response["kind"] !== "pi-ai") return invalidReplay("unknown state kind");
	if (response["version"] !== 2) return invalidReplay(`unsupported version ${String(response["version"])}`);
	for (const key of [
		"api",
		"provider",
		"model"
	]) if (typeof response[key] !== "string" || response[key].length === 0) return invalidReplay(`${key} must be a non-empty string`);
	if (![
		"stop",
		"length",
		"toolUse",
		"error",
		"aborted"
	].includes(String(response["stopReason"]))) return invalidReplay("unknown stopReason");
	if (response["responseModel"] !== void 0 && typeof response["responseModel"] !== "string") return invalidReplay("responseModel must be a string");
	if (response["responseId"] !== void 0 && typeof response["responseId"] !== "string") return invalidReplay("responseId must be a string");
	if (response["providerThinkingLevel"] !== void 0 && typeof response["providerThinkingLevel"] !== "string") return invalidReplay("providerThinkingLevel must be a string");
	const blocks = envelope["blocks"];
	if (!Array.isArray(blocks)) return invalidReplay("blocks must be an array");
	for (const [index, value] of blocks.entries()) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidReplay(`block ${index} must be an object`);
		const block = value;
		if (![
			"text",
			"reasoning",
			"tool-call"
		].includes(String(block["type"]))) return invalidReplay(`block ${index} has an unknown type`);
		for (const signature of [
			"textSignature",
			"thinkingSignature",
			"thoughtSignature"
		]) if (block[signature] !== void 0 && typeof block[signature] !== "string") return invalidReplay(`block ${index} ${signature} must be a string`);
		if (block["redacted"] !== void 0 && typeof block["redacted"] !== "boolean") return invalidReplay(`block ${index} redacted must be boolean`);
	}
	return {
		response,
		blocks
	};
}
/** Convert provider-neutral blocks without trusting them as same-model replay. */
function foreignAssistant(message) {
	const source = message.source;
	const content = [];
	for (const block of message.content) switch (block.type) {
		case "text":
			content.push({
				type: "text",
				text: block.text
			});
			break;
		case "reasoning":
			content.push({
				type: "thinking",
				thinking: block.text
			});
			break;
		case "tool-call":
			content.push({
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: parseArguments(block.arguments)
			});
			break;
		case "image": throw new LlmError("pi-ai chat history cannot represent structured assistant image output", "UNSUPPORTED_CONTENT");
	}
	return {
		role: "assistant",
		content,
		api: "dsh-foreign",
		provider: source.provider,
		model: source.model,
		usage: emptyPiUsage(),
		stopReason: content.some((piece) => piece.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 0
	};
}
/** Recombine durable Harness content with validated pi-ai replay metadata. */
function replayedAssistant(message, source, rawState) {
	const state = readReplayState(rawState);
	if (state.response.provider !== source.provider) return invalidReplay("provider does not match assistant source");
	if (state.response.model !== source.model) return invalidReplay("model does not match assistant source");
	if (state.blocks.length !== message.content.length) return invalidReplay("block count does not match assistant content");
	return {
		role: "assistant",
		content: message.content.map((block, index) => {
			const replay = state.blocks[index];
			if (replay === void 0 || replay.type !== block.type) return invalidReplay(`block ${index} does not match assistant content`);
			switch (block.type) {
				case "text": return {
					type: "text",
					text: block.text,
					...replay.type === "text" && replay.textSignature !== void 0 ? { textSignature: replay.textSignature } : {}
				};
				case "reasoning": return {
					type: "thinking",
					thinking: block.text,
					...replay.type === "reasoning" && replay.thinkingSignature !== void 0 ? { thinkingSignature: replay.thinkingSignature } : {},
					...replay.type === "reasoning" && replay.redacted !== void 0 ? { redacted: replay.redacted } : {}
				};
				case "tool-call": return {
					type: "toolCall",
					id: block.id,
					name: block.name,
					arguments: parseArguments(block.arguments),
					...replay.type === "tool-call" && replay.thoughtSignature !== void 0 ? { thoughtSignature: replay.thoughtSignature } : {}
				};
				/* v8 ignore next -- readReplayState rejects unknown replay tags, so an equal plugin-added Harness tag cannot reach this switch */
				default: return invalidReplay(`block ${index} has an unsupported Harness type`);
			}
		}),
		api: state.response.api,
		provider: state.response.provider,
		model: state.response.model,
		...state.response.responseModel === void 0 ? {} : { responseModel: state.response.responseModel },
		...state.response.responseId === void 0 ? {} : { responseId: state.response.responseId },
		...state.response.providerThinkingLevel === void 0 ? {} : { providerThinkingLevel: state.response.providerThinkingLevel },
		usage: emptyPiUsage(),
		stopReason: state.response.stopReason,
		timestamp: 0
	};
}
/**
* Convert one durable Harness assistant message into pi-ai history.
*
* Durable content is the authoritative record; replay metadata only restores
* native fidelity (ids, signatures). A replay state this build cannot use —
* another adapter's kind, another version, a malformed value, or metadata that
* no longer matches the content — therefore degrades the one message to
* provider-neutral history instead of failing the request.
* @param message - model-produced assistant content with provider, model, and optional adapter-owned replay metadata.
* @param onDegrade - called with the diagnostic reason when an unusable replay
*   state falls back to provider-neutral conversion.
* @returns a native pi-ai assistant message reconstructed from durable content.
*/
function toPiAssistant(message, onDegrade) {
	const source = message.source;
	if (source.replayState === void 0) return foreignAssistant(message);
	try {
		return replayedAssistant(message, source, source.replayState);
	} catch (error) {
		/* v8 ignore next -- replayedAssistant throws only INVALID_REPLAY_STATE LlmErrors today; the
		guard keeps a future non-replay failure loud instead of silently degrading it */
		if (!(error instanceof LlmError) || error.code !== "INVALID_REPLAY_STATE") throw error;
		onDegrade?.(error.message);
		return foreignAssistant(message);
	}
}
//#endregion
//#region src/context.ts
/**
* Harness request-history conversion into pi-ai's Context vocabulary.
*
* @module dsh-ccswitch/context
*/
/** Default projection budget: 4M pixels and 1 MiB per prepared image. */
const DEFAULT_REQUEST_IMAGE_POLICY = {
	maxPixels: 4194304,
	maxBytes: 1048576
};
/** Join the text blocks of a harness message. */
function flattenText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Recover the pi-ai toolResult message for one harness tool-role message. */
function toolResultOf(message, toolNames, content) {
	return {
		role: "toolResult",
		toolCallId: message.toolCallId,
		toolName: toolNames.get(message.toolCallId) ?? "unknown",
		content: typeof content === "string" ? [{
			type: "text",
			text: content || "(no output)"
		}] : content,
		isError: message.isError ?? false,
		timestamp: 0
	};
}
/** Reject unsupported roles, tool-change blocks, and image roles before replay or image offloading. */
function assertSupportedHistory(messages) {
	for (const message of messages) {
		if (message.role === "developer") throw new LlmError("Developer messages are not supported yet", "UNSUPPORTED_CONTENT");
		if (message.content.some((block) => block.type === "tool-addition" || block.type === "tool-removal")) throw new LlmError("Tool-change blocks require developer role", "UNSUPPORTED_CONTENT");
		if (message.role !== "user" && message.role !== "tool" && contentHasImage(message.content)) throw new LlmError(`pi-ai cannot represent an image in an in-history ${message.role} message`, "UNSUPPORTED_CONTENT");
	}
}
/**
* Convert one message's content blocks to pi-ai user content.
*
* A retained image emits a deterministic handle text immediately followed by
* the inline image, so the model always sees which attachment the bytes came
* from even when the provider renders the two parts independently.
*/
function userContent(blocks, requestImages, resolveImageAccess) {
	const content = [];
	for (const block of blocks) switch (block.type) {
		case "text":
			if (block.text.length > 0) content.push({
				type: "text",
				text: block.text
			});
			break;
		case "image": {
			const version = requestImages.get(block.attachment.attachmentId);
			if (version === void 0) throw new LlmError(`pi-ai request image "${block.attachment.attachmentId}" was not prepared`, "UNSUPPORTED_CONTENT");
			content.push({
				type: "text",
				text: requestImageHandleText(block.attachment, version, resolveImageAccess(block.attachment))
			});
			content.push({
				type: "image",
				data: Buffer.from(version.data).toString("base64"),
				mimeType: version.mediaType
			});
			break;
		}
	}
	if (content.every((block) => block.type === "text")) return content.map((block) => block.text).join("");
	return content;
}
/** Collect the distinct retained image references in first-appearance order. */
function collectImageRefs(blocks, refs) {
	for (const block of blocks) if (block.type === "image" && block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment);
}
/** Deterministic request target for one source under the route budgets. */
function requestImageTarget(ref, budget) {
	return {
		...requestImageDimensions(ref.width, ref.height, budget.maxPixels),
		maxBytes: budget.maxBytes
	};
}
/** Prepare one exact request version per distinct retained attachment id. */
async function prepareRequestImages(messages, attachments, budget, signal) {
	const refs = /* @__PURE__ */ new Map();
	for (const message of messages) collectImageRefs(message.content, refs);
	const orderedRefs = [...refs.values()];
	const prepared = await Promise.all(orderedRefs.map((ref) => attachments.readImageRequest(ref, requestImageTarget(ref, budget), signal)));
	const versions = /* @__PURE__ */ new Map();
	for (const [index, ref] of orderedRefs.entries()) {
		const version = prepared[index];
		if (version !== void 0) versions.set(ref.attachmentId, version);
	}
	return versions;
}
function toolsOf(options) {
	if (options.tools?.some((tool) => tool.deferLoading === true)) throw new LlmError("Deferred tool loading is not supported yet", "UNSUPPORTED_CONTENT");
	return options.tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
}
/**
* Select the pi-ai `systemPrompt` source shared by both conversion paths.
*
* `options.system` wins when defined and every history message converts,
* including a leading `system` message, which then folds into a `user`
* message. Otherwise a leading `system` history message supplies the prompt
* and leaves the converted history; empty leading text sends no prompt.
*/
function splitSystemPrompt(options) {
	if (options.system !== void 0) return {
		systemPrompt: options.system,
		messages: options.messages
	};
	const [first, ...rest] = options.messages;
	if (first?.role !== "system") return {
		systemPrompt: void 0,
		messages: options.messages
	};
	const text = flattenText(first);
	return {
		systemPrompt: text.length > 0 ? text : void 0,
		messages: rest
	};
}
/** Assemble the request-level pi-ai context envelope shared by both conversion paths. */
function piContext(systemPrompt, options, messages) {
	const tools = toolsOf(options);
	return {
		...systemPrompt !== void 0 ? { systemPrompt } : {},
		messages,
		...tools !== void 0 && tools.length > 0 ? { tools } : {}
	};
}
function appendAssistant(message, messages, toolNames, onReplayDegrade) {
	const assistant = toPiAssistant(message, onReplayDegrade);
	for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(block.id, block.name);
	messages.push(assistant);
}
/** Append the system and assistant roles both context builders treat identically; true when consumed. */
function appendSystemOrAssistant(message, messages, toolNames, onReplayDegrade) {
	if (message.role === "system") {
		messages.push({
			role: "user",
			content: flattenText(message),
			timestamp: 0
		});
		return true;
	}
	if (message.role === "assistant") {
		appendAssistant(message, messages, toolNames, onReplayDegrade);
		return true;
	}
	return false;
}
function textOnlyContext(options, onReplayDegrade) {
	assertSupportedHistory(options.messages);
	const split = splitSystemPrompt(options);
	const toolNames = /* @__PURE__ */ new Map();
	const messages = [];
	for (const message of split.messages) {
		if (contentHasImage(message.content)) throw new LlmError("pi-ai image conversion requires the durable attachment service", "UNSUPPORTED_CONTENT");
		if (appendSystemOrAssistant(message, messages, toolNames, onReplayDegrade)) continue;
		if (message.role === "tool") {
			messages.push(toolResultOf(message, toolNames, flattenText(message)));
			continue;
		}
		messages.push({
			role: "user",
			content: flattenText(message),
			timestamp: 0
		});
	}
	return piContext(split.systemPrompt, options, messages);
}
async function toPiContextWithImages(options, images, onReplayDegrade) {
	const { attachments, maxRequestImageBytes } = images;
	const resolveImageAccess = images.resolveImageAccess ?? (() => void 0);
	const requestImagePolicy = images.requestImagePolicy ?? DEFAULT_REQUEST_IMAGE_POLICY;
	assertSupportedHistory(options.messages);
	const split = splitSystemPrompt(options);
	const requestImages = await prepareRequestImages(split.messages, attachments, requestImagePolicy, options.signal);
	if (maxRequestImageBytes !== void 0) {
		const offloadImages = requiredImageOffload(split.messages, {
			representation: "base64",
			maxBytes: maxRequestImageBytes
		}, (block) => requestImages.get(block.attachment.attachmentId)?.bytes ?? 0);
		if (offloadImages > 0) throw new LlmError(`pi-ai request images exceed the ${maxRequestImageBytes}-byte base64 bound; ${offloadImages} more oldest occurrence(s) must be offloaded.`, IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages });
	}
	const exactMessages = projectOffloadedImages(split.messages, (ref) => offloadedImageText(ref, resolveImageAccess(ref)));
	const toolNames = /* @__PURE__ */ new Map();
	const messages = [];
	for (const message of exactMessages) {
		if (appendSystemOrAssistant(message, messages, toolNames, onReplayDegrade)) continue;
		if (message.role === "tool") {
			messages.push(toolResultOf(message, toolNames, userContent(message.content, requestImages, resolveImageAccess)));
			continue;
		}
		messages.push({
			role: "user",
			content: userContent(message.content, requestImages, resolveImageAccess),
			timestamp: 0
		});
	}
	return piContext(split.systemPrompt, options, messages);
}
function toPiContext(options, images, onReplayDegrade) {
	return images === void 0 ? textOnlyContext(options, onReplayDegrade) : toPiContextWithImages(options, images, onReplayDegrade);
}
//#endregion
//#region src/stream.ts
/**
* pi-ai assistant event translation into the Harness streaming protocol.
*
* pi-ai tool-call arguments are parsed objects while the Harness keeps their
* raw JSON representation. pi-ai also reports failures as terminal stream
* events, which this module maps into Harness finish chunks.
*
* @module dsh-llm-pi-ai/stream
*/
/**
* Map pi-ai usage (reasoning folded into output by pi-ai).
* @param usage - cumulative usage from the terminal pi-ai event.
* @returns harness counts with pi-ai's exact total; cache fields appear only
*   when non-zero (pi-ai reports zeros, not absence).
*/
function mapUsage(usage) {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		totalTokens: usage.totalTokens,
		...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
		...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}
	};
}
function classifyPiAiError(message) {
	if (/\b(?:401|403)\b/.test(message)) return "AUTH";
	if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
	if (/\b429\b|rate.?limit/i.test(message)) return "RATE_LIMIT";
	if (/\b413\b|failed to buffer the request body:\s*length limit exceeded|payload too large|request body too large/i.test(message)) return "INVALID_REQUEST";
	if (/\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";
	if (/\b5\d\d\b/.test(message)) return "SERVER";
	if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return "TIMEOUT";
	if (/stream ended (?:before|without)\b/i.test(message)) return "TRANSPORT";
	if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message) || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message) || /\bterminated\b|premature close/i.test(message)) return "TRANSPORT";
	return "PI_AI_ERROR";
}
/**
* Map a terminal pi-ai event to the harness finish reason.
* @param message - the assistant message carried by the `done` or `error` event.
* @param contextWindow - resolved catalog capacity for usage-based overflow detection.
* @returns the mapped harness reason. Recognized error text, `stop` usage above
*   `contextWindow`, and zero-output `length` usage that fills the window map
*   to `CONTEXT_WINDOW_EXCEEDED`; a `stop` with no content blocks maps to an
*   `EMPTY_RESPONSE` error, while terminal `pending` and `deferred` states map
*   to non-retryable `PI_AI_ERROR` failures.
*/
function mapStopReason(message, contextWindow) {
	const piAiOverflow = isContextOverflow(message, contextWindow);
	const harnessOverflow = message.stopReason === "error" && message.errorMessage !== void 0 && isContextWindowExceededError(message.errorMessage);
	if (piAiOverflow || harnessOverflow) return {
		kind: "error",
		failure: {
			message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
			code: CONTEXT_WINDOW_EXCEEDED_CODE
		}
	};
	switch (message.stopReason) {
		case "stop":
			if (message.content.length === 0) return {
				kind: "error",
				failure: {
					message: `model "${message.model}" returned a completed response with no content`,
					code: EMPTY_RESPONSE_CODE
				}
			};
			return { kind: "stop" };
		case "length": return { kind: "max-tokens" };
		case "toolUse": return { kind: "tool-calls" };
		case "pending": return {
			kind: "error",
			failure: {
				message: `pi-ai stream for model "${message.model}" ended pending`,
				code: "PI_AI_ERROR"
			}
		};
		case "deferred": return {
			kind: "error",
			failure: {
				message: `pi-ai deferred response for model "${message.model}" is not supported`,
				code: "PI_AI_ERROR"
			}
		};
		case "aborted": return {
			kind: "aborted",
			failure: {
				message: message.errorMessage ?? "pi-ai stream aborted",
				code: "ABORTED"
			}
		};
		case "error": {
			const text = message.errorMessage ?? "pi-ai stream error";
			return {
				kind: "error",
				failure: {
					message: text,
					code: classifyPiAiError(text)
				}
			};
		}
	}
}
/**
* Translate the pi-ai event stream into StreamChunks. pi-ai never throws
* mid-stream — failures arrive as `error` events, which become error/aborted
* `finish` chunks (the harness protocol's other error-delivery style).
* @param events - one assistant turn's pi-ai event stream.
* @param contextWindow - resolved catalog capacity for usage-based overflow detection.
* @param callerSignal - caller cancellation state; an aborted caller makes any
*   in-band terminal error an aborted finish.
* @param requestedModel - request model identity recorded for durable replay.
* @returns the harness chunks, ending with `usage` then `finish`; throws
*   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event.
*/
async function* toStreamChunks(events, contextWindow, callerSignal, requestedModel) {
	const toolIds = /* @__PURE__ */ new Map();
	for await (const event of events) switch (event.type) {
		case "start": break;
		case "text_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "text"
			};
			break;
		case "text_delta":
			yield {
				type: "text-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "text_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "text",
					text: event.content
				}
			};
			break;
		case "thinking_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "reasoning"
			};
			break;
		case "thinking_delta":
			yield {
				type: "reasoning-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "thinking_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "reasoning",
					text: event.content
				}
			};
			break;
		case "toolcall_start": {
			const partial = event.partial.content[event.contentIndex];
			const id = partial?.type === "toolCall" ? partial.id : "";
			const name = partial?.type === "toolCall" ? partial.name : "";
			toolIds.set(event.contentIndex, {
				id,
				name
			});
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "tool-call"
			};
			break;
		}
		case "toolcall_delta": {
			const known = toolIds.get(event.contentIndex);
			yield {
				type: "tool-call-delta",
				index: event.contentIndex,
				id: ToolCallId(known?.id ?? ""),
				...known?.name !== void 0 && known.name.length > 0 ? { name: known.name } : {},
				argumentsDelta: event.delta
			};
			break;
		}
		case "toolcall_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "tool-call",
					id: ToolCallId(event.toolCall.id),
					name: event.toolCall.name,
					arguments: JSON.stringify(event.toolCall.arguments)
				}
			};
			break;
		case "done":
			yield {
				type: "usage",
				usage: mapUsage(event.message.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.message, contextWindow),
				replayState: toPiReplayState(event.message, requestedModel)
			};
			return;
		case "error":
			yield {
				type: "usage",
				usage: mapUsage(event.error.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(callerSignal?.aborted ? {
					...event.error,
					stopReason: "aborted"
				} : event.error, contextWindow)
			};
			return;
	}
	throw new LlmError("pi-ai event stream ended without done/error", "STREAM_CLOSED");
}
//#endregion
//#region src/gemini-oauth.ts
let toolCallCounter = 0;
function headers(options) {
	const result = {
		accept: "text/event-stream",
		"content-type": "application/json"
	};
	for (const [key, value] of Object.entries(options.headers ?? {})) if (value !== null) result[key] = value;
	delete result["x-goog-api-key"];
	delete result["X-Goog-Api-Key"];
	return result;
}
function payload(model, context, options) {
	const tools = getCurrentTools(context.messages);
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const systemInstruction = initialSystemMessage === void 0 ? "" : getSystemMessageText(initialSystemMessage);
	const mode = tools.length === 0 ? void 0 : resolveGoogleFunctionCallingMode(tools, options.toolChoice, supportsGoogleStrictToolSampling(model.id));
	return {
		contents: convertMessages(model, context),
		...systemInstruction.length === 0 ? {} : { systemInstruction: {
			role: "user",
			parts: [{ text: systemInstruction }]
		} },
		...tools.length === 0 ? {} : {
			tools: convertTools(tools),
			...mode === void 0 ? {} : { toolConfig: { functionCallingConfig: { mode } } }
		},
		...options.temperature === void 0 && options.maxTokens === void 0 ? {} : { generationConfig: {
			...options.temperature === void 0 ? {} : { temperature: options.temperature },
			...options.maxTokens === void 0 ? {} : { maxOutputTokens: options.maxTokens }
		} }
	};
}
function requestURL(model) {
	return `${(model.baseUrl ?? "").replace(/\/+$/, "")}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`;
}
async function* sse(response) {
	if (response.body === null) throw new Error("Gemini OAuth response has no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const part = await reader.read();
			buffer += decoder.decode(part.value ?? /* @__PURE__ */ new Uint8Array(), { stream: !part.done });
			const events = buffer.split(/\r?\n\r?\n/);
			buffer = events.pop() ?? "";
			for (const event of events) {
				const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
				if (data.length === 0 || data === "[DONE]") continue;
				yield JSON.parse(data);
			}
			if (part.done) break;
		}
		const data = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
		if (data.length > 0 && data !== "[DONE]") yield JSON.parse(data);
	} finally {
		await reader.cancel().catch(() => void 0);
	}
}
function appendText(stream, output, part, current) {
	if (part.text === void 0) return;
	const thinking = part.thought === true;
	if (current.value === null || thinking && current.value.type !== "thinking" || !thinking && current.value.type !== "text") {
		if (current.value?.type === "text") stream.push({
			type: "text_end",
			contentIndex: output.content.length - 1,
			content: current.value.text,
			partial: output
		});
		else if (current.value?.type === "thinking") stream.push({
			type: "thinking_end",
			contentIndex: output.content.length - 1,
			content: current.value.thinking,
			partial: output
		});
		if (thinking) {
			current.value = {
				type: "thinking",
				thinking: ""
			};
			output.content.push(current.value);
			stream.push({
				type: "thinking_start",
				contentIndex: output.content.length - 1,
				partial: output
			});
		} else {
			current.value = {
				type: "text",
				text: ""
			};
			output.content.push(current.value);
			stream.push({
				type: "text_start",
				contentIndex: output.content.length - 1,
				partial: output
			});
		}
	}
	if (current.value.type === "thinking") {
		current.value.thinking += part.text;
		current.value.thinkingSignature = retainThoughtSignature(current.value.thinkingSignature, part.thoughtSignature);
		stream.push({
			type: "thinking_delta",
			contentIndex: output.content.length - 1,
			delta: part.text,
			partial: output
		});
	} else {
		current.value.text += part.text;
		current.value.textSignature = retainThoughtSignature(current.value.textSignature, part.thoughtSignature);
		stream.push({
			type: "text_delta",
			contentIndex: output.content.length - 1,
			delta: part.text,
			partial: output
		});
	}
}
function createOutput(model) {
	return {
		role: "assistant",
		content: [],
		api: "google-generative-ai",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0
			}
		},
		stopReason: "pending",
		timestamp: Date.now()
	};
}
function streamOAuth(model, context, options) {
	const stream = createAssistantMessageEventStream();
	(async () => {
		const output = createOutput(model);
		try {
			const requestBody = payload(model, context, options);
			const nextPayload = await options.onPayload?.(requestBody, model);
			const response = await fetch(requestURL(model), {
				method: "POST",
				headers: headers(options),
				body: JSON.stringify(nextPayload ?? requestBody),
				signal: options.signal
			});
			if (!response.ok) throw new Error(`Gemini OAuth request failed (HTTP ${response.status})`);
			stream.push({
				type: "start",
				partial: output
			});
			const current = { value: null };
			for await (const chunk of sse(response)) {
				output.responseId ||= chunk.responseId;
				const candidate = chunk.candidates?.[0];
				for (const part of candidate?.content?.parts ?? []) {
					appendText(stream, output, part, current);
					if (part.functionCall !== void 0) {
						if (current.value?.type === "text") stream.push({
							type: "text_end",
							contentIndex: output.content.length - 1,
							content: current.value.text,
							partial: output
						});
						if (current.value?.type === "thinking") stream.push({
							type: "thinking_end",
							contentIndex: output.content.length - 1,
							content: current.value.thinking,
							partial: output
						});
						current.value = null;
						const providedId = part.functionCall.id;
						const existing = output.content.some((block) => block.type === "toolCall" && block.id === providedId);
						const toolCall = {
							type: "toolCall",
							id: providedId && !existing ? providedId : `${part.functionCall.name ?? "tool"}_${Date.now()}_${++toolCallCounter}`,
							name: part.functionCall.name ?? "",
							arguments: part.functionCall.args ?? {},
							...part.thoughtSignature === void 0 ? {} : { thoughtSignature: part.thoughtSignature }
						};
						output.content.push(toolCall);
						stream.push({
							type: "toolcall_start",
							contentIndex: output.content.length - 1,
							partial: output
						});
						stream.push({
							type: "toolcall_delta",
							contentIndex: output.content.length - 1,
							delta: JSON.stringify(toolCall.arguments),
							partial: output
						});
						stream.push({
							type: "toolcall_end",
							contentIndex: output.content.length - 1,
							toolCall,
							partial: output
						});
					}
				}
				if (candidate?.finishReason !== void 0) {
					output.stopReason = mapStopReasonString(candidate.finishReason);
					if (output.content.some((block) => block.type === "toolCall")) output.stopReason = "toolUse";
				}
				const usage = chunk.usageMetadata;
				if (usage !== void 0) {
					output.usage = {
						input: (usage.promptTokenCount ?? 0) - (usage.cachedContentTokenCount ?? 0),
						output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
						cacheRead: usage.cachedContentTokenCount ?? 0,
						cacheWrite: 0,
						totalTokens: usage.totalTokenCount ?? 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0
						}
					};
					calculateCost(model, output.usage);
				}
			}
			if (current.value?.type === "text") stream.push({
				type: "text_end",
				contentIndex: output.content.length - 1,
				content: current.value.text,
				partial: output
			});
			if (current.value?.type === "thinking") stream.push({
				type: "thinking_end",
				contentIndex: output.content.length - 1,
				content: current.value.thinking,
				partial: output
			});
			if (options.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "pending") throw new Error("Gemini OAuth stream ended without a finish reason");
			if (output.stopReason === "error" || output.stopReason === "aborted") throw new Error("Gemini OAuth response was not successful");
			stream.push({
				type: "done",
				reason: output.stopReason,
				message: output
			});
			stream.end();
		} catch (error) {
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : "Gemini OAuth request failed";
			stream.push({
				type: "error",
				reason: output.stopReason,
				error: output
			});
			stream.end();
		}
	})();
	return stream;
}
function geminiOAuthApi() {
	return {
		stream: (model, context, options) => streamOAuth(model, context, options ?? {}),
		streamSimple: (model, context, options) => streamOAuth(model, context, options ?? {})
	};
}
function geminiOAuthRoute(route) {
	return route.authKind === "gemini-oauth" ? geminiOAuthApi() : void 0;
}
//#endregion
//#region src/provider.ts
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const CODEX_REASONING_MODEL = /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$)|codex(?:[.-]|$))/i;
const CODEX_THINKING_LEVELS = {
	off: null,
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null
};
function routeApi(route) {
	switch (route.protocol) {
		case "anthropic-messages": return anthropicMessagesApi();
		case "openai-completions": return openAICompletionsApi();
		case "openai-responses": return openAIResponsesApi();
		case "google-generative-ai": return googleGenerativeAIApi();
	}
}
function routeModels(route) {
	return route.models.map((model) => {
		const reasoning = route.appType === "codex" && CODEX_REASONING_MODEL.test(model.id);
		return {
			id: model.id,
			name: model.name,
			api: route.protocol,
			provider: route.provider,
			baseUrl: route.baseURL,
			reasoning,
			...reasoning ? { thinkingLevelMap: CODEX_THINKING_LEVELS } : {},
			input: ["text", "image"],
			cost: NO_COST,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens
		};
	});
}
/**
* A provider auth method is intentionally only a transport hook. The adapter
* passes a freshly resolved CC Switch credential through `apiKey` for every
* request, while this resolver keeps pi-ai's Models collection stateless.
*/
function ccswitchApiKeyAuth() {
	return {
		name: "CC Switch",
		resolve: ({ credential }) => Promise.resolve({
			auth: credential?.key === void 0 ? {} : { apiKey: credential.key },
			source: "CC Switch"
		})
	};
}
function buildProvider(route) {
	const oauthApi = geminiOAuthRoute(route);
	return createProvider({
		id: route.provider,
		name: route.name,
		baseUrl: route.baseURL,
		auth: { apiKey: ccswitchApiKeyAuth() },
		models: routeModels(route),
		api: oauthApi ?? routeApi(route)
	});
}
//#endregion
//#region src/adapter.ts
/** Stop consuming a stream that has produced no event for this long. */
const STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Total inline base64 bytes one request may carry before images must be offloaded. */
const MAX_REQUEST_IMAGE_BYTES = 20971520;
/** Projection budget applied to one prepared request image. */
const REQUEST_IMAGE_PIXEL_BUDGET = 4194304;
const REQUEST_IMAGE_MAX_BYTES = 1048576;
function requestHeaders(route, token, extra) {
	const headers = { ...extra };
	if (route.authKind === "claude-token") {
		headers.authorization = `Bearer ${token}`;
		headers["x-api-key"] = null;
	} else if (route.authKind === "gemini-oauth") {
		headers.authorization = `Bearer ${token}`;
		headers["x-goog-api-key"] = null;
	} else if (route.authKind === "codex-oauth") {
		headers.authorization = `Bearer ${token}`;
		if (route.accountId !== void 0) headers["chatgpt-account-id"] = route.accountId;
		headers.originator = "cc-switch";
	}
	const attribution = attributionHeaders();
	const reserved = new Set(Object.keys(attribution).map((key) => key.toLowerCase()));
	for (const key of Object.keys(headers)) if (reserved.has(key.toLowerCase())) delete headers[key];
	return {
		...headers,
		...attribution
	};
}
function modelInfo(model) {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		inputModalities: [...model.input]
	};
}
/**
* The configured default this exact model can actually take, for DESCRIBING it.
* A level the model does not support yields none rather than throwing: the
* catalog feeds every picker, so one mis-set configuration field must not hide
* every model on the route. The request path still refuses.
*/
function describableReasoningLevel(model, effort) {
	if (effort === void 0) return void 0;
	return getSupportedThinkingLevels(model).some((level) => level === effort) ? effort : void 0;
}
function reasoningInfo(model, defaultLevel) {
	if (!model.reasoning) return {};
	return { reasoning: {
		efforts: getSupportedThinkingLevels(model).map((level) => ({
			id: ReasoningEffortId(level),
			name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`
		})),
		...defaultLevel === void 0 ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) }
	} };
}
/** Validate an explicit effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(model, effort) {
	if (effort === void 0) return void 0;
	if (getSupportedThinkingLevels(model).some((level) => level === effort)) return effort;
	throw new LlmError(`CC Switch provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}
var CcSwitchAdapter = class extends LlmAdapter {
	repository;
	resolveAttachments;
	resolveImageAccess;
	snapshot;
	discovered = /* @__PURE__ */ new Map();
	discoveredRevision = 0;
	constructor(repository, resolveAttachments, resolveImageAccess) {
		super();
		this.repository = repository;
		this.resolveAttachments = resolveAttachments;
		this.resolveImageAccess = resolveImageAccess;
	}
	/** Publish endpoint-discovered models without touching the CC Switch DB. */
	setDiscoveredModels(provider, models) {
		if (models.length === 0) return;
		const previous = this.discovered.get(provider);
		if (previous !== void 0 && previous.length === models.length && previous.every((model, index) => model.id === models[index]?.id && model.contextWindow === models[index]?.contextWindow && model.maxTokens === models[index]?.maxTokens)) return;
		this.discovered.set(provider, models.map((model) => ({ ...model })));
		this.discoveredRevision += 1;
		this.snapshot = void 0;
	}
	clearDiscoveredModels() {
		if (this.discovered.size === 0) return;
		this.discovered.clear();
		this.discoveredRevision += 1;
		this.snapshot = void 0;
	}
	current() {
		const source = this.repository.current;
		if (this.snapshot?.source === source && this.snapshot.revision === this.discoveredRevision) return this.snapshot;
		const models = createModels();
		const routes = new Map(source.routes.map((route) => {
			const discovered = this.discovered.get(route.provider);
			return [route.provider, discovered === void 0 ? route : {
				...route,
				models: discovered
			}];
		}));
		for (const route of routes.values()) models.setProvider(buildProvider(route));
		this.snapshot = {
			source,
			revision: this.discoveredRevision,
			models,
			routes
		};
		return this.snapshot;
	}
	route(snapshot, provider) {
		const route = snapshot.routes.get(provider);
		if (route === void 0) throw new LlmError(`CC Switch provider "${provider}" is not available`, "NO_ADAPTER");
		return route;
	}
	model(snapshot, provider, modelId) {
		this.route(snapshot, provider);
		const model = snapshot.models.getModel(provider, modelId);
		if (model === void 0) throw new LlmError(`CC Switch model "${modelId}" is not available`, "UNKNOWN_MODEL");
		return model;
	}
	modelInfo(snapshot, provider, modelId) {
		const model = this.model(snapshot, provider, modelId);
		const defaultLevel = describableReasoningLevel(model, this.repository.config.codexReasoningEffort);
		return {
			...modelInfo(model),
			context: { contextWindow: model.contextWindow },
			...reasoningInfo(model, defaultLevel)
		};
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.current().routes.get(provider)?.name ?? provider
		};
	}
	listModels(provider) {
		return Promise.resolve().then(() => {
			const snapshot = this.current();
			this.route(snapshot, provider);
			return snapshot.models.getModels(provider).map(modelInfo);
		});
	}
	resolveModel(provider, modelId, _signal) {
		return Promise.resolve().then(() => this.modelInfo(this.current(), provider, modelId));
	}
	/**
	* Capture the whole snapshot before the first await so a configuration change
	* reaches the next step, never the one in flight: `Models.streamSimple()` is
	* lazy, so it would otherwise resolve its provider after the credential await.
	*/
	prepareCall(provider, modelId, _signal) {
		return Promise.resolve().then(() => {
			const snapshot = this.current();
			return {
				model: this.modelInfo(snapshot, provider, modelId),
				stream: (options) => this.streamWithSnapshot(options, snapshot)
			};
		});
	}
	stream(options) {
		return this.streamWithSnapshot(options, this.current());
	}
	async *streamWithSnapshot(options, snapshot) {
		if (options.stop !== void 0) throw new LlmError("dsh-ccswitch does not support GenerateOptions.stop", "UNSUPPORTED_OPTION");
		const route = this.route(snapshot, options.provider);
		const model = this.model(snapshot, options.provider, options.model);
		const reasoning = resolveReasoningLevel(model, options.reasoningEffort ?? (model.reasoning ? this.repository.config.codexReasoningEffort : void 0));
		const credential = await resolveCredential(route, this.repository);
		const consumer = new AbortController();
		const upstream = options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
		const watchdog = idleWatchdog(upstream, STREAM_IDLE_TIMEOUT_MS, "LLM_STREAM_IDLE_TIMEOUT");
		try {
			const containsImage = options.messages.some((message) => contentHasImage(message.content));
			if (containsImage && !model.input.includes("image")) throw new LlmError(`CC Switch model "${model.id}" does not support image input`, "UNSUPPORTED_CONTENT");
			const attachments = containsImage ? this.resolveAttachments?.() : void 0;
			if (containsImage && attachments === void 0) throw new LlmError("CC Switch image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
			const context = attachments === void 0 ? toPiContext(options, void 0) : await toPiContext({
				...options,
				signal: watchdog.signal
			}, {
				attachments,
				...this.resolveImageAccess === void 0 ? {} : { resolveImageAccess: (ref) => this.resolveImageAccess?.(attachments, ref) },
				maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
				requestImagePolicy: {
					maxPixels: REQUEST_IMAGE_PIXEL_BUDGET,
					maxBytes: REQUEST_IMAGE_MAX_BYTES
				}
			});
			const streamOptions = {
				apiKey: credential.token,
				headers: requestHeaders(route, credential.token ?? "", credential.headers),
				signal: watchdog.signal,
				...options.temperature === void 0 ? {} : { temperature: options.temperature },
				...options.maxTokens === void 0 ? {} : { maxTokens: options.maxTokens },
				...options.sessionId === void 0 ? {} : { sessionId: String(options.sessionId) },
				...reasoning === void 0 || reasoning === "off" ? {} : { reasoning },
				maxRetries: 0
			};
			const iterator = toStreamChunks(snapshot.models.streamSimple(model, context, streamOptions), model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]();
			let exhausted = false;
			try {
				for (;;) {
					const result = await watchdog.next(iterator);
					const timeout = timeoutOf(watchdog.signal, "LLM_STREAM_IDLE_TIMEOUT");
					if (timeout !== void 0) throw timeout;
					if (result.done) {
						exhausted = true;
						return;
					}
					yield result.value;
				}
			} finally {
				if (!exhausted) {
					consumer.abort("pi-ai stream consumer stopped");
					try {
						await iterator.return(void 0);
					} catch {}
				}
			}
		} catch (error) {
			if (timeoutOf(watchdog.signal, "LLM_STREAM_IDLE_TIMEOUT") !== void 0) throw new LlmError(`pi-ai stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`, "TIMEOUT", { cause: error });
			if (options.signal?.aborted) throw new LlmError("pi-ai request aborted by caller", "ABORTED", { cause: error });
			throw error;
		} finally {
			consumer.abort("pi-ai stream consumer stopped");
			watchdog[Symbol.dispose]();
		}
	}
};
//#endregion
//#region src/selection.ts
const DEFAULT_PROVIDER_SELECTION_PATH = resolveCcSwitchPaths().providerSelection;
function strings(value) {
	if (!Array.isArray(value)) return void 0;
	return value.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0);
}
function envSelectors() {
	if (process.env.DSH_CCSWITCH_PROVIDERS === void 0) return void 0;
	return process.env.DSH_CCSWITCH_PROVIDERS.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}
/** Read the user-level provider allow-list. Invalid or missing files mean no selection. */
function readProviderSelectors(path) {
	const env = envSelectors();
	if (env !== void 0) return env;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (Array.isArray(parsed)) return strings(parsed);
		if (parsed !== null && typeof parsed === "object") {
			const object = parsed;
			return strings(object.include) ?? strings(object.providers);
		}
	} catch {}
}
function globRegex(pattern) {
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}
function matches(route, selector) {
	const values = [
		route.provider,
		route.sourceId,
		route.name,
		`${route.appType}/${route.sourceId}`
	];
	const regex = globRegex(selector);
	return values.some((value) => regex.test(value));
}
/** Keep a route when the configured selector list names it. */
function providerSelected(route, selectors) {
	return selectors === void 0 || selectors.some((selector) => matches(route, selector));
}
//#endregion
//#region src/database.ts
const APP_TYPES = [
	"claude",
	"codex",
	"gemini"
];
const DEFAULT_CONTEXT_WINDOW$1 = 262144;
const DEFAULT_MAX_TOKENS$1 = 32768;
const CODEX_REASONING_EFFORTS = [
	"minimal",
	"low",
	"medium",
	"high"
];
function objectValue(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function nonEmpty(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function configuredCodexReasoningEffort(value) {
	const normalized = value?.trim().toLowerCase();
	if (normalized === void 0 || normalized.length === 0) return "minimal";
	if (normalized === "provider") return void 0;
	if (CODEX_REASONING_EFFORTS.includes(normalized)) return normalized;
	throw new Error("DSH_CCSWITCH_CODEX_REASONING must be provider, minimal, low, medium, or high");
}
function jsonObject(raw) {
	try {
		return objectValue(JSON.parse(raw));
	} catch {
		return {};
	}
}
function hash(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function envValue(settings, name) {
	return nonEmpty(objectValue(settings.env)[name]);
}
function settingValue(settings, ...names) {
	for (const name of names) {
		const value = nonEmpty(settings[name]);
		if (value !== void 0) return value;
	}
}
function authBindingAccount(meta, provider) {
	const binding = objectValue(meta.authBinding);
	const source = nonEmpty(binding.source);
	const authProvider = nonEmpty(binding.auth_provider) ?? nonEmpty(binding.authProvider);
	if (source === "managed_account" && authProvider === provider) return nonEmpty(binding.account_id) ?? nonEmpty(binding.accountId);
}
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function codexConfigValue(config, key) {
	return nonEmpty(config.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*[\"']([^\"']+)[\"']`, "m"))?.[1]);
}
function codexProviderConfig(config) {
	const providerId = codexConfigValue(config, "model_provider");
	if (providerId === void 0) return {};
	const section = config.match(new RegExp(`\\[model_providers\\.${escapeRegExp(providerId)}\\]([\\s\\S]*?)(?=\\n\\[|$)`))?.[1] ?? "";
	const baseURL = codexConfigValue(section, "base_url");
	const wireApi = codexConfigValue(section, "wire_api");
	return {
		...baseURL === void 0 ? {} : { baseURL },
		protocol: wireApi === "chat" || wireApi === "completions" ? "openai-completions" : "openai-responses"
	};
}
function stripGeminiModelPrefix(id) {
	return id.replace(/^models\//, "").trim();
}
function defaultModel(settings, appType) {
	const env = objectValue(settings.env);
	return (appType === "claude" ? nonEmpty(settings.model) ?? nonEmpty(env.ANTHROPIC_MODEL) : appType === "codex" ? codexConfigValue(nonEmpty(settings.config) ?? "", "model") : nonEmpty(env.GEMINI_MODEL) ?? nonEmpty(settings.model)) ?? (appType === "claude" ? "claude-sonnet-4-5" : appType === "codex" ? "gpt-5.5" : "gemini-2.5-flash");
}
function parseConfiguredAuth(settings, meta, appType, providerType) {
	if (appType === "claude") return { kind: envValue(settings, "ANTHROPIC_AUTH_TOKEN") === void 0 ? "api-key" : "claude-token" };
	if (appType === "codex") {
		const auth = objectValue(settings.auth);
		const mode = nonEmpty(auth.auth_mode) ?? nonEmpty(auth.authMode);
		const accountId = authBindingAccount(meta, "codex_oauth");
		if (providerType === "codex_oauth" || mode === "chatgpt" || accountId !== void 0) return {
			kind: "codex-oauth",
			...accountId === void 0 ? {} : { accountId }
		};
		return { kind: "api-key" };
	}
	const config = objectValue(settings.config);
	const auth = objectValue(objectValue(config.security).auth);
	const selected = nonEmpty(config.selectedAuthType) ?? nonEmpty(auth.selectedType);
	const configuredKey = envValue(settings, "GEMINI_API_KEY") ?? settingValue(settings, "apiKey", "api_key");
	if (providerType === "gemini_cli" || providerType === "gemini-oauth" || selected === "oauth-personal" || selected === "oauth" || selected === "google-oauth" || configuredKey?.startsWith("ya29.") === true || configuredKey?.startsWith("{") === true) return { kind: "gemini-oauth" };
	return { kind: "api-key" };
}
function routeFromRow(row, endpoint) {
	if (!APP_TYPES.includes(row.app_type)) return void 0;
	const appType = row.app_type;
	const settings = jsonObject(row.settings_config);
	const meta = jsonObject(row.meta);
	const providerType = nonEmpty(row.provider_type) ?? nonEmpty(meta.providerType) ?? nonEmpty(meta.provider_type);
	const codex = appType === "codex" ? codexProviderConfig(nonEmpty(settings.config) ?? "") : {};
	const auth = parseConfiguredAuth(settings, meta, appType, providerType);
	const hasInlineCredential = appType === "claude" ? envValue(settings, "ANTHROPIC_AUTH_TOKEN") !== void 0 || envValue(settings, "ANTHROPIC_API_KEY") !== void 0 || settingValue(settings, "apiKey", "api_key") !== void 0 : appType === "codex" ? nonEmpty(objectValue(settings.auth).OPENAI_API_KEY) !== void 0 || settingValue(settings, "OPENAI_API_KEY", "apiKey", "api_key") !== void 0 : envValue(settings, "GEMINI_API_KEY") !== void 0 || settingValue(settings, "apiKey", "api_key") !== void 0;
	const defaultBaseURL = auth.kind === "codex-oauth" ? "https://chatgpt.com/backend-api/codex" : auth.kind === "gemini-oauth" ? "https://generativelanguage.googleapis.com/v1beta" : hasInlineCredential ? appType === "claude" ? "https://api.anthropic.com" : appType === "codex" ? "https://api.openai.com/v1" : "https://generativelanguage.googleapis.com/v1beta" : void 0;
	const baseURL = appType === "claude" ? envValue(settings, "ANTHROPIC_BASE_URL") ?? settingValue(settings, "base_url", "baseURL") ?? endpoint ?? defaultBaseURL : appType === "codex" ? codex.baseURL ?? settingValue(settings, "base_url", "baseURL") ?? endpoint ?? defaultBaseURL : envValue(settings, "GOOGLE_GEMINI_BASE_URL") ?? settingValue(settings, "base_url", "baseURL") ?? endpoint ?? defaultBaseURL;
	if (baseURL === void 0) return void 0;
	const model = defaultModel(settings, appType);
	const sourceId = row.id.trim();
	if (sourceId.length === 0 || model.length === 0) return void 0;
	return {
		route: {
			provider: `ccswitch/${appType}/${sourceId}`,
			sourceId,
			appType,
			name: row.name.trim() || sourceId,
			baseURL: baseURL.replace(/\/$/, ""),
			protocol: appType === "claude" ? "anthropic-messages" : appType === "gemini" ? "google-generative-ai" : codex.protocol ?? "openai-responses",
			defaultModel: stripGeminiModelPrefix(model),
			models: [{
				id: stripGeminiModelPrefix(model),
				name: stripGeminiModelPrefix(model),
				contextWindow: DEFAULT_CONTEXT_WINDOW$1,
				maxTokens: DEFAULT_MAX_TOKENS$1
			}],
			authKind: auth.kind,
			...auth.accountId === void 0 ? {} : { accountId: auth.accountId },
			fingerprint: hash({
				id: sourceId,
				appType,
				name: row.name,
				settings: row.settings_config,
				meta: row.meta,
				providerType,
				endpoint
			})
		},
		record: {
			id: sourceId,
			appType,
			settings,
			meta,
			...providerType === void 0 ? {} : { providerType }
		}
	};
}
var CcSwitchRepository = class {
	config;
	records = /* @__PURE__ */ new Map();
	snapshot = {
		version: 0,
		fingerprint: "",
		routes: []
	};
	constructor(options = {}) {
		const defaults = resolveCcSwitchPaths();
		const dbPath = options.dbPath ?? process.env.DSH_CCSWITCH_DB ?? defaults.database;
		const requestedApps = options.appTypes ?? APP_TYPES;
		const codexReasoningEffort = options.codexReasoningEffort ?? configuredCodexReasoningEffort(process.env.DSH_CCSWITCH_CODEX_REASONING);
		this.config = {
			dbPath,
			pollIntervalMs: Math.max(500, options.pollIntervalMs ?? 2e3),
			appTypes: APP_TYPES.filter((app) => requestedApps.includes(app)),
			discoverModels: options.discoverModels ?? true,
			...options.providerSelectors === void 0 ? {} : { providerSelectors: options.providerSelectors },
			providerSelectionPath: options.providerSelectionPath ?? process.env.DSH_CCSWITCH_PROVIDERS_FILE ?? DEFAULT_PROVIDER_SELECTION_PATH,
			...codexReasoningEffort === void 0 ? {} : { codexReasoningEffort }
		};
	}
	get current() {
		return this.snapshot;
	}
	read() {
		const db = new DatabaseSync(this.config.dbPath, { readOnly: true });
		try {
			const providers = db.prepare("SELECT id, app_type, name, settings_config, meta, provider_type FROM providers ORDER BY app_type, sort_index, id").all();
			const endpoints = db.prepare("SELECT provider_id, app_type, url FROM provider_endpoints ORDER BY id").all();
			const endpointMap = /* @__PURE__ */ new Map();
			for (const endpoint of endpoints) {
				const key = `${endpoint.app_type}:${endpoint.provider_id}`;
				if (!endpointMap.has(key) && nonEmpty(endpoint.url) !== void 0) endpointMap.set(key, endpoint.url.trim());
			}
			const nextRecords = /* @__PURE__ */ new Map();
			const routes = [];
			const selectors = this.config.providerSelectors ?? readProviderSelectors(this.config.providerSelectionPath);
			for (const row of providers) {
				const appType = row.app_type;
				if (!this.config.appTypes.includes(appType)) continue;
				const result = routeFromRow(row, endpointMap.get(`${row.app_type}:${row.id}`));
				if (result === void 0) continue;
				if (!providerSelected(result.route, selectors)) continue;
				routes.push(result.route);
				nextRecords.set(`${appType}:${row.id}`, result.record);
			}
			const fingerprint = hash(routes.map((route) => route.fingerprint));
			if (fingerprint === this.snapshot.fingerprint) return false;
			this.records = nextRecords;
			this.snapshot = {
				version: this.snapshot.version + 1,
				fingerprint,
				routes
			};
			return true;
		} finally {
			db.close();
		}
	}
	record(route) {
		return this.records.get(`${route.appType}:${route.sourceId}`);
	}
	exists() {
		try {
			return statSync(this.config.dbPath).isFile();
		} catch {
			return false;
		}
	}
};
//#endregion
//#region src/discovery.ts
const MAX_BYTES = 2097152;
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 32768;
function text(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function positive(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : void 0;
}
function listURL(route) {
	if (route.appType === "codex" && route.authKind === "codex-oauth") return "https://chatgpt.com/backend-api/codex/models";
	const base = route.baseURL.replace(/\/+$/, "");
	return route.appType === "gemini" && !base.endsWith("/v1beta") ? `${base}/v1beta/models` : `${base}/models`;
}
async function boundedJSON(response) {
	if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("model listing is too large");
	if (response.body === null) return void 0;
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			total += part.value.byteLength;
			if (total > MAX_BYTES) throw new Error("model listing is too large");
			chunks.push(part.value);
		}
	} finally {
		await reader.cancel().catch(() => void 0);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(bytes));
}
function entries(body) {
	if (Array.isArray(body)) return body;
	if (body !== null && typeof body === "object") {
		const record = body;
		for (const key of [
			"data",
			"models",
			"items"
		]) if (Array.isArray(record[key])) return record[key];
		if (record.models !== null && typeof record.models === "object") return Object.entries(record.models).map(([id, value]) => ({
			...value !== null && typeof value === "object" ? value : {},
			id
		}));
		return Object.entries(record).map(([id, value]) => ({
			...value !== null && typeof value === "object" ? value : {},
			id
		}));
	}
	return [];
}
function parseModel(route, value) {
	const record = value !== null && typeof value === "object" ? value : {};
	const id = text(record.slug) ?? text(record.id) ?? text(record.model) ?? text(record.name)?.replace(/^models\//, "");
	if (id === void 0) return void 0;
	const contextWindow = positive(record.context_window) ?? positive(record.contextWindow) ?? positive(record.context_length) ?? positive(record.input_token_limit) ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = positive(record.max_output_tokens) ?? positive(record.maxTokens) ?? positive(record.output_token_limit) ?? DEFAULT_MAX_TOKENS;
	return {
		id: id.replace(/^models\//, ""),
		name: text(record.display_name) ?? text(record.displayName) ?? id,
		contextWindow,
		maxTokens
	};
}
function authHeaders(route, credential) {
	const headers = {
		accept: "application/json",
		...credential.headers
	};
	if (route.authKind === "api-key" && credential.token !== void 0) {
		if (route.appType === "claude") headers["x-api-key"] = credential.token;
		else if (route.appType === "gemini") headers["x-goog-api-key"] = credential.token;
		else headers.authorization = `Bearer ${credential.token}`;
	} else if (credential.token !== void 0 && route.appType !== "gemini") headers.authorization ??= `Bearer ${credential.token}`;
	return headers;
}
async function discoverRouteModels(route, credential, signal) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort("discovery timeout"), 5e3);
	const requestSignal = signal === void 0 ? controller.signal : AbortSignal.any([signal, controller.signal]);
	try {
		const response = await fetch(listURL(route), {
			headers: authHeaders(route, credential),
			signal: requestSignal
		});
		if (!response.ok) throw new Error(`model listing returned HTTP ${response.status}`);
		const models = entries(await boundedJSON(response)).map((value) => parseModel(route, value)).filter((model) => model !== void 0);
		const unique = new Map(models.map((model) => [model.id, model]));
		return unique.size > 0 ? [...unique.values()] : route.models;
	} finally {
		clearTimeout(timer);
	}
}
//#endregion
//#region src/index.ts
const name = "dsh-ccswitch";
const inject = ["llm"];
const DISCOVERY_RETRY_MS = 3e4;
function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}
function apply(ctx) {
	const repository = new CcSwitchRepository();
	const adapter = new CcSwitchAdapter(repository, () => ctx.get("attachments"), (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath), ref));
	let registration;
	let registeredRoutes = [];
	let refreshing = false;
	let lastDiscoveryAt = 0;
	const syncRegistration = () => {
		const routes = repository.current.routes.map((route) => route.provider);
		if (routes.length === 0) {
			if (registration !== void 0 && registeredRoutes.length > 0) {
				registration.replace([]);
				registeredRoutes = [];
			}
			return;
		}
		if (registration === void 0) registration = ctx.llm.registerAdapter([...routes], adapter);
		else if (routes.join("\n") !== registeredRoutes.join("\n")) registration.replace([...routes]);
		registeredRoutes = routes;
	};
	const discover = async () => {
		if (!repository.config.discoverModels || refreshing) return;
		refreshing = true;
		const source = repository.current;
		try {
			for (const route of source.routes) try {
				const models = await discoverRouteModels(route, await resolveCredential(route, repository));
				if (repository.current.routes.find((candidate) => candidate.provider === route.provider)?.fingerprint === route.fingerprint) adapter.setDiscoveredModels(route.provider, models);
			} catch (error) {
				ctx.logger.debug(`dsh-ccswitch: model discovery skipped for ${route.provider}: ${describeError(error)}`);
			}
		} finally {
			refreshing = false;
			lastDiscoveryAt = Date.now();
		}
	};
	const poll = () => {
		try {
			if (!repository.exists()) return;
			const changed = repository.read();
			if (changed) adapter.clearDiscoveredModels();
			syncRegistration();
			if (changed || Date.now() - lastDiscoveryAt >= DISCOVERY_RETRY_MS) discover();
		} catch (error) {
			ctx.logger.warn(`dsh-ccswitch: CC Switch configuration read failed: ${describeError(error)}`);
		}
	};
	try {
		if (repository.exists()) {
			repository.read();
			syncRegistration();
			lastDiscoveryAt = 0;
			discover();
		} else ctx.logger.info(`dsh-ccswitch: CC Switch database not found at ${repository.config.dbPath}`);
	} catch (error) {
		ctx.logger.warn(`dsh-ccswitch: initial provider discovery failed: ${describeError(error)}`);
	}
	ctx.effect(function* () {
		const timer = setInterval(poll, repository.config.pollIntervalMs);
		yield () => clearInterval(timer);
	});
}
//#endregion
export { apply, inject, name };
