/**
 * Exa API client — direct API + MCP fallback
 *
 * Supports two modes:
 * 1. Direct API (EXA_API_KEY set): Uses Exa's /answer and /search endpoints
 * 2. MCP fallback (no key): Uses Exa's free MCP endpoint at mcp.exa.ai
 *
 * When the monthly API budget is exhausted, automatically falls back to MCP.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
const USAGE_PATH = join(homedir(), ".pi", "exa-usage.json");

const MONTHLY_LIMIT = 1000;
const WARNING_THRESHOLD = 800;
const REQUEST_TIMEOUT_MS = 60_000;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ExaSearchOptions {
	numResults?: number;
	includeContent?: boolean;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	type?: "auto" | "keyword" | "neural";
	category?: "news" | "research paper" | "github" | "tweet" | "movie" | "song" | "personal site" | "pdf";
	signal?: AbortSignal;
}

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface InlineContent {
	url: string;
	title: string;
	content: string;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
	inlineContent?: InlineContent[];
}

interface ExaAnswerResponse {
	answer?: string;
	citations?: Array<{ url?: string; title?: string; text?: string; publishedDate?: string }>;
}

interface ExaSearchResponse {
	requestId?: string;
	results?: Array<{
		title?: string;
		url?: string;
		publishedDate?: string;
		author?: string;
		score?: number;
		id?: string;
		text?: string;
		highlights?: unknown;
		highlightScores?: number[];
	}>;
}

interface ExaMcpRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: {
		code?: number;
		message?: string;
	};
}

type McpParsedResult = { title: string; url: string; content: string };

// ─── API Key Management ────────────────────────────────────────────────────

interface WebSearchConfig {
	exaApiKey?: unknown;
	[key: string]: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function invalidateConfigCache(): void {
	cachedConfig = null;
}

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		cachedConfig = JSON.parse(raw) as WebSearchConfig;
		return cachedConfig;
	} catch {
		cachedConfig = {};
		return cachedConfig;
	}
}

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function getApiKey(): string | null {
	return normalizeApiKey(process.env.EXA_API_KEY) ?? normalizeApiKey(loadConfig().exaApiKey);
}

// ─── Usage Tracking ────────────────────────────────────────────────────────

interface ExaUsage {
	month: string;
	count: number;
}

let warnedMonth: string | null = null;

function getCurrentMonth(): string {
	return new Date().toISOString().slice(0, 7);
}

function normalizeUsage(raw: unknown): ExaUsage {
	const month = getCurrentMonth();
	if (!raw || typeof raw !== "object") return { month, count: 0 };
	const data = raw as { month?: unknown; count?: unknown };
	const parsedMonth = typeof data.month === "string" ? data.month : month;
	const parsedCount = typeof data.count === "number" && Number.isFinite(data.count) ? data.count : 0;
	if (parsedMonth !== month) return { month, count: 0 };
	return { month: parsedMonth, count: Math.max(0, Math.floor(parsedCount)) };
}

function readUsage(): ExaUsage {
	if (!existsSync(USAGE_PATH)) return { month: getCurrentMonth(), count: 0 };
	try {
		return normalizeUsage(JSON.parse(readFileSync(USAGE_PATH, "utf-8")));
	} catch {
		return { month: getCurrentMonth(), count: 0 };
	}
}

function writeUsage(usage: ExaUsage): void {
	const dir = join(homedir(), ".pi");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2) + "\n");
}

function reserveRequestBudget(): { exhausted: true } | null {
	const usage = readUsage();
	if (usage.count >= MONTHLY_LIMIT) return { exhausted: true };
	const nextCount = usage.count + 1;
	if (nextCount >= WARNING_THRESHOLD && warnedMonth !== usage.month) {
		warnedMonth = usage.month;
		console.error(`[exa-search] Usage warning: ${nextCount}/${MONTHLY_LIMIT} monthly requests used.`);
	}
	writeUsage({ month: usage.month, count: nextCount });
	return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function recencyToStartDate(filter: string): string {
	const now = new Date();
	const offsets: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
	const days = offsets[filter] ?? 0;
	return new Date(now.getTime() - days * 86_400_000).toISOString();
}

function mapDomainFilter(
	domainFilter: string[] | undefined,
): { includeDomains?: string[]; excludeDomains?: string[] } {
	if (!domainFilter?.length) return {};
	const includeDomains = domainFilter
		.filter((d) => !d.startsWith("-") && d.trim().length > 0)
		.map((d) => d.trim());
	const excludeDomains = domainFilter
		.filter((d) => d.startsWith("-"))
		.map((d) => d.slice(1).trim())
		.filter(Boolean);
	return {
		...(includeDomains.length ? { includeDomains } : {}),
		...(excludeDomains.length ? { excludeDomains } : {}),
	};
}

function normalizeHighlights(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

// ─── Direct API: Answer Endpoint ───────────────────────────────────────────

async function searchWithExaAnswer(
	query: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<SearchResponse> {
	const response = await fetch("https://api.exa.ai/answer", {
		method: "POST",
		headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({ query, text: true }),
		signal: requestSignal(signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Exa API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	const data = (await response.json()) as ExaAnswerResponse;

	return {
		answer: data.answer || "",
		results: (data.citations ?? [])
			.filter((c) => c.url)
			.map((c) => ({
				title: c.title || "Source",
				url: c.url!,
				snippet: typeof c.text === "string" ? c.text.slice(0, 200) : "",
			})),
	};
}

// ─── Direct API: Search Endpoint ──────────────────────────────────────────

async function searchWithExaSearch(
	query: string,
	options: ExaSearchOptions,
	apiKey: string,
	signa?: AbortSignal,
): Promise<SearchResponse> {
	const startDate = options.recencyFilter ? recencyToStartDate(options.recencyFilter) : undefined;
	const domainFilters = mapDomainFilter(options.domainFilter);

	const body: Record<string, unknown> = {
		query,
		type: options.type ?? "auto",
		numResults: options.numResults ?? 5,
		...(domainFilters.includeDomains ? { includeDomains: domainFilters.includeDomains } : {}),
		...(domainFilters.excludeDomains ? { excludeDomains: domainFilters.excludeDomains } : {}),
		...(startDate ? { startPublishedDate: startDate } : {}),
		...(options.category ? { category: options.category } : {}),
		contents: {
			text: options.includeContent ? true : { maxCharacters: 3000 },
			highlights: true,
		},
	};

	const response = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: requestSignal(signa),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Exa API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	const data = (await response.json()) as ExaSearchResponse;
	const results = data.results ?? [];

	// Build a synthetic answer from search result content
	const contentParts: string[] = [];
	for (const item of results) {
		if (!item.url) continue;
		const highlights = normalizeHighlights(item.highlights);
		const content =
			highlights.length > 0
				? highlights.join(" ")
				: typeof item.text === "string"
					? item.text.trim().slice(0, 2000)
					: "";
		if (!content) continue;
		const sourceTitle = item.title || "Source";
		contentParts.push(`${content}\nSource: ${sourceTitle} (${item.url})`);
	}

	const mapped: SearchResponse = {
		answer: contentParts.join("\n\n"),
		results: results
			.filter((r) => r.url)
			.map((r) => ({
				title: r.title || "Source",
				url: r.url!,
				snippet: normalizeHighlights(r.highlights).slice(0, 2).join(" ") || "",
			})),
	};

	// Attach inline content if requested
	if (options.includeContent) {
		const inlineContent = results
			.filter((r): r is typeof r & { url: string } => !!r?.url && typeof r.text === "string" && r.text.length > 0)
			.map((r) => ({
				url: r.url,
				title: r.title || "",
				content: r.text!,
			}));
		if (inlineContent.length > 0) mapped.inlineContent = inlineContent;
	}

	return mapped;
}

// ─── MCP Fallback ──────────────────────────────────────────────────────────

async function callExaMcp(
	toolName: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<string> {
	const response = await fetch("https://mcp.exa.ai/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: toolName, arguments: args },
		}),
		signal: requestSignal(signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Exa MCP error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	const body = await response.text();
	const dataLines = body.split("\n").filter((line) => line.startsWith("data:"));

	// Try SSE first
	let parsed: ExaMcpRpcResponse | null = null;
	for (const line of dataLines) {
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const candidate = JSON.parse(payload) as ExaMcpRpcResponse;
			if (candidate?.result || candidate?.error) {
				parsed = candidate;
				break;
			}
		} catch {
			// skip
		}
	}

	// Fall back to plain JSON
	if (!parsed) {
		try {
			const candidate = JSON.parse(body) as ExaMcpRpcResponse;
			if (candidate?.result || candidate?.error) parsed = candidate;
		} catch {
			// skip
		}
	}

	if (!parsed) throw new Error("Exa MCP returned an empty response");
	if (parsed.error) {
		const code = typeof parsed.error.code === "number" ? ` ${parsed.error.code}` : "";
		throw new Error(`Exa MCP error${code}: ${parsed.error.message || "Unknown error"}`);
	}
	if (parsed.result?.isError) {
		const message =
			parsed.result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text?.trim() ||
			"Exa MCP returned an error";
		throw new Error(message);
	}

	const text = parsed.result?.content?.find(
		(item) => item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0,
	)?.text;

	if (!text) throw new Error("Exa MCP returned empty content");
	return text;
}

function parseMcpResults(text: string): McpParsedResult[] {
	const blocks = text.split(/(?=^Title: )/m).filter((b) => b.trim().length > 0);
	const parsed = blocks
		.map((block) => {
			const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
			const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
			let content = "";
			const textStart = block.indexOf("\nText: ");
			if (textStart >= 0) {
				content = block.slice(textStart + 7).trim();
			} else {
				const hlMatch = block.match(/\nHighlights:\s*\n/);
				if (hlMatch?.index != null) {
					content = block.slice(hlMatch.index + hlMatch[0].length).trim();
				}
			}
			content = content.replace(/\n---\s*$/, "").trim();
			return { title, url, content };
		})
		.filter((result) => result.url.length > 0);
	return parsed.length > 0 ? parsed : [];
}

function buildAnswerFromMcpResults(results: McpParsedResult[]): string {
	if (results.length === 0) return "";
	const parts: string[] = [];
	for (const result of results) {
		const snippet = result.content.replace(/\s+/g, " ").trim().slice(0, 500);
		if (!snippet) continue;
		parts.push(`${snippet}\nSource: ${result.title || "Source"} (${result.url})`);
	}
	return parts.join("\n\n");
}

function buildMcpQuery(query: string, options: ExaSearchOptions): string {
	const parts = [query];
	if (options.domainFilter?.length) {
		for (const d of options.domainFilter) {
			parts.push(d.startsWith("-") ? `-site:${d.slice(1)}` : `site:${d}`);
		}
	}
	if (options.recencyFilter) {
		const now = new Date();
		switch (options.recencyFilter) {
			case "day":
				parts.push("past 24 hours");
				break;
			case "week":
				parts.push("past week");
				break;
			case "month":
				parts.push(`${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()}`);
				break;
			case "year":
				parts.push(String(now.getFullYear()));
				break;
		}
	}
	return parts.join(" ");
}

async function searchWithExaMcp(query: string, options: ExaSearchOptions = {}): Promise<SearchResponse | null> {
	const enrichedQuery = buildMcpQuery(query, options);

	const text = await callExaMcp(
		"web_search_exa",
		{
			query: enrichedQuery,
			numResults: options.numResults ?? 5,
			livecrawl: "fallback",
			type: options.type ?? "auto",
			contextMaxCharacters: options.includeContent ? 50000 : 3000,
			...(options.category ? { category: options.category } : {}),
		},
		options.signal,
	);

	const parsedResults = parseMcpResults(text);
	if (!parsedResults || parsedResults.length === 0) return null;

	const response: SearchResponse = {
		answer: buildAnswerFromMcpResults(parsedResults),
		results: parsedResults.map((result, i) => ({
			title: result.title || `Source ${i + 1}`,
			url: result.url,
			snippet: "",
		})),
	};

	if (options.includeContent) {
		const inlineContent = parsedResults
			.filter((r) => r.content.length > 0)
			.map((r) => ({
				url: r.url,
				title: r.title,
				content: r.content,
			}));
		if (inlineContent.length > 0) response.inlineContent = inlineContent;
	}

	return response;
}

// ─── Public API ────────────────────────────────────────────────────────────

export type ExaSearchResult = SearchResponse | { exhausted: true } | null;

/**
 * Check if Exa search is available (has API key with budget remaining, or MCP fallback).
 */
export function isExaAvailable(): boolean {
	if (getApiKey()) {
		const usage = readUsage();
		return usage.count < MONTHLY_LIMIT;
	}
	// MCP fallback is always available
	return true;
}

/**
 * Search with Exa — uses direct API if key is available, falls back to MCP otherwise.
 * Returns null if no results found, or { exhausted: true } if monthly API budget is spent.
 */
export async function searchWithExa(
	query: string,
	options: ExaSearchOptions = {},
): Promise<ExaSearchResult> {
	const apiKey = getApiKey();

	// MCP fallback when no API key
	if (!apiKey) {
		return searchWithExaMcp(query, options);
	}

	// Check monthly budget
	const budget = reserveRequestBudget();
	if (budget) return { exhausted: true };

	// Decide which endpoint to use:
	// - Answer endpoint: simple queries without content/domain/recency filters
	// - Search endpoint: complex queries that need more control
	const needsSearch =
		options.includeContent ||
		!!options.recencyFilter ||
		!!options.domainFilter?.length ||
		!!options.type ||
		!!options.category ||
		(options.numResults !== undefined && options.numResults !== 5);

	if (needsSearch) {
		return searchWithExaSearch(query, options, apiKey, options.signal);
	}

	// Try answer endpoint first, fall back to search on failure
	try {
		return await searchWithExaAnswer(query, apiKey, options.signal);
	} catch {
		// Answer endpoint might not work well for some queries, try search
		return searchWithExaSearch(query, options, apiKey, options.signal);
	}
}

/**
 * Get usage info for display.
 */
export function getUsageInfo(): {
	hasApiKey: boolean;
	usage: { month: string; count: number; monthlyLimit: number; warningThreshold: number };
} {
	return {
		hasApiKey: !!getApiKey(),
		usage: {
			month: readUsage().month,
			count: readUsage().count,
			monthlyLimit: MONTHLY_LIMIT,
			warningThreshold: WARNING_THRESHOLD,
		},
	};
}