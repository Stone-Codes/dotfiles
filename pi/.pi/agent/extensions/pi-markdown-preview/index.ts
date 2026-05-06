import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, keyHint } from "@mariozechner/pi-coding-agent";
import {
	allocateImageId,
	Container,
	deleteKittyImage,
	getCapabilities,
	Image,
	Markdown,
	matchesKey,
	resetCapabilitiesCache,
	setCapabilities,
	Spacer,
	Text,
} from "@mariozechner/pi-tui";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

// Lazy-load puppeteer so the extension loads even if it's not installed
let puppeteerModule: typeof import("puppeteer-core") | undefined;
async function getPuppeteer(): Promise<typeof import("puppeteer-core")> {
	if (puppeteerModule) return puppeteerModule;
	try {
		puppeteerModule = await import("puppeteer-core");
		return puppeteerModule;
	} catch {
		throw new Error(
			"puppeteer-core is not installed. Run: cd ~/.pi/agent/extensions/pi-markdown-preview && npm install puppeteer-core",
		);
	}
}

// ==================== Constants ====================

const CACHE_DIR = join(homedir(), ".pi", "cache", "markdown-preview");
const RENDER_VERSION = "v1-minimal";
const VIEWPORT_WIDTH_PX = 1200;
const PAGE_HEIGHT_PX = 2200;
const MAX_TOTAL_HEIGHT_PX = PAGE_HEIGHT_PX * 10; // max 10 pages
const DEFAULT_DEVICE_SCALE_FACTOR = 2;

// ==================== Types ====================

type ThemeMode = "dark" | "light";

interface PreviewPalette {
	bg: string;
	card: string;
	border: string;
	text: string;
	muted: string;
	accent: string;
	codeBg: string;
	mdHeading: string;
	mdLink: string;
	mdCode: string;
	mdQuote: string;
	mdQuoteBorder: string;
	syntaxKeyword: string;
	syntaxString: string;
	syntaxComment: string;
	syntaxFunction: string;
}

interface PreviewPage {
	base64Png: string;
	index: number;
	total: number;
	truncatedHeight: boolean;
}

interface RenderPreviewResult {
	pages: PreviewPage[];
	themeMode: ThemeMode;
}

// ==================== Palettes ====================

const DARK_PALETTE: PreviewPalette = {
	bg: "#0f1117",
	card: "#171b24",
	border: "#2d3748",
	text: "#e6edf3",
	muted: "#9aa5b1",
	accent: "#5ea1ff",
	codeBg: "#11161f",
	mdHeading: "#f0c674",
	mdLink: "#81a2be",
	mdCode: "#8abeb7",
	mdQuote: "#808080",
	mdQuoteBorder: "#808080",
	syntaxKeyword: "#569CD6",
	syntaxString: "#CE9178",
	syntaxComment: "#6A9955",
	syntaxFunction: "#DCDCAA",
};

const LIGHT_PALETTE: PreviewPalette = {
	bg: "#f5f7fb",
	card: "#ffffff",
	border: "#d0d7de",
	text: "#1f2328",
	muted: "#57606a",
	accent: "#0969da",
	codeBg: "#f8fafc",
	mdHeading: "#9a7326",
	mdLink: "#547da7",
	mdCode: "#5a8080",
	mdQuote: "#6c6c6c",
	mdQuoteBorder: "#6c6c6c",
	syntaxKeyword: "#0000FF",
	syntaxString: "#A31515",
	syntaxComment: "#008000",
	syntaxFunction: "#795E26",
};

function inferThemeMode(theme?: Theme): ThemeMode {
	const name = theme?.name?.toLowerCase() ?? "";
	if (name.includes("light") || name.includes("dawn") || name.includes("day")) return "light";
	if (name.includes("dark") || name.includes("night") || name.includes("moon")) return "dark";
	// Default to dark for unknown themes
	return "dark";
}

function getPreviewPalette(theme?: Theme): PreviewPalette {
	return inferThemeMode(theme) === "light" ? LIGHT_PALETTE : DARK_PALETTE;
}

// ==================== Markdown Extraction ====================

function getLastAssistantMarkdown(ctx: ExtensionCommandContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message") continue;
		const msg = (entry as any).message;
		if (msg?.role !== "assistant") continue;

		const parts: string[] = [];
		const content = msg.content;
		if (typeof content === "string") {
			parts.push(content);
		} else if (Array.isArray(content)) {
			for (const part of content) {
				if (typeof part === "string") {
					parts.push(part);
				} else if (part?.type === "text" && typeof part.text === "string") {
					parts.push(part.text);
				}
			}
		}
		const text = parts.join("\n\n").trim();
		if (text) return text;
	}
	return undefined;
}

function isMarkdownFile(filePath: string): boolean {
	const ext = extname(filePath).toLowerCase().replace(/^\./, "");
	return ext === "md" || ext === "markdown" || ext === "mdx";
}

function wrapCodeAsMarkdown(content: string, lang: string, filePath: string): string {
	const header = `**${basename(filePath)}**\n\n`;
	return `${header}\`\`\`${lang}\n${content}\n\`\`\``;
}

function detectLanguageFromPath(filePath: string): string {
	const ext = extname(filePath).toLowerCase().replace(/^\./, "");
	const map: Record<string, string> = {
		ts: "typescript", tsx: "typescript",
		js: "javascript", jsx: "javascript",
		py: "python", rs: "rust", go: "go",
		sh: "bash", bash: "bash", zsh: "bash",
		html: "html", css: "css", json: "json",
		yaml: "yaml", yml: "yaml", sql: "sql",
	};
	return map[ext] || ext || "text";
}

// ==================== Path Security ====================

function isPathAllowed(filePath: string, cwd: string): boolean {
	const resolved = resolvePath(filePath);
	const cwdResolved = resolvePath(cwd);
	const rel = relative(cwdResolved, resolved);
	return !rel.startsWith("..") && !rel.startsWith("/..");
}

function sanitizeFilePath(input: string, cwd: string): string | undefined {
	const expanded = input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
	const resolved = resolvePath(cwd, expanded);
	if (!isPathAllowed(resolved, cwd)) return undefined;
	return resolved;
}

// ==================== Pandoc ====================

async function renderMarkdownToHtml(markdown: string): Promise<string> {
	const pandoc = process.env.PANDOC_PATH?.trim() || "pandoc";
	const inputFormat = "markdown+tex_math_dollars+autolink_bare_uris-raw_html";
	const args = ["-f", inputFormat, "-t", "html5", "--mathml", "--wrap=none"];

	return new Promise((resolve, reject) => {
		const child = spawn(pandoc, args, { stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let settled = false;

		child.stdout.on("data", (c: Buffer) => out.push(c));
		child.stderr.on("data", (c: Buffer) => err.push(c));

		child.once("error", (e) => {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") {
				reject(new Error("pandoc not found. Install pandoc or set PANDOC_PATH."));
			} else {
				reject(e);
			}
		});

		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			if (code === 0) {
				resolve(Buffer.concat(out).toString("utf-8"));
			} else {
				const stderr = Buffer.concat(err).toString("utf-8").trim();
				reject(new Error(`pandoc failed (exit ${code})${stderr ? ": " + stderr : ""}`));
			}
		});

		child.stdin.end(markdown);
	});
}

// ==================== HTML Builder ====================

function buildPreviewHtml(fragmentHtml: string, palette: PreviewPalette, fontSizePx = 16): string {
	const cssVars = Object.entries({
		"--bg": palette.bg,
		"--card": palette.card,
		"--border": palette.border,
		"--text": palette.text,
		"--muted": palette.muted,
		"--accent": palette.accent,
		"--code-bg": palette.codeBg,
		"--md-heading": palette.mdHeading,
		"--md-link": palette.mdLink,
		"--md-code": palette.mdCode,
		"--md-quote": palette.mdQuote,
		"--md-quote-border": palette.mdQuoteBorder,
		"--syntax-keyword": palette.syntaxKeyword,
		"--syntax-string": palette.syntaxString,
		"--syntax-comment": palette.syntaxComment,
		"--syntax-function": palette.syntaxFunction,
		"--preview-font-size": `${fontSizePx}px`,
	}).map(([k, v]) => `  ${k}: ${v};`).join("\n");

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Preview</title>
<style>
:root {\n${cssVars}\n}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
body { min-height: 100vh; padding: 28px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
#preview-root {
  width: min(1100px, 100%);
  margin: 0 auto;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 24px 28px;
  overflow-wrap: anywhere;
  line-height: 1.58;
  font-size: var(--preview-font-size);
}
#preview-root h1, #preview-root h2, #preview-root h3, #preview-root h4, #preview-root h5, #preview-root h6 {
  margin-top: 1.2em; margin-bottom: 0.5em; line-height: 1.25; letter-spacing: -0.01em; color: var(--md-heading);
}
#preview-root h1 { font-size: 1.6em; }
#preview-root h2 { font-size: 1.25em; }
#preview-root p, #preview-root ul, #preview-root ol, #preview-root blockquote, #preview-root table {
  margin-top: 0; margin-bottom: 1em;
}
#preview-root a { color: var(--md-link); text-decoration: none; }
#preview-root a:hover { text-decoration: underline; }
#preview-root blockquote {
  margin-left: 0; padding: 0.2em 1em;
  border-left: 0.25em solid var(--md-quote-border);
  border-radius: 0 8px 8px 0;
  background: rgba(128,128,128,0.08);
  color: var(--md-quote);
}
#preview-root pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  overflow: auto;
}
#preview-root code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.9em;
  color: var(--md-code);
}
#preview-root pre code { color: var(--text); }
#preview-root :not(pre) > code {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.12em 0.35em;
}
#preview-root code span.kw, #preview-root code span.cf, #preview-root code span.im { color: var(--syntax-keyword); font-weight: 600; }
#preview-root code span.st, #preview-root code span.ss, #preview-root code span.sc { color: var(--syntax-string); }
#preview-root code span.co { color: var(--syntax-comment); font-style: italic; }
#preview-root code span.fu, #preview-root code span.bu { color: var(--syntax-function); }
#preview-root table { border-collapse: collapse; display: block; max-width: 100%; overflow: auto; }
#preview-root th, #preview-root td { border: 1px solid var(--border); padding: 6px 12px; }
#preview-root thead th { background: var(--code-bg); }
#preview-root tbody tr:nth-child(even) { background: rgba(128,128,128,0.04); }
#preview-root hr { border: 0; border-top: 1px solid var(--border); margin: 1.25em 0; }
#preview-root img { max-width: 100%; }
#preview-root math[display="block"] { display: block; margin: 1em 0; overflow-x: auto; }
</style>
</head>
<body>
  <article id="preview-root">${fragmentHtml}</article>
</body>
</html>`;
}

// ==================== Puppeteer Rendering ====================

function findBrowserExecutable(): string | undefined {
	const envPath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
	if (envPath && existsSync(envPath)) return envPath;

	const candidates =
		process.platform === "darwin"
			? [
				"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
				"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
				"/Applications/Chromium.app/Contents/MacOS/Chromium",
			]
			: process.platform === "win32"
				? [
					"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
					"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
				]
				: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/brave"];

	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return undefined;
}

async function renderPreview(
	markdown: string,
	themeMode: ThemeMode,
	signal?: AbortSignal,
): Promise<RenderPreviewResult> {
	const palette = themeMode === "light" ? LIGHT_PALETTE : DARK_PALETTE;
	const fragment = await renderMarkdownToHtml(markdown);
	const html = buildPreviewHtml(fragment, palette);

	const hash = createHash("sha256")
		.update(RENDER_VERSION)
		.update(themeMode)
		.update(markdown)
		.digest("hex");

	const cachedPages = await loadCachedPages(hash);
	if (cachedPages && cachedPages.length > 0) {
		return { pages: cachedPages, themeMode };
	}

	if (signal?.aborted) throw new Error("Preview cancelled.");

	const executablePath = findBrowserExecutable();
	if (!executablePath) {
		throw new Error(
			"No Chromium browser found. Set PUPPETEER_EXECUTABLE_PATH to your Chrome/Edge/Chromium binary.",
		);
	}

	const args = ["--disable-gpu", "--font-render-hinting=medium"];
	// SECURITY: only disable sandbox if explicitly requested
	if (process.platform === "linux" && process.env.PUPPETEER_NO_SANDBOX === "1") {
		args.push("--no-sandbox", "--disable-setuid-sandbox");
	}

	const puppeteer = await getPuppeteer();
	const browser = await puppeteer.launch({ headless: true, executablePath, args });
	const page = await browser.newPage();

	let tempPath: string | undefined;
	const pages: PreviewPage[] = [];

	try {
		const deviceScaleFactor = DEFAULT_DEVICE_SCALE_FACTOR;
		await page.setViewport({ width: VIEWPORT_WIDTH_PX, height: PAGE_HEIGHT_PX, deviceScaleFactor });

		tempPath = join(CACHE_DIR, `_tmp_${Date.now()}.html`);
		await mkdir(CACHE_DIR, { recursive: true });
		await writeFile(tempPath, html, "utf-8");

		await page.goto(pathToFileURL(tempPath).href, { waitUntil: "domcontentloaded" });
		// Wait a tick for fonts/layout
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

		const contentHeight = await page.evaluate(() => {
			const root = document.getElementById("preview-root");
			return root ? root.getBoundingClientRect().height : document.body.scrollHeight;
		});

		const totalHeight = Math.min(Math.ceil(contentHeight) + 56, MAX_TOTAL_HEIGHT_PX); // +56 for body padding
		const numPages = Math.max(1, Math.ceil(totalHeight / PAGE_HEIGHT_PX));

		for (let i = 0; i < numPages; i++) {
			if (signal?.aborted) throw new Error("Preview cancelled.");

			const offsetY = i * PAGE_HEIGHT_PX;
			const remaining = totalHeight - offsetY;
			const clipHeight = Math.min(PAGE_HEIGHT_PX, remaining);

			const screenshot = (await page.screenshot({
				type: "png",
				clip: { x: 0, y: offsetY, width: VIEWPORT_WIDTH_PX, height: clipHeight },
			})) as Buffer;

			pages.push({
				base64Png: screenshot.toString("base64"),
				index: i,
				total: numPages,
				truncatedHeight: i === numPages - 1 && totalHeight >= MAX_TOTAL_HEIGHT_PX,
			});
		}

		await saveCachedPages(hash, pages);
	} finally {
		if (tempPath) await unlink(tempPath).catch(() => {});
		await page.close().catch(() => {});
		await browser.close().catch(() => {});
	}

	return { pages, themeMode };
}

// ==================== Cache ====================

async function loadCachedPages(hash: string): Promise<PreviewPage[] | null> {
	try {
		const metaPath = join(CACHE_DIR, `${hash}.json`);
		if (!existsSync(metaPath)) return null;
		const meta = JSON.parse(await readFile(metaPath, "utf-8")) as {
			pageCount: number;
			truncatedLast: boolean;
		};
		const pages: PreviewPage[] = [];
		for (let i = 0; i < meta.pageCount; i++) {
			const pngPath = join(CACHE_DIR, `${hash}_${i}.png`);
			if (!existsSync(pngPath)) return null;
			const buf = await readFile(pngPath);
			pages.push({
				base64Png: buf.toString("base64"),
				index: i,
				total: meta.pageCount,
				truncatedHeight: i === meta.pageCount - 1 && meta.truncatedLast,
			});
		}
		return pages;
	} catch {
		return null;
	}
}

async function saveCachedPages(hash: string, pages: PreviewPage[]): Promise<void> {
	await mkdir(CACHE_DIR, { recursive: true });
	const meta = {
		pageCount: pages.length,
		truncatedLast: pages[pages.length - 1]?.truncatedHeight ?? false,
	};
	await writeFile(join(CACHE_DIR, `${hash}.json`), JSON.stringify(meta), "utf-8");
	for (const page of pages) {
		await writeFile(join(CACHE_DIR, `${hash}_${page.index}.png`), Buffer.from(page.base64Png, "base64"));
	}
}

// ==================== Browser Open ====================

async function openFileInDefaultBrowser(filePath: string): Promise<void> {
	const target = pathToFileURL(filePath).href;
	const cmd =
		process.platform === "darwin"
			? { command: "open", args: [target] }
			: process.platform === "win32"
				? { command: "cmd", args: ["/c", "start", "", target] }
				: { command: "xdg-open", args: [target] };

	return new Promise((resolve, reject) => {
		const child = spawn(cmd.command, cmd.args, { stdio: "ignore", detached: true });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

async function openPreviewInBrowser(ctx: ExtensionCommandContext, markdown: string): Promise<void> {
	const palette = getPreviewPalette(ctx.ui.theme);
	const fragment = await renderMarkdownToHtml(markdown);
	const html = buildPreviewHtml(fragment, palette);

	const hash = createHash("sha256").update(RENDER_VERSION).update("browser").update(markdown).digest("hex");
	const htmlPath = join(CACHE_DIR, `${hash}.html`);

	await mkdir(CACHE_DIR, { recursive: true });
	await writeFile(htmlPath, html, "utf-8");
	await openFileInDefaultBrowser(htmlPath);
}

// ==================== Tmux Detection ====================

function isInTmux(): boolean {
	return !!process.env.TMUX;
}

// ==================== TUI Overlay ====================

class PreviewOverlay {
	private container: Container;
	private pageIndex = 0;
	private isOpeningBrowser = false;
	private isRefreshing = false;
	private statusLine?: string;
	private imageIds: number[] = [];

	constructor(
		private tui: any,
		private theme: any,
		private preview: RenderPreviewResult,
		private done: () => void,
		private onRefresh: () => Promise<RenderPreviewResult>,
		private onOpenBrowser: () => Promise<void>,
	) {
		this.container = new Container();
		this.allocateImageIds();
		this.rebuild();
	}

	private currentPage(): PreviewPage {
		return this.preview.pages[this.pageIndex]!;
	}

	private allocateImageIds(): void {
		this.imageIds = this.preview.pages.map(() => allocateImageId());
	}

	private clearImages(): void {
		for (const id of this.imageIds) {
			try { deleteKittyImage(id); } catch {}
		}
	}

	private rebuild(): void {
		this.container.clear();
		const page = this.currentPage();
		const title = `${this.theme.bold("Preview")} ${this.theme.fg("dim", `(${page.index + 1}/${page.total})`)}`;
		this.container.addChild(new Text(this.theme.fg("accent", title), 0, 0));

		const controls: string[] = [];
		if (page.total > 1) controls.push("←/→ page");
		controls.push(`${keyHint("tui.select.cancel", "close")}`, "r refresh", "o browser");
		this.container.addChild(new Text(this.theme.fg("dim", controls.join(" • ")), 0, 0));

		if (page.truncatedHeight) {
			this.container.addChild(
				new Text(this.theme.fg("warning", "Note: content clipped for terminal preview."), 0, 0),
			);
		}

		if (this.statusLine) {
			this.container.addChild(new Text(this.statusLine, 0, 0));
		}

		this.container.addChild(new Spacer(1));
		if (isInTmux()) {
			this.container.addChild(
				new Text(
					this.theme.fg("warning", "⚠ Images are not supported inside tmux. Press 'o' to open in browser."),
					0,
					0,
				),
			);
			this.container.addChild(new Spacer(1));
			this.container.addChild(
				new Markdown("_Markdown preview (text mode)_", 0, 0, getMarkdownTheme()),
			);
		} else {
			this.container.addChild(
				new Image(
					page.base64Png,
					"image/png",
					{ fallbackColor: (str: string) => this.theme.fg("muted", str) },
					{ maxWidthCells: 280, imageId: this.imageIds[page.index] ?? allocateImageId() },
				),
			);
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.clearImages();
			this.done();
			return;
		}

		if (matchesKey(data, "left") && this.pageIndex > 0) {
			this.clearImages();
			this.pageIndex--;
			this.statusLine = undefined;
			this.rebuild();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "right") && this.pageIndex < this.preview.pages.length - 1) {
			this.clearImages();
			this.pageIndex++;
			this.statusLine = undefined;
			this.rebuild();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "o") && !this.isOpeningBrowser) {
			this.isOpeningBrowser = true;
			this.statusLine = this.theme.fg("warning", "Opening browser...");
			this.rebuild();
			this.tui.requestRender();

			void this.onOpenBrowser()
				.then(() => {
					this.statusLine = this.theme.fg("success", "Opened in browser.");
				})
				.catch((e: any) => {
					const m = e instanceof Error ? e.message : String(e);
					this.statusLine = this.theme.fg("error", `Browser failed: ${m}`);
				})
				.finally(() => {
					this.isOpeningBrowser = false;
					this.rebuild();
					this.tui.requestRender();
				});
			return;
		}

		if (matchesKey(data, "r") && !this.isRefreshing) {
			this.isRefreshing = true;
			this.statusLine = this.theme.fg("warning", "Refreshing...");
			this.rebuild();
			this.tui.requestRender();

			void this.onRefresh()
				.then((preview) => {
					this.clearImages();
					this.preview = preview;
					this.allocateImageIds();
					this.pageIndex = Math.min(this.pageIndex, Math.max(0, preview.pages.length - 1));
					this.statusLine = this.theme.fg("success", `Refreshed (${preview.themeMode}).`);
				})
				.catch((e: any) => {
					const m = e instanceof Error ? e.message : String(e);
					this.statusLine = this.theme.fg("error", `Refresh failed: ${m}`);
				})
				.finally(() => {
					this.isRefreshing = false;
					this.rebuild();
					this.tui.requestRender();
				});
		}
	}

	render(width: number): string[] {
		return this.container.render(width);
	}

	invalidate(): void {
		this.container.invalidate();
		this.rebuild();
	}

	dispose(): void {
		this.clearImages();
	}
}

// ==================== Tmux Passthrough ====================

function maybeEnableTmuxImageSupport(): void {
	if (!process.env.TMUX) return;

	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	const colorTerm = process.env.COLORTERM?.toLowerCase() || "";
	const trueColor = colorTerm === "truecolor" || colorTerm === "24bit";

	// Kitty graphics protocol (Kitty, Ghostty, WezTerm)
	if (
		process.env.KITTY_WINDOW_ID ||
		termProgram === "kitty" ||
		termProgram === "ghostty" ||
		process.env.GHOSTTY_RESOURCES_DIR ||
		process.env.WEZTERM_PANE ||
		termProgram === "wezterm"
	) {
		resetCapabilitiesCache();
		setCapabilities({ images: "kitty", trueColor, hyperlinks: true });
		return;
	}

	// iTerm2 inline images
	if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") {
		resetCapabilitiesCache();
		setCapabilities({ images: "iterm2", trueColor, hyperlinks: true });
		return;
	}
}

// ==================== Main Command ====================

async function openPreview(
	ctx: ExtensionCommandContext,
	markdown: string,
	openBrowser = false,
): Promise<void> {
	if (openBrowser) {
		await openPreviewInBrowser(ctx, markdown);
		ctx.ui.notify("Opened preview in browser.", "info");
		return;
	}

	type Result = { ok: true; preview: RenderPreviewResult } | { ok: false; error: string } | { ok: false; cancelled: true };

	const themeMode = inferThemeMode(ctx.ui.theme);

	const result = await ctx.ui.custom<Result>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Rendering markdown preview...");
		let settled = false;
		const resolve = (v: Result) => {
			if (settled) return;
			settled = true;
			done(v);
		};
		loader.onAbort = () => resolve({ ok: false, cancelled: true });

		void (async () => {
			try {
				const preview = await renderPreview(markdown, themeMode, loader.signal);
				if (loader.signal.aborted) {
					resolve({ ok: false, cancelled: true });
					return;
				}
				resolve({ ok: true, preview });
			} catch (error) {
				const m = error instanceof Error ? error.message : String(error);
				resolve({ ok: false, error: m });
			}
		})();

		return loader;
	});

	if (!result) {
		// Fallback for non-TUI modes
		const preview = await renderPreview(markdown, themeMode);
		ctx.ui.notify(`Preview rendered (${preview.pages.length} page${preview.pages.length === 1 ? "" : "s"}).`, "info");
		return;
	}

	if (!result.ok) {
		if ("cancelled" in result && result.cancelled) {
			ctx.ui.notify("Preview cancelled.", "info");
		} else if ("error" in result) {
			ctx.ui.notify(`Preview failed: ${result.error}`, "error");
		} else {
			ctx.ui.notify("Preview failed.", "error");
		}
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _kb, done) =>
		new PreviewOverlay(
			tui,
			theme,
			result.preview,
			done,
			async () => renderPreview(markdown, themeMode),
			async () => openPreviewInBrowser(ctx, markdown),
		),
	);
}

function parseArgs(args: string): { file?: string; browser: boolean; error?: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let browser = false;
	let file: string | undefined;

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t === "--browser" || t === "-b") {
			browser = true;
			continue;
		}
		if (!t.startsWith("-")) {
			file = t;
			continue;
		}
		return { browser: false, error: `Unknown argument "${t}". Usage: /preview [--browser] [file]` };
	}

	return { file, browser };
}

// ==================== Extension Export ====================

export default function (pi: ExtensionAPI) {
	pi.registerCommand("preview", {
		description: "Preview last assistant response or a markdown file in terminal/browser",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}

			await ctx.waitForIdle();
			maybeEnableTmuxImageSupport();

			let markdown: string | undefined;
			if (parsed.file) {
				const safePath = sanitizeFilePath(parsed.file, ctx.cwd);
				if (!safePath) {
					ctx.ui.notify("Invalid or disallowed file path.", "error");
					return;
				}
				try {
					const content = await readFile(safePath, "utf-8");
					if (isMarkdownFile(safePath)) {
						markdown = content;
					} else {
						const lang = detectLanguageFromPath(safePath);
						markdown = wrapCodeAsMarkdown(content, lang, safePath);
					}
				} catch (e) {
					const m = e instanceof Error ? e.message : String(e);
					ctx.ui.notify(`Failed to read file: ${m}`, "error");
					return;
				}
			} else {
				markdown = getLastAssistantMarkdown(ctx);
				if (!markdown) {
					ctx.ui.notify("No assistant response found to preview.", "warning");
					return;
				}
			}

			try {
				await openPreview(ctx, markdown, parsed.browser);
			} catch (e) {
				const m = e instanceof Error ? e.message : String(e);
				ctx.ui.notify(`Preview error: ${m}`, "error");
			}
		},
	});

	pi.registerCommand("preview-clear-cache", {
		description: "Clear rendered preview cache",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			try {
				await rm(CACHE_DIR, { recursive: true, force: true });
				ctx.ui.notify("Cleared preview cache.", "info");
			} catch (e) {
				const m = e instanceof Error ? e.message : String(e);
				ctx.ui.notify(`Failed to clear cache: ${m}`, "error");
			}
		},
	});

	pi.registerCommand("preview-diagnose", {
		description: "Check terminal image protocol support",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			maybeEnableTmuxImageSupport();
			const caps = getCapabilities();
			const lines = [
				`Terminal image support: ${caps.images ? "✅ yes" : "❌ no"}`,
				`Image protocol: ${caps.images ?? "none"}`,
				`Terminal: ${process.env.TERM_PROGRAM ?? "unknown"}`,
				`TERM: ${process.env.TERM ?? "unknown"}`,
			];
			ctx.ui.notify(lines.join(" | "), caps.images ? "success" : "warning");
		},
	});
}
