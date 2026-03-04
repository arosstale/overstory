import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DANGEROUS_BASH_PATTERNS,
	INTERACTIVE_TOOLS,
	NATIVE_TEAM_TOOLS,
	SAFE_BASH_PREFIXES,
} from "../agents/guard-rules.ts";
import { DEFAULT_QUALITY_GATES } from "../config.ts";
import type { ResolvedModel } from "../types.ts";
import { SaplingRuntime } from "./sapling.ts";
import type { DirectSpawnOpts, HooksDef, SpawnOpts } from "./types.ts";

describe("SaplingRuntime", () => {
	const runtime = new SaplingRuntime();

	describe("id, instructionPath, headless", () => {
		test("id is 'sapling'", () => {
			expect(runtime.id).toBe("sapling");
		});

		test("instructionPath is 'SAPLING.md'", () => {
			expect(runtime.instructionPath).toBe("SAPLING.md");
		});

		test("headless is true", () => {
			expect(runtime.headless).toBe(true);
		});
	});

	describe("buildSpawnCommand", () => {
		test("basic command uses sp run --model and --json", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("sp run");
			expect(cmd).toContain("--model claude-sonnet-4-6");
			expect(cmd).toContain("--json");
			expect(cmd).toContain("Read SAPLING.md");
		});

		test("permissionMode is NOT included in command (guards.json enforces)", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("--permission-mode");
			expect(cmd).not.toContain("bypassPermissions");
		});

		test("ask permissionMode also excluded", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "ask",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("--permission-mode");
		});

		test("without appendSystemPrompt uses default SAPLING.md prompt", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe(
				"sp run --model claude-sonnet-4-6 --json 'Read SAPLING.md for your task assignment and begin immediately.'",
			);
		});

		test("appendSystemPrompt appends inline with POSIX single-quote escaping", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "You are a builder agent.",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("You are a builder agent.");
			expect(cmd).toContain("Read SAPLING.md");
		});

		test("appendSystemPrompt with single quotes uses POSIX escape", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "Don't touch the user's files",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("Don'\\''t touch the user'\\''s files");
			expect(cmd).toContain("Read SAPLING.md");
		});

		test("appendSystemPromptFile uses dollar-paren-cat expansion", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/.overstory/agent-defs/builder.md",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("$(cat '/project/.overstory/agent-defs/builder.md')");
			expect(cmd).toContain("Read SAPLING.md");
		});

		test("appendSystemPromptFile with single quotes in path", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/it's a path/agent.md",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("$(cat '/project/it'\\''s a path/agent.md')");
		});

		test("appendSystemPromptFile takes precedence over appendSystemPrompt", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/builder.md",
				appendSystemPrompt: "This inline content should be ignored",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("$(cat ");
			expect(cmd).not.toContain("This inline content should be ignored");
		});

		test("cwd and env are NOT embedded in command string", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/some/specific/path",
				env: { ANTHROPIC_API_KEY: "sk-ant-test-123" },
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("/some/specific/path");
			expect(cmd).not.toContain("sk-ant-test-123");
			expect(cmd).not.toContain("ANTHROPIC_API_KEY");
		});

		test("produces deterministic output for same inputs", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "You are a builder.",
			};
			expect(runtime.buildSpawnCommand(opts)).toBe(runtime.buildSpawnCommand(opts));
		});
	});

	describe("buildPrintCommand", () => {
		test("without model: 3 elements ['sp', 'print', prompt]", () => {
			const argv = runtime.buildPrintCommand("Summarize this diff");
			expect(argv).toEqual(["sp", "print", "Summarize this diff"]);
		});

		test("with model: 5 elements ['sp', 'print', '--model', model, prompt]", () => {
			const argv = runtime.buildPrintCommand("Classify this error", "claude-opus-4-6");
			expect(argv).toEqual(["sp", "print", "--model", "claude-opus-4-6", "Classify this error"]);
		});

		test("model undefined omits --model flag", () => {
			const argv = runtime.buildPrintCommand("Hello", undefined);
			expect(argv).not.toContain("--model");
		});

		test("prompt is the last element", () => {
			const prompt = "My test prompt";
			const argv = runtime.buildPrintCommand(prompt, "claude-sonnet-4-6");
			expect(argv[argv.length - 1]).toBe(prompt);
		});

		test("without model: exactly 3 elements", () => {
			const argv = runtime.buildPrintCommand("prompt text");
			expect(argv.length).toBe(3);
		});

		test("with model: exactly 5 elements", () => {
			const argv = runtime.buildPrintCommand("prompt text", "claude-sonnet-4-6");
			expect(argv.length).toBe(5);
		});
	});

	describe("buildDirectSpawn", () => {
		test("correct argv: sp run --model --json --cwd --system-prompt-file prompt", () => {
			const opts: DirectSpawnOpts = {
				model: "claude-sonnet-4-6",
				cwd: "/project/.overstory/worktrees/builder-1",
				env: {},
				instructionPath: "/project/.overstory/worktrees/builder-1/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			expect(argv).toEqual([
				"sp",
				"run",
				"--model",
				"claude-sonnet-4-6",
				"--json",
				"--cwd",
				"/project/.overstory/worktrees/builder-1",
				"--system-prompt-file",
				"/project/.overstory/worktrees/builder-1/SAPLING.md",
				"Read SAPLING.md for your task assignment and begin immediately.",
			]);
		});

		test("resolves model alias from ANTHROPIC_DEFAULT_<MODEL>_MODEL env var", () => {
			const opts: DirectSpawnOpts = {
				model: "sonnet",
				cwd: "/project/worktree",
				env: {
					ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6-20251015",
					ANTHROPIC_AUTH_TOKEN: "sk-ant-test",
				},
				instructionPath: "/project/worktree/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			// Model should be resolved from the alias env var
			expect(argv[3]).toBe("claude-sonnet-4-6-20251015");
		});

		test("passes model through when no alias match", () => {
			const opts: DirectSpawnOpts = {
				model: "claude-opus-4-6",
				cwd: "/project/worktree",
				env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-test" },
				instructionPath: "/project/worktree/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			expect(argv[3]).toBe("claude-opus-4-6");
		});

		test("resolves uppercase model name for alias lookup", () => {
			const opts: DirectSpawnOpts = {
				model: "opus",
				cwd: "/project/worktree",
				env: {
					ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6-20251015",
				},
				instructionPath: "/project/worktree/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			expect(argv[3]).toBe("claude-opus-4-6-20251015");
		});

		test("no alias env: passes model through unchanged", () => {
			const opts: DirectSpawnOpts = {
				model: "claude-haiku-4-5",
				cwd: "/project/worktree",
				env: {},
				instructionPath: "/project/worktree/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			expect(argv[3]).toBe("claude-haiku-4-5");
		});
	});

	describe("buildEnv", () => {
		test("clears CLAUDECODE, CLAUDE_CODE_SSE_PORT, CLAUDE_CODE_ENTRYPOINT", () => {
			const model: ResolvedModel = { model: "claude-sonnet-4-6" };
			const env = runtime.buildEnv(model);
			expect(env.CLAUDECODE).toBe("");
			expect(env.CLAUDE_CODE_SSE_PORT).toBe("");
			expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("");
		});

		test("translates ANTHROPIC_AUTH_TOKEN to ANTHROPIC_API_KEY", () => {
			const model: ResolvedModel = {
				model: "claude-sonnet-4-6",
				env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-test-token" },
			};
			const env = runtime.buildEnv(model);
			expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test-token");
			expect("ANTHROPIC_AUTH_TOKEN" in env).toBe(false);
		});

		test("passes ANTHROPIC_BASE_URL through unchanged", () => {
			const model: ResolvedModel = {
				model: "claude-sonnet-4-6",
				env: { ANTHROPIC_BASE_URL: "https://gateway.example.com/v1" },
			};
			const env = runtime.buildEnv(model);
			expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example.com/v1");
		});

		test("forces SAPLING_BACKEND=sdk when ANTHROPIC_AUTH_TOKEN present", () => {
			const model: ResolvedModel = {
				model: "claude-sonnet-4-6",
				env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-test" },
			};
			const env = runtime.buildEnv(model);
			expect(env.SAPLING_BACKEND).toBe("sdk");
		});

		test("forces SAPLING_BACKEND=sdk when ANTHROPIC_BASE_URL present", () => {
			const model: ResolvedModel = {
				model: "claude-sonnet-4-6",
				env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" },
			};
			const env = runtime.buildEnv(model);
			expect(env.SAPLING_BACKEND).toBe("sdk");
		});

		test("no SAPLING_BACKEND when no gateway env", () => {
			const model: ResolvedModel = { model: "claude-sonnet-4-6" };
			const env = runtime.buildEnv(model);
			expect("SAPLING_BACKEND" in env).toBe(false);
		});

		test("no SAPLING_BACKEND when model.env is empty", () => {
			const model: ResolvedModel = { model: "claude-sonnet-4-6", env: {} };
			const env = runtime.buildEnv(model);
			expect("SAPLING_BACKEND" in env).toBe(false);
		});

		test("gateway env with both AUTH_TOKEN and BASE_URL sets sdk backend", () => {
			const model: ResolvedModel = {
				model: "claude-sonnet-4-6",
				env: {
					ANTHROPIC_AUTH_TOKEN: "sk-ant-test",
					ANTHROPIC_BASE_URL: "https://gateway.example.com",
				},
			};
			const env = runtime.buildEnv(model);
			expect(env.SAPLING_BACKEND).toBe("sdk");
			expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
			expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example.com");
		});
	});

	describe("detectReady", () => {
		test("returns { phase: 'ready' } for empty pane content", () => {
			expect(runtime.detectReady("")).toEqual({ phase: "ready" });
		});

		test("returns { phase: 'ready' } for any pane content (always headless-ready)", () => {
			expect(runtime.detectReady("Loading sapling...\nPlease wait")).toEqual({ phase: "ready" });
		});

		test("returns { phase: 'ready' } for NDJSON output", () => {
			const pane = '{"type":"ready","timestamp":"2025-01-01T00:00:00Z"}';
			expect(runtime.detectReady(pane)).toEqual({ phase: "ready" });
		});
	});

	describe("requiresBeaconVerification", () => {
		test("returns false (headless — no beacon needed)", () => {
			expect(runtime.requiresBeaconVerification()).toBe(false);
		});
	});

	describe("deployConfig", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-sapling-test-"));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		test("writes SAPLING.md to worktree root", async () => {
			const worktreePath = join(tempDir, "worktree");
			const hooks: HooksDef = { agentName: "test-builder", capability: "builder", worktreePath };

			await runtime.deployConfig(worktreePath, { content: "# Task Assignment\nBuild it." }, hooks);

			const saplingPath = join(worktreePath, "SAPLING.md");
			const content = await Bun.file(saplingPath).text();
			expect(content).toBe("# Task Assignment\nBuild it.");
		});

		test("writes .sapling/guards.json alongside SAPLING.md", async () => {
			const worktreePath = join(tempDir, "worktree");
			const hooks: HooksDef = { agentName: "test-builder", capability: "builder", worktreePath };

			await runtime.deployConfig(worktreePath, { content: "# Overlay" }, hooks);

			const guardsPath = join(worktreePath, ".sapling", "guards.json");
			const exists = await Bun.file(guardsPath).exists();
			expect(exists).toBe(true);
		});

		test("skips SAPLING.md but writes guards.json when overlay is undefined", async () => {
			const worktreePath = join(tempDir, "worktree");
			const hooks: HooksDef = {
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath,
			};

			await runtime.deployConfig(worktreePath, undefined, hooks);

			const saplingPath = join(worktreePath, "SAPLING.md");
			expect(await Bun.file(saplingPath).exists()).toBe(false);

			const guardsPath = join(worktreePath, ".sapling", "guards.json");
			expect(await Bun.file(guardsPath).exists()).toBe(true);
		});

		test("creates nested directories if they do not exist", async () => {
			const worktreePath = join(tempDir, "deep", "nested", "worktree");
			const hooks: HooksDef = { agentName: "builder-1", capability: "builder", worktreePath };

			await runtime.deployConfig(worktreePath, { content: "# Overlay" }, hooks);

			expect(await Bun.file(join(worktreePath, "SAPLING.md")).exists()).toBe(true);
			expect(await Bun.file(join(worktreePath, ".sapling", "guards.json")).exists()).toBe(true);
		});

		test("overlay content is written verbatim", async () => {
			const worktreePath = join(tempDir, "worktree");
			const content = "# Task\n\n## Criteria\n\n- [ ] Tests pass\n- [ ] Lint clean\n";
			const hooks: HooksDef = { agentName: "builder-1", capability: "builder", worktreePath };

			await runtime.deployConfig(worktreePath, { content }, hooks);

			const written = await Bun.file(join(worktreePath, "SAPLING.md")).text();
			expect(written).toBe(content);
		});
	});

	describe("buildGuardsConfig (via deployConfig)", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-sapling-guards-"));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		async function readGuards(worktreePath: string): Promise<Record<string, unknown>> {
			const guardsPath = join(worktreePath, ".sapling", "guards.json");
			const text = await Bun.file(guardsPath).text();
			return JSON.parse(text) as Record<string, unknown>;
		}

		test("version is 1", async () => {
			const worktreePath = join(tempDir, "wt");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "test-builder",
					capability: "builder",
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			expect(guards.version).toBe(1);
		});

		test("agentName and capability are set correctly", async () => {
			const worktreePath = join(tempDir, "wt");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "my-builder",
					capability: "builder",
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			expect(guards.agentName).toBe("my-builder");
			expect(guards.capability).toBe("builder");
		});

		test("pathBoundary is set to worktreePath", async () => {
			const worktreePath = join(tempDir, "wt");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "builder-1",
					capability: "builder",
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			expect(guards.pathBoundary).toBe(worktreePath);
		});

		test("readOnly is false for builder capability", async () => {
			const worktreePath = join(tempDir, "wt-builder");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "test-builder",
					capability: "builder",
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			expect(guards.readOnly).toBe(false);
		});

		test("readOnly is false for merger capability", async () => {
			const worktreePath = join(tempDir, "wt-merger");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "test-merger",
					capability: "merger",
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			expect(guards.readOnly).toBe(false);
		});

		test.each([
			"scout",
			"reviewer",
			"lead",
			"coordinator",
			"supervisor",
			"monitor",
		])("readOnly is true for %s capability", async (capability) => {
			const worktreePath = join(tempDir, `wt-${capability}`);
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: `test-${capability}`,
					capability,
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			expect(guards.readOnly).toBe(true);
		});

		test("blockedTools = NATIVE_TEAM_TOOLS + INTERACTIVE_TOOLS", async () => {
			const worktreePath = join(tempDir, "wt");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "test-builder",
					capability: "builder",
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			const expected = [...NATIVE_TEAM_TOOLS, ...INTERACTIVE_TOOLS];
			expect(guards.blockedTools).toEqual(expected);
		});

		test("writeToolsBlocked is populated for scout (non-impl)", async () => {
			const worktreePath = join(tempDir, "wt-scout");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "test-scout",
					capability: "scout",
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			expect(Array.isArray(guards.writeToolsBlocked)).toBe(true);
			expect((guards.writeToolsBlocked as string[]).length).toBeGreaterThan(0);
		});

		test("writeToolsBlocked is empty for builder (impl)", async () => {
			const worktreePath = join(tempDir, "wt-builder");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "test-builder",
					capability: "builder",
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			expect(guards.writeToolsBlocked).toEqual([]);
		});

		test("bashGuards has dangerousPatterns from DANGEROUS_BASH_PATTERNS", async () => {
			const worktreePath = join(tempDir, "wt");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "test-builder",
					capability: "builder",
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			const bash = guards.bashGuards as Record<string, unknown>;
			expect(bash.dangerousPatterns).toEqual(DANGEROUS_BASH_PATTERNS);
		});

		test("bashGuards has safePrefixes from SAFE_BASH_PREFIXES", async () => {
			const worktreePath = join(tempDir, "wt");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "test-builder",
					capability: "builder",
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			const bash = guards.bashGuards as Record<string, unknown>;
			const safePrefixes = bash.safePrefixes as string[];
			// Should include all base safe prefixes
			for (const prefix of SAFE_BASH_PREFIXES) {
				expect(safePrefixes).toContain(prefix);
			}
		});

		test("bashGuards has fileModifyingPatterns", async () => {
			const worktreePath = join(tempDir, "wt");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "test-builder",
					capability: "builder",
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			const bash = guards.bashGuards as Record<string, unknown>;
			expect(Array.isArray(bash.fileModifyingPatterns)).toBe(true);
			expect((bash.fileModifyingPatterns as string[]).length).toBeGreaterThan(0);
		});

		test("coordinator gets git add/commit in safePrefixes", async () => {
			const worktreePath = join(tempDir, "wt-coordinator");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "coordinator",
					capability: "coordinator",
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			const bash = guards.bashGuards as Record<string, unknown>;
			const safePrefixes = bash.safePrefixes as string[];
			expect(safePrefixes).toContain("git add");
			expect(safePrefixes).toContain("git commit");
		});

		test("builder does NOT get git add/commit in safePrefixes", async () => {
			const worktreePath = join(tempDir, "wt-builder");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "test-builder",
					capability: "builder",
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			const bash = guards.bashGuards as Record<string, unknown>;
			const safePrefixes = bash.safePrefixes as string[];
			expect(safePrefixes).not.toContain("git add");
			expect(safePrefixes).not.toContain("git commit");
		});

		test("qualityGates uses DEFAULT_QUALITY_GATES when none provided", async () => {
			const worktreePath = join(tempDir, "wt");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "test-builder",
					capability: "builder",
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			const gates = guards.qualityGates as Array<{ name: string; command: string }>;
			expect(gates.length).toBe(DEFAULT_QUALITY_GATES.length);
			for (const gate of DEFAULT_QUALITY_GATES) {
				const found = gates.find((g) => g.command === gate.command);
				expect(found).toBeDefined();
				expect(found?.name).toBe(gate.name);
			}
		});

		test("qualityGates uses custom gates when provided", async () => {
			const worktreePath = join(tempDir, "wt-custom");
			const customGates = [{ name: "Custom Test", command: "pytest", description: "run pytest" }];
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "test-builder",
					capability: "builder",
					worktreePath,
					qualityGates: customGates,
				},
			);
			const guards = await readGuards(worktreePath);
			const gates = guards.qualityGates as Array<{ name: string; command: string }>;
			expect(gates.length).toBe(1);
			expect(gates[0]?.command).toBe("pytest");
		});

		test("eventConfig contains agent name in all event hooks", async () => {
			const worktreePath = join(tempDir, "wt");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "my-agent",
					capability: "builder",
					worktreePath,
				},
			);
			const guards = await readGuards(worktreePath);
			const events = guards.eventConfig as Record<string, string[]>;
			expect(events.onToolStart).toContain("my-agent");
			expect(events.onToolEnd).toContain("my-agent");
			expect(events.onSessionEnd).toContain("my-agent");
		});
	});

	describe("parseTranscript", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-sapling-transcript-"));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		test("returns null for non-existent file", async () => {
			const result = await runtime.parseTranscript(join(tempDir, "does-not-exist.jsonl"));
			expect(result).toBeNull();
		});

		test("aggregates usage from any event with usage object", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const event1 = JSON.stringify({
				type: "message_start",
				usage: { input_tokens: 100, output_tokens: 0 },
			});
			const event2 = JSON.stringify({
				type: "message_end",
				usage: { input_tokens: 0, output_tokens: 50 },
			});
			await Bun.write(transcriptPath, `${event1}\n${event2}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(100);
			expect(result?.outputTokens).toBe(50);
		});

		test("aggregates multiple events with usage", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const turn1 = JSON.stringify({
				type: "turn",
				usage: { input_tokens: 1000, output_tokens: 200 },
			});
			const turn2 = JSON.stringify({
				type: "turn",
				usage: { input_tokens: 2000, output_tokens: 300 },
			});
			await Bun.write(transcriptPath, `${turn1}\n${turn2}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(3000);
			expect(result?.outputTokens).toBe(500);
		});

		test("first event model field wins (!model guard)", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const event1 = JSON.stringify({
				type: "start",
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 10, output_tokens: 5 },
			});
			const event2 = JSON.stringify({
				type: "end",
				model: "claude-opus-4-6",
				usage: { input_tokens: 5, output_tokens: 2 },
			});
			await Bun.write(transcriptPath, `${event1}\n${event2}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			// First model wins (not last)
			expect(result?.model).toBe("claude-sonnet-4-6");
		});

		test("skips malformed lines and parses valid ones", async () => {
			const transcriptPath = join(tempDir, "mixed.jsonl");
			const bad = "not json at all";
			const good = JSON.stringify({ type: "turn", usage: { input_tokens: 42, output_tokens: 7 } });
			await Bun.write(transcriptPath, `${bad}\n${good}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(42);
			expect(result?.outputTokens).toBe(7);
		});

		test("empty file returns zero counts (not null)", async () => {
			const transcriptPath = join(tempDir, "empty.jsonl");
			await Bun.write(transcriptPath, "");

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(0);
			expect(result?.outputTokens).toBe(0);
		});

		test("events without usage field do not contribute to counts", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const event = JSON.stringify({ type: "tool_start", tool: "Bash" });
			await Bun.write(transcriptPath, `${event}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(0);
			expect(result?.outputTokens).toBe(0);
		});

		test("model defaults to empty string when no event has model field", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const event = JSON.stringify({ type: "turn", usage: { input_tokens: 10, output_tokens: 5 } });
			await Bun.write(transcriptPath, `${event}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.model).toBe("");
		});
	});

	describe("parseEvents", () => {
		function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
			const encoder = new TextEncoder();
			return new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) {
						controller.enqueue(encoder.encode(chunk));
					}
					controller.close();
				},
			});
		}

		async function collectEvents(stream: ReadableStream<Uint8Array>) {
			const events = [];
			for await (const event of runtime.parseEvents(stream)) {
				events.push(event);
			}
			return events;
		}

		test("parses single NDJSON event", async () => {
			const event = { type: "ready", timestamp: "2025-01-01T00:00:00Z" };
			const stream = makeStream([`${JSON.stringify(event)}\n`]);
			const events = await collectEvents(stream);
			expect(events).toHaveLength(1);
			expect(events[0]).toEqual(event);
		});

		test("parses multiple NDJSON events", async () => {
			const e1 = { type: "tool_start", timestamp: "2025-01-01T00:00:00Z" };
			const e2 = { type: "tool_end", timestamp: "2025-01-01T00:00:01Z" };
			const stream = makeStream([`${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`]);
			const events = await collectEvents(stream);
			expect(events).toHaveLength(2);
			expect(events[0]).toEqual(e1);
			expect(events[1]).toEqual(e2);
		});

		test("skips malformed lines", async () => {
			const good = { type: "result", timestamp: "2025-01-01T00:00:00Z" };
			const stream = makeStream([`not json\n${JSON.stringify(good)}\n`]);
			const events = await collectEvents(stream);
			expect(events).toHaveLength(1);
			expect(events[0]).toEqual(good);
		});

		test("skips empty lines", async () => {
			const good = { type: "ready", timestamp: "2025-01-01T00:00:00Z" };
			const stream = makeStream([`\n\n${JSON.stringify(good)}\n\n`]);
			const events = await collectEvents(stream);
			expect(events).toHaveLength(1);
		});

		test("handles chunked data spanning multiple reads", async () => {
			const event = { type: "result", timestamp: "2025-01-01T00:00:00Z", data: "hello" };
			const full = `${JSON.stringify(event)}\n`;
			// Split across three chunks
			const mid = Math.floor(full.length / 2);
			const stream = makeStream([full.slice(0, mid), full.slice(mid)]);
			const events = await collectEvents(stream);
			expect(events).toHaveLength(1);
			expect(events[0]).toEqual(event);
		});

		test("handles trailing data without newline", async () => {
			const event = { type: "result", timestamp: "2025-01-01T00:00:00Z" };
			// No trailing newline
			const stream = makeStream([JSON.stringify(event)]);
			const events = await collectEvents(stream);
			expect(events).toHaveLength(1);
			expect(events[0]).toEqual(event);
		});

		test("empty stream yields nothing", async () => {
			const stream = makeStream([]);
			const events = await collectEvents(stream);
			expect(events).toHaveLength(0);
		});

		test("preserves all fields from event", async () => {
			const event = {
				type: "tool_end",
				timestamp: "2025-01-01T00:00:01Z",
				toolName: "Bash",
				exitCode: 0,
				nested: { key: "value" },
			};
			const stream = makeStream([`${JSON.stringify(event)}\n`]);
			const events = await collectEvents(stream);
			expect(events[0]).toEqual(event);
		});
	});
});

describe("SaplingRuntime integration: registry resolves 'sapling'", () => {
	test("getRuntime('sapling') returns SaplingRuntime", async () => {
		const { getRuntime } = await import("./registry.ts");
		const rt = getRuntime("sapling");
		expect(rt).toBeInstanceOf(SaplingRuntime);
		expect(rt.id).toBe("sapling");
		expect(rt.instructionPath).toBe("SAPLING.md");
	});
});
