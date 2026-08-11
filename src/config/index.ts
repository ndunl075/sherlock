// .sherlockrc — ARCHITECTURE.md §11 (public surface), §12 (security model).
//
// "stable — unknown keys warn, never throw" (§11) and "`.sherlockrc` sets
// thresholds and paths, never plugins, commands, or hooks" (§12). Both are
// enforced by construction here, not by convention: the allowed-key set below
// is the entire schema, plain JSON.parse is the only thing ever done to the
// file's contents, and there is no code path that could turn a key into a
// function, a shell command, or a module to load. A crafted .sherlockrc in a
// scanned repo can misconfigure a scan; it cannot run anything.

import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_BUDGET, DEFAULT_CADENCE, type Tier } from "../types.js";

export interface SherlockConfig {
  budget: number;
  /** true when the repo's .sherlockrc set `budget` explicitly (vs. falling back to DEFAULT_BUDGET) */
  budgetExplicit: boolean;
  cadence: Record<Tier, number>;
}

const ALLOWED_KEYS = new Set(["budget", "cadence"]);
const ALLOWED_CADENCE_TIERS = new Set(["0", "1", "2"]);

function warn(message: string): void {
  process.stderr.write(`sherlock: warning: ${message}\n`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseCadence(raw: unknown): Partial<Record<Tier, number>> {
  if (!isPlainObject(raw)) {
    warn(".sherlockrc: \"cadence\" must be an object like {\"0\": 1.0, \"1\": 0.15, \"2\": 0.05} — ignoring it");
    return {};
  }
  const out: Partial<Record<Tier, number>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ALLOWED_CADENCE_TIERS.has(key)) {
      warn(`.sherlockrc: unknown cadence tier "${key}" (expected "0", "1", or "2") — ignoring it`);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      warn(`.sherlockrc: cadence["${key}"] must be a non-negative number — ignoring it`);
      continue;
    }
    out[Number(key) as Tier] = value;
  }
  return out;
}

export function parseConfig(raw: unknown): SherlockConfig {
  const config: SherlockConfig = { budget: DEFAULT_BUDGET, budgetExplicit: false, cadence: { ...DEFAULT_CADENCE } };
  if (!isPlainObject(raw)) {
    warn(".sherlockrc must contain a JSON object — ignoring the whole file");
    return config;
  }

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      warn(`.sherlockrc: unknown key "${key}" (ignored) — only "budget" and "cadence" are recognized`);
    }
  }

  if ("budget" in raw) {
    const b = raw.budget;
    if (typeof b === "number" && Number.isFinite(b) && b > 0) {
      config.budget = b;
      config.budgetExplicit = true;
    } else {
      warn(".sherlockrc: \"budget\" must be a positive number — ignoring it");
    }
  }

  if ("cadence" in raw) {
    Object.assign(config.cadence, parseCadence(raw.cadence));
  }

  return config;
}

export async function loadConfig(root: string): Promise<SherlockConfig> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, ".sherlockrc"), "utf8");
  } catch {
    return { budget: DEFAULT_BUDGET, budgetExplicit: false, cadence: { ...DEFAULT_CADENCE } }; // no file — defaults, silently
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    warn(".sherlockrc is not valid JSON — ignoring it and using defaults");
    return { budget: DEFAULT_BUDGET, budgetExplicit: false, cadence: { ...DEFAULT_CADENCE } };
  }

  return parseConfig(raw);
}
