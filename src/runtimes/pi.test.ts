import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { ResolvedModel } from "../types.ts";
import { PiRuntime } from "./pi.ts";
import type { SpawnOpts } from "./types.ts";

describe("PiRuntime", () => {
	const runtime = new PiRuntime();

	describe("id and instructionPath", () => {
		test("id is 'pi'", () => {
			expect(runtime.id).toBe("pi");
		});

		test("instructionPath is .claude/CLAUDE.md (Pi reads it natively)", () => {
			expect(runtime.instructionPath).toBe(".claude/CLAUDE.md");
		});
	});

	describe("buildSpawnCommand", () => {
		test("basic command with model", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("pi --model claude-sonnet-4");
			expect(cmd).toContain("-e .pi/extensions/overstory-guard.ts");
		});

		test("permission mode is not included (Pi uses guard extensions instead)", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "ask",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("permission");
			expect(cmd).not.toContain("--permission-mode");
		});

		test("with appendSystemPrompt", () => {
			const opts: SpawnOpts = {
				model: "gpt-5-turbo",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "You are a builder agent.",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("--append-system-prompt 'You are a builder agent.'");
		});

		test("with appendSystemPrompt containing single quotes", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "Don't touch the user's files",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("--append-system-prompt");
			// POSIX escape
			expect(cmd).toContain("Don'\\''t touch the user'\\''s files");
		});

		test("without appendSystemPrompt omits the flag", () => {
			const opts: SpawnOpts = {
				model: "haiku",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("--append-system-prompt");
		});

		test("supports provider-qualified model names", () => {
			const opts: SpawnOpts = {
				model: "openrouter/openai/gpt-5.3",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("--model openrouter/openai/gpt-5.3");
		});
	});

	describe("buildPrintCommand", () => {
		test("builds headless json mode command", () => {
			const cmd = runtime.buildPrintCommand("Summarize the changes");
			expect(cmd).toEqual(["pi", "--mode", "json", "-p", "Summarize the changes"]);
		});

		test("includes model when specified", () => {
			const cmd = runtime.buildPrintCommand("Fix the bug", "gemini-3-pro");
			expect(cmd).toEqual(["pi", "--mode", "json", "-p", "Fix the bug", "--model", "gemini-3-pro"]);
		});
	});

	describe("deployConfig", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-pi-test-"));
		});

		afterEach(async () => {
			await cleanupTempDir(tempDir);
		});

		test("writes overlay to .claude/CLAUDE.md", async () => {
			await runtime.deployConfig(
				tempDir,
				{ content: "# Builder Agent\nYou are a builder." },
				{ agentName: "bob", capability: "builder", worktreePath: tempDir },
			);

			const content = await readFile(join(tempDir, ".claude", "CLAUDE.md"), "utf-8");
			expect(content).toContain("# Builder Agent");
			expect(content).toContain("You are a builder.");
		});

		test("writes guard extension to .pi/extensions/overstory-guard.ts", async () => {
			await runtime.deployConfig(
				tempDir,
				{ content: "# Test" },
				{ agentName: "alice", capability: "scout", worktreePath: tempDir },
			);

			const guard = await readFile(
				join(tempDir, ".pi", "extensions", "overstory-guard.ts"),
				"utf-8",
			);
			expect(guard).toContain("alice");
			expect(guard).toContain("scout");
			expect(guard).toContain("READ_ONLY = true");
		});

		test("builder agents are not read-only", async () => {
			await runtime.deployConfig(
				tempDir,
				{ content: "# Builder" },
				{ agentName: "bob", capability: "builder", worktreePath: tempDir },
			);

			const guard = await readFile(
				join(tempDir, ".pi", "extensions", "overstory-guard.ts"),
				"utf-8",
			);
			expect(guard).toContain("READ_ONLY = false");
		});

		test("skips overlay when undefined (guard-only deployment)", async () => {
			await runtime.deployConfig(tempDir, undefined, {
				agentName: "coord",
				capability: "coordinator",
				worktreePath: tempDir,
			});

			// Guard should exist
			const guard = await readFile(
				join(tempDir, ".pi", "extensions", "overstory-guard.ts"),
				"utf-8",
			);
			expect(guard).toContain("coord");

			// CLAUDE.md should NOT exist
			const claudeMd = Bun.file(join(tempDir, ".claude", "CLAUDE.md"));
			expect(await claudeMd.exists()).toBe(false);
		});

		test("guard blocks dangerous git commands", async () => {
			await runtime.deployConfig(
				tempDir,
				{ content: "# Test" },
				{ agentName: "test", capability: "builder", worktreePath: tempDir },
			);

			const guard = await readFile(
				join(tempDir, ".pi", "extensions", "overstory-guard.ts"),
				"utf-8",
			);
			expect(guard).toContain("git\\s+push\\s+.*--force");
			expect(guard).toContain("git\\s+reset\\s+--hard");
			expect(guard).toContain("rm\\s+(-[^\\s]*)*-[rRf]");
			expect(guard).toContain("sudo");
		});

		test("read-only agents have additional write blocks", async () => {
			await runtime.deployConfig(
				tempDir,
				{ content: "# Reviewer" },
				{ agentName: "rev", capability: "reviewer", worktreePath: tempDir },
			);

			const guard = await readFile(
				join(tempDir, ".pi", "extensions", "overstory-guard.ts"),
				"utf-8",
			);
			expect(guard).toContain("READ_ONLY = true");
			expect(guard).toContain("git\\s+commit");
			expect(guard).toContain("git\\s+merge");
		});
	});

	describe("detectReady", () => {
		test("returns ready when prompt and footer are present", () => {
			const content = "Welcome to Pi\n> \nmodel: claude-sonnet-4 [###-------] 30%";
			expect(runtime.detectReady(content)).toEqual({ phase: "ready" });
		});

		test("returns ready when just prompt is present (Pi starts fast)", () => {
			const content = "Pi Coding Agent\n> ";
			expect(runtime.detectReady(content)).toEqual({ phase: "ready" });
		});

		test("returns loading when no prompt indicator", () => {
			const content = "Loading extensions...";
			expect(runtime.detectReady(content)).toEqual({ phase: "loading" });
		});

		test("never returns dialog phase (Pi has no trust dialog)", () => {
			// Even if content mentions trust, Pi doesn't have a trust dialog
			const content = "trust this folder\n> ";
			const result = runtime.detectReady(content);
			expect(result.phase).not.toBe("dialog");
		});
	});

	describe("parseTranscript", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-pi-transcript-"));
		});

		afterEach(async () => {
			await cleanupTempDir(tempDir);
		});

		test("returns null for non-existent file", async () => {
			const result = await runtime.parseTranscript(join(tempDir, "nonexistent.jsonl"));
			expect(result).toBeNull();
		});

		test("parses token usage from Pi session JSONL", async () => {
			const transcript = [
				'{"type":"message","role":"user","content":"Fix the bug"}',
				'{"type":"message","role":"assistant","usage":{"inputTokens":500,"outputTokens":200},"model":"claude-sonnet-4"}',
				'{"type":"message","role":"assistant","usage":{"inputTokens":300,"outputTokens":150},"model":"claude-sonnet-4"}',
			].join("\n");

			const path = join(tempDir, "session.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(800);
			expect(result?.outputTokens).toBe(350);
			expect(result?.model).toBe("claude-sonnet-4");
		});

		test("returns null for empty usage", async () => {
			const transcript = '{"type":"message","role":"user","content":"hello"}';
			const path = join(tempDir, "session.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result).toBeNull();
		});

		test("skips unparseable lines", async () => {
			const transcript = [
				"not json",
				'{"type":"message","role":"assistant","usage":{"inputTokens":100,"outputTokens":50},"model":"gpt-5"}',
				"{broken",
			].join("\n");

			const path = join(tempDir, "session.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result?.inputTokens).toBe(100);
			expect(result?.outputTokens).toBe(50);
		});
	});

	describe("buildEnv", () => {
		test("returns empty object when model has no env", () => {
			const model: ResolvedModel = { model: "sonnet" };
			expect(runtime.buildEnv(model)).toEqual({});
		});

		test("passes through provider env vars", () => {
			const model: ResolvedModel = {
				model: "gpt-5",
				env: { OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "https://api.openai.com" },
			};
			const env = runtime.buildEnv(model);
			expect(env.OPENAI_API_KEY).toBe("sk-test");
			expect(env.OPENAI_BASE_URL).toBe("https://api.openai.com");
		});
	});
});
