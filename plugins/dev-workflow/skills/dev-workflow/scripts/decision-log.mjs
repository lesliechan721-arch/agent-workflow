#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const COLUMNS = ["ts", "phase", "decision", "why", "evidence", "result"];
const HEADER = COLUMNS.join("\t");
const FORMULA_PREFIX = /^[=+\-@]/;
const SIGNED_NUMBER_PREFIX = /^[+-]\d/;

const HELP = `Usage:
  node scripts/decision-log.mjs init <file> [--json]
  node scripts/decision-log.mjs append <file> --phase <text> --decision <text> --why <text> --evidence <text> --result <text> [--ts <iso>] [--json]
  node scripts/decision-log.mjs tail <file> [--n <count>] [--json]
  node scripts/decision-log.mjs check <file> [--json]

Purpose:
  Append-only TSV decision trail for hillclimb and compose runs.
  Automatically writes the header on first append, strips stray tabs/newlines,
  and escapes spreadsheet formula prefixes (=, @, and non-numeric +/-) while keeping signed metrics like -10% intact.

Exit codes:
  0  Success
  1  File I/O failure or log integrity check failed
  2  Invalid CLI arguments or missing required flags
`;

function fail(code, message, json = false) {
  if (json) {
    process.stderr.write(JSON.stringify({ ok: false, error: message }) + "\n");
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exit(code);
}

function sanitizeCell(value) {
  const cleaned = String(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!cleaned) return "";
  if (SIGNED_NUMBER_PREFIX.test(cleaned)) return cleaned;
  return FORMULA_PREFIX.test(cleaned) ? `'${cleaned}` : cleaned;
}

const KNOWN_FLAGS = new Set([
  "--json",
  "--phase",
  "--decision",
  "--why",
  "--evidence",
  "--result",
  "--ts",
  "--n",
]);

function parseFlags(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        const key = arg.slice(2, eq);
        const val = arg.slice(eq + 1);
        if (!val) {
          return { error: `Flag --${key} requires a non-empty value.` };
        }
        flags[key] = val;
        continue;
      }
      const key = arg.slice(2);
      if (i + 1 >= argv.length || KNOWN_FLAGS.has(argv[i + 1])) {
        return { error: `Flag --${key} requires a value.` };
      }
      flags[key] = argv[i + 1];
      i += 1;
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function readLogLines(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function validateLog(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, errors: [`Log file does not exist: ${filePath}`], rows: [] };
  }
  const lines = readLogLines(filePath);
  const errors = [];
  if (lines.length === 0) {
    return { ok: false, errors: ["Log file is empty; expected TSV header."], rows: [] };
  }
  if (lines[0] !== HEADER) {
    errors.push(`Line 1 header mismatch. Expected "${HEADER}", got "${lines[0]}".`);
  }
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const parts = lines[i].split("\t");
    if (parts.length !== COLUMNS.length) {
      errors.push(`Line ${lineNo}: expected ${COLUMNS.length} tab-separated columns, got ${parts.length}.`);
      continue;
    }
    const row = {};
    for (let c = 0; c < COLUMNS.length; c += 1) {
      if (!parts[c].trim()) {
        errors.push(`Line ${lineNo}: column "${COLUMNS[c]}" is empty.`);
      }
      row[COLUMNS[c]] = parts[c];
    }
    rows.push(row);
  }
  return { ok: errors.length === 0, errors, rows };
}

function ensureHeader(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, HEADER + "\n", "utf8");
    return true;
  }
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    fs.writeFileSync(filePath, HEADER + "\n", "utf8");
    return true;
  }
  const lines = readLogLines(filePath);
  if (lines[0] !== HEADER) {
    throw new Error(`Existing file has unexpected header. Expected "${HEADER}".`);
  }
  return false;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const command = argv[0];
  const parsed = parseFlags(argv.slice(1));
  if (parsed.error) {
    fail(2, parsed.error, argv.includes("--json"));
  }
  const { flags, positionals } = parsed;
  if (flags.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const json = Boolean(flags.json);

  if (positionals.length !== 1) {
    fail(2, `Command "${command}" requires exactly one <file> argument.`, json);
  }
  const filePath = positionals[0];

  if (command === "init") {
    const allowed = new Set(["json"]);
    for (const key of Object.keys(flags)) {
      if (!allowed.has(key)) fail(2, `Unknown flag --${key} for init.`, json);
    }
    try {
      const created = ensureHeader(filePath);
      if (json) {
        process.stdout.write(JSON.stringify({ ok: true, file: filePath, created, header: COLUMNS }) + "\n");
      } else {
        process.stdout.write(`${created ? "Initialized" : "Already initialized"}: ${filePath}\n`);
      }
    } catch (err) {
      fail(1, err.message, json);
    }
    return;
  }

  if (command === "append") {
    const allowed = new Set(["phase", "decision", "why", "evidence", "result", "ts", "json"]);
    for (const key of Object.keys(flags)) {
      if (!allowed.has(key)) fail(2, `Unknown flag --${key} for append.`, json);
    }
    const required = ["phase", "decision", "why", "evidence", "result"];
    for (const key of required) {
      if (!flags[key] || !sanitizeCell(flags[key])) {
        fail(2, `Missing or empty required flag --${key}.`, json);
      }
    }
    const tsRaw = flags.ts ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const ts = sanitizeCell(tsRaw);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(ts)) {
      fail(2, `Invalid --ts value "${tsRaw}". Use ISO8601 format (e.g. 2026-11-21T10:00:00Z).`, json);
    }

    const row = {
      ts,
      phase: sanitizeCell(flags.phase),
      decision: sanitizeCell(flags.decision),
      why: sanitizeCell(flags.why),
      evidence: sanitizeCell(flags.evidence),
      result: sanitizeCell(flags.result),
    };
    const line = COLUMNS.map((c) => row[c]).join("\t") + "\n";

    try {
      ensureHeader(filePath);
      const separator = fs.readFileSync(filePath, "utf8").endsWith("\n") ? "" : "\n";
      fs.appendFileSync(filePath, separator + line, "utf8");
      if (json) {
        process.stdout.write(JSON.stringify({ ok: true, file: filePath, row }) + "\n");
      } else {
        process.stdout.write(line);
      }
    } catch (err) {
      fail(1, err.message, json);
    }
    return;
  }

  if (command === "tail") {
    const allowed = new Set(["n", "json"]);
    for (const key of Object.keys(flags)) {
      if (!allowed.has(key)) fail(2, `Unknown flag --${key} for tail.`, json);
    }
    const n = flags.n === undefined ? 10 : Number(flags.n);
    if (!Number.isInteger(n) || n < 1) {
      fail(2, `Flag --n must be a positive integer, got "${flags.n}".`, json);
    }
    let result;
    try {
      result = validateLog(filePath);
    } catch (err) {
      fail(1, err.message, json);
    }
    if (!result.ok) {
      fail(1, result.errors.join(" "), json);
    }
    const slice = result.rows.slice(-n);
    if (json) {
      process.stdout.write(
        JSON.stringify({ ok: true, file: filePath, totalRows: result.rows.length, shown: slice.length, rows: slice }) +
          "\n",
      );
    } else {
      process.stdout.write(HEADER + "\n");
      for (const row of slice) {
        process.stdout.write(COLUMNS.map((c) => row[c]).join("\t") + "\n");
      }
    }
    return;
  }

  if (command === "check") {
    const allowed = new Set(["json"]);
    for (const key of Object.keys(flags)) {
      if (!allowed.has(key)) fail(2, `Unknown flag --${key} for check.`, json);
    }
    let result;
    try {
      result = validateLog(filePath);
    } catch (err) {
      fail(1, err.message, json);
    }
    if (!result.ok) {
      fail(1, result.errors.join(" "), json);
    }
    if (json) {
      process.stdout.write(JSON.stringify({ ok: true, file: filePath, rowCount: result.rows.length }) + "\n");
    } else {
      process.stdout.write(`OK (${result.rows.length} rows): ${filePath}\n`);
    }
    return;
  }

  fail(2, `Unknown command "${command}". Valid commands: init, append, tail, check.`, json);
}

main();
