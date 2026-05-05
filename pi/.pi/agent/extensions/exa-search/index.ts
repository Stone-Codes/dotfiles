/**
 * Exa Web Search Extension for Pi
 *
 * Provides semantic web search using Exa AI's API with:
 * - AI-synthesized answers with source citations
 * - Semantic search with full content retrieval
 * - Automatic MCP fallback when no API key is configured
 * - Usage tracking with monthly limits
 * - Domain filtering and recency filtering
 *
 * Configuration:
 *   Set EXA_API_KEY environment variable or add to ~/.pi/web-search.json:
 *   { "exaApiKey": "your-api-key" }
 *
 *   Also supports ~/.pi/settings.json:
 *   { "env": { "EXA_API_KEY": "your-api-key" } }
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { isExaAvailable, searchWithExa, type ExaSearchOptions, type SearchResponse } from "./exa-client";

export default function exaSearchExtension(pi: ExtensionAPI) {
	let searchAvailable = false;

	pi.on("session_start", async (_event, _ctx) => {
		searchAvailable = isExaAvailable();
		if (!searchAvailable) {
			console.warn("[exa-search] Search unavailable. Set EXA_API_KEY for direct API, or ensure MCP access for free tier.");
		}
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using Exa AI. Returns an AI-synthesized answer with source citations for each query. " +
			"For research tasks, prefer queries (plural) with 2-4 varied angles over a single query — each query gets " +
			"its own synthesized answer, so varying phrasing and scope gives much broader coverage. " +
			"Automatically uses Exa API when EXA_API_KEY is configured, or falls back to Exa MCP (free, no key needed) " +
			"when no key is available. Use includeContent to get full page text for detailed analysis.",
		promptSnippet:
			"Search the web for up-to-date information. Prefer {queries:[...]} with 2-4 varied angles for research.",
		promptGuidelines: [
			"Use web_search when the user asks about current events, news, or recent developments",
			"Use web_search when looking for technical documentation, tutorials, or API references",
			"Use web_search when the user asks about prices, availability, or product information",
			"Use web_search when you need to verify or supplement information with fresh sources",
			"Use web_search for questions about companies, people, or topics that may have changed recently",
			"Prefer web_search queries with 2-4 varied angles over a single query for research tasks",
			"Use includeContent: true when detailed page content is needed for analysis, not just summaries",
			"Use recencyFilter for time-sensitive topics like news or current software versions",
			"Use domainFilter to restrict or exclude specific domains (prefix with - to exclude)",
			"Do NOT use web_search for well-established knowledge (math, historical facts, programming basics) that you already know",
			"Do NOT use web_search when local tools (read, bash, grep) can answer the question",
		],
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Single search query. For research tasks, prefer 'queries' with multiple varied angles instead.",
				}),
			),
			queries: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Multiple queries searched in sequence, each returning its own synthesized answer. " +
						"Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize " +
						"coverage. Good: ['React vs Vue benchmarks 2026', 'React vs Vue DX comparison']. " +
						"Bad: ['React vs Vue', 'React vs Vue comparison'] (too similar, redundant results).",
				}),
			),
			numResults: Type.Optional(
				Type.Number({ description: "Results per query (default: 5, max: 20)", minimum: 1, maximum: 20 }),
			),
			includeContent: Type.Optional(
				Type.Boolean({
					description: "Fetch full page content for each result. Use when you need detailed text, not just snippets.",
				}),
			),
			recencyFilter: Type.Optional(
				StringEnum(["day", "week", "month", "year"], { description: "Filter results by recency" }),
			),
			domainFilter: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Limit results to specific domains. Prefix with - to exclude. " +
						"Example: ['github.com', '-medium.com'] includes GitHub, excludes Medium.",
				}),
			),
			type: Type.Optional(
				StringEnum(["auto", "keyword", "neural"], {
					description: "'auto' lets Exa choose (recommended), 'keyword' for exact matches, 'neural' for semantic search",
				}),
			),
			category: Type.Optional(
				StringEnum(["news", "research paper", "github", "tweet", "movie", "song", "personal site", "pdf"], {
					description: "Filter results by category for more targeted results",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const rawQueryList: string[] = Array.isArray(params.queries)
				? params.queries
				: params.query !== undefined
					? [params.query]
					: [];

			const queryList = rawQueryList.filter((q): q is string => typeof q === "string" && q.trim().length > 0);

			if (queryList.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "Error: No query provided. Use the 'query' parameter for a single search or 'queries' for multiple searches.",
						},
					],
					details: { error: "no_query" },
					isError: true,
				};
			}

			const options: ExaSearchOptions = {
				numResults: params.numResults ?? 5,
				includeContent: params.includeContent ?? false,
				recencyFilter: params.recencyFilter as ExaSearchOptions["recencyFilter"],
				domainFilter: params.domainFilter as ExaSearchOptions["domainFilter"],
				type: params.type as ExaSearchOptions["type"],
				category: params.category as ExaSearchOptions["category"],
				signal,
			};

			const results: SearchResponse[] = [];
			const errors: string[] = [];

			for (let i = 0; i < queryList.length; i++) {
				const query = queryList[i];
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Searching ${i + 1}/${queryList.length}: "${query}"...`,
						},
					],
					details: { phase: "searching", progress: i / queryList.length, currentQuery: query },
				});

				try {
					const result = await searchWithExa(query, options);

					// Handle monthly limit exhaustion
					if (result && "exhausted" in result && result.exhausted === true) {
						return {
							content: [
								{
									type: "text",
									text: "Exa API monthly request limit reached. The free MCP fallback has no limit — " +
										"consider removing your EXA_API_KEY to use the free MCP endpoint, or wait for the monthly reset.",
								},
							],
							details: { error: "monthly_limit_exhausted" },
							isError: true,
						};
					}

					if (!result) {
						errors.push(`No results for: "${query}"`);
						results.push({ answer: "", results: [] });
					} else {
						results.push(result);
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					errors.push(`Error searching "${query}": ${message}`);
					results.push({ answer: "", results: [] });
				}
			}

			// Build output
			let output = "";
			const allSourceUrls: string[] = [];

			for (let i = 0; i < results.length; i++) {
				const result = results[i];
				const query = queryList[i];

				if (queryList.length > 1) {
					output += `## Query: "${query}"\n\n`;
				}

				if (result.answer) {
					output += `${result.answer}\n\n`;
				}

				if (result.results.length > 0) {
					output += "**Sources:**\n";
					for (const source of result.results) {
						output += `- ${source.title}${source.url ? ` — ${source.url}` : ""}\n`;
						if (!allSourceUrls.includes(source.url)) {
							allSourceUrls.push(source.url);
						}
						if (source.snippet) {
							output += `  > ${source.snippet.slice(0, 200)}${source.snippet.length > 200 ? "..." : ""}\n`;
						}
					}
					output += "\n";
				} else if (!result.answer) {
					output += "No results found.\n\n";
				}

				if (result.inlineContent && result.inlineContent.length > 0) {
					output += `**Full content available for ${result.inlineContent.length} sources.**\n\n`;
					for (const content of result.inlineContent) {
						output += `### ${content.title || content.url}\n${content.content}\n\n`;
					}
				}
			}

			if (errors.length > 0 && results.every((r) => r.answer === "" && r.results.length === 0)) {
				return {
					content: [{ type: "text", text: `Search failed: ${errors.join("; ")}` }],
					details: { error: errors.join("; "), queryCount: queryList.length },
					isError: true,
				};
			}

			// Append errors as warnings if some queries succeeded
			if (errors.length > 0) {
				output += `---\n⚠️ Some queries had issues:\n${errors.map((e) => `- ${e}`).join("\n")}\n`;
			}

			const successCount = results.filter((r) => r.results.length > 0).length;
			const totalResults = results.reduce((sum, r) => sum + r.results.length, 0);

			return {
				content: [{ type: "text", text: output.trim() }],
				details: {
					queryCount: queryList.length,
					successfulQueries: successCount,
					totalResults,
					includeContent: params.includeContent ?? false,
					sourceUrls: allSourceUrls,
				},
			};
		},
	});

	// Status command
	pi.registerCommand("exa-status", {
		description: "Check Exa search configuration and usage status",
		handler: async (_args, ctx) => {
			const { getUsageInfo } = await import("./exa-client");
			const info = getUsageInfo();
			const hasKey = info.hasApiKey;
			const mode = hasKey ? "API (with key)" : "MCP (free, no key)";

			let msg = `Exa Search Status\n  Mode: ${mode}\n  Available: ${searchAvailable ? "Yes" : "No"}`;
			if (hasKey) {
				msg += `\n  Usage: ${info.usage.count}/${info.usage.monthlyLimit} (resets ${info.usage.month})`;
				if (info.usage.count >= info.usage.monthlyLimit) {
					msg += "\n  ⚠️ Monthly limit reached — falling back to MCP";
				} else if (info.usage.count >= info.usage.warningThreshold) {
					msg += "\n  ⚠️ Approaching monthly limit";
				}
			} else {
				msg += "\n  No API key set — using free MCP endpoint (no usage tracking)";
			}
			ctx.ui.notify(msg, searchAvailable ? "info" : "warning");
		},
	});
}