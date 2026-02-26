// Runtime registry — maps runtime names to adapter factory functions.
// This is the ONLY module that imports concrete adapter classes.

import type { OverstoryConfig } from "../types.ts";
import { ClaudeRuntime } from "./claude.ts";
import { PiRuntime } from "./pi.ts";
import type { AgentRuntime } from "./types.ts";

/** Registry of available runtime adapters (name → factory). */
const runtimes = new Map<string, () => AgentRuntime>([
	["claude", () => new ClaudeRuntime()],
	["pi", () => new PiRuntime()],
]);

/**
 * Resolve a runtime adapter by name.
 *
 * Lookup order:
 * 1. Explicit `name` argument (if provided)
 * 2. `config.runtime.default` (if config is provided)
 * 3. `"claude"` (hardcoded fallback)
 *
 * @param name - Runtime name to resolve (e.g. "claude"). Omit to use config default.
 * @param config - Overstory config for reading the default runtime.
 * @throws {Error} If the resolved runtime name is not registered.
 * @returns A fresh AgentRuntime instance.
 */
export function getRuntime(name?: string, config?: OverstoryConfig): AgentRuntime {
	const runtimeName = name ?? config?.runtime?.default ?? "claude";
	const factory = runtimes.get(runtimeName);
	if (!factory) {
		throw new Error(
			`Unknown runtime: "${runtimeName}". Available: ${[...runtimes.keys()].join(", ")}`,
		);
	}
	return factory();
}
