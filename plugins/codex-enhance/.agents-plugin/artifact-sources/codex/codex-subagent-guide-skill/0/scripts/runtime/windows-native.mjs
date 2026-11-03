/*! Bundled dependency licenses

*/
import { createRequire as awCreateRequire } from 'node:module'; const require = awCreateRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// skills/codex-subagent-guide/scripts/runtime/native-tool-reader.mjs
var native_tool_reader_exports = {};
__export(native_tool_reader_exports, {
  NATIVE_TOOL_CONTEXT_ENV: () => NATIVE_TOOL_CONTEXT_ENV,
  readNativeTool: () => readNativeTool
});
function readNativeTool(key, protocol, environment = process.env) {
  function reject() {
    const error = new Error("nativeContextInvalid");
    error.code = "nativeContextInvalid";
    throw error;
  }
  function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (typeof key !== "string" || !key || typeof protocol !== "string" || !protocol) reject();
  const names = Object.keys(environment).filter((name) => name.toUpperCase() === "AW_NATIVE_TOOL_CONTEXT");
  if (names.length !== 1 || typeof environment[names[0]] !== "string" || environment[names[0]].length > 128 * 1024) reject();
  let context;
  try {
    context = JSON.parse(environment[names[0]]);
  } catch {
    reject();
  }
  if (!record(context) || context.schemaVersion !== 1 || Object.keys(context).sort().join(",") !== "schemaVersion,tools" || !record(context.tools) || Object.keys(context.tools).length > 64) reject();
  for (const [name, value] of Object.entries(context.tools)) {
    if (!name || !record(value) || typeof value.protocol !== "string" || !value.protocol) reject();
    if (value.state === "ready") {
      if (Object.keys(value).sort().join(",") !== "executable,protocol,state" || typeof value.executable !== "string" || value.executable.length > 32768 || !/^(?:\/[^\x00]*|[A-Za-z]:[\\/][^\x00]*|\\\\[^\x00]+)$/.test(value.executable) || /[\x00-\x1f\x7f]/.test(value.executable)) reject();
    } else if (value.state === "unavailable") {
      if (Object.keys(value).sort().join(",") !== "code,protocol,state" || typeof value.code !== "string" || !/^[a-zA-Z][a-zA-Z0-9]{0,95}$/.test(value.code)) reject();
    } else reject();
  }
  if (!Object.hasOwn(context.tools, key) || context.tools[key].protocol !== protocol) reject();
  return Object.freeze({ ...context.tools[key] });
}
var NATIVE_TOOL_CONTEXT_ENV;
var init_native_tool_reader = __esm({
  "skills/codex-subagent-guide/scripts/runtime/native-tool-reader.mjs"() {
    NATIVE_TOOL_CONTEXT_ENV = "AW_NATIVE_TOOL_CONTEXT";
  }
});

// skills/codex-subagent-guide/scripts/runtime/windows-native.mjs
import { spawn } from "node:child_process";
import path from "node:path";

// skills/codex-subagent-guide/scripts/file-selection/contracts.mjs
var LIMITS = Object.freeze({
  inputBytes: 1024 * 1024,
  outputBytes: 16 * 1024 * 1024,
  selectors: 4096,
  patterns: 8192,
  patternBytes: 32768,
  braceRange: 1e3,
  expandedPatterns: 8192,
  entries: 1e5,
  operations: 5e5,
  files: 1e5,
  ignoreFileBytes: 1024 * 1024,
  ignoreTotalBytes: 4 * 1024 * 1024,
  durationMs: 3e4
});

// skills/codex-subagent-guide/scripts/runtime/contracts.mjs
var LIMITS2 = Object.freeze({
  taskBytes: 262144,
  instructionBytes: 262144,
  promptBytes: 524352,
  requestBytes: 8388608,
  outputBytes: 4194304,
  logBytes: 8388608,
  resultBytes: 33554432,
  messageBytes: 4096,
  messageBodyBytes: 24576,
  messageFrameBytes: 262144,
  controlFrameBytes: 4096,
  deliveryFrameBytes: 16384,
  receiveMs: 6e5,
  waitMs: 6e5,
  maximumWaitMs: 18e5
});
var RUNTIME_KEYS = Object.freeze(["subagentCommands", "subagentRetentionHours"]);
var STATES = Object.freeze(["completed", "failed", "cancelled", "unknown"]);
var RuntimeError = class extends Error {
  constructor(code, message, recoveryActions = []) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.recoveryActions = recoveryActions;
  }
};
function fail(code, message, recoveryActions = []) {
  throw new RuntimeError(code, message, recoveryActions);
}

// skills/codex-subagent-guide/scripts/runtime/windows-native.mjs
var spawnNative = spawn;
var windowsJobTool;
var inputLimit = 256 * 1024;
var outputLimit = 8 * 1024 * 1024;
var timeoutMs = 3e4;
var sidPattern = /^S-1-\d+(?:-\d+)+$/;
var ticks = (value) => typeof value === "string" && /^\d{1,20}$/.test(value);
var pid = (value) => Number.isSafeInteger(value) && value > 0 && value <= 4294967295;
var resourcePath = (value) => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0") && path.normalize(value) === value;
var kind = (value) => value === "file" || value === "directory";
var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var fields = (value, required, optional = []) => object(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
var chain = (value) => value === void 0 || Array.isArray(value) && value.every(resourcePath);
var scope = (value) => fields(value, ["kind", "name", "sid"]) && value.kind === "windows-job" && /^Local\\aw-subagent-[a-f0-9]{32}$/.test(value.name) && sidPattern.test(value.sid);
function validInput(operation, input) {
  const resource = (value, protection) => fields(value, ["target", "kind", "sid"], protection ? ["chain"] : []) && resourcePath(value.target) && kind(value.kind) && sidPattern.test(value.sid) && (!protection || chain(value.chain));
  switch (operation) {
    case "pathCheck":
    case "pathTree":
      return fields(input, ["target", "kind"], ["chain"]) && resourcePath(input.target) && (operation === "pathTree" ? input.kind === "directory" : kind(input.kind)) && chain(input.chain);
    case "aclVerify":
      return fields(input, ["resources"], ["chain"]) && chain(input.chain) && Array.isArray(input.resources) && input.resources.every((value) => resource(value, false));
    case "aclProtect":
      return fields(input, ["resources"]) && Array.isArray(input.resources) && input.resources.every((value) => resource(value, true));
    case "rootPublish":
      return fields(input, ["source", "destination"]) && resourcePath(input.source) && resourcePath(input.destination);
    case "processTable":
      return fields(input, [], ["requiredPids"]) && (input.requiredPids === void 0 || Array.isArray(input.requiredPids) && input.requiredPids.every(pid));
    case "processIdentity":
    case "processStart":
      return fields(input, ["pid"]) && pid(input.pid);
    case "processStop":
      return fields(input, ["pid", "started", "sid"]) && pid(input.pid) && ticks(input.started) && sidPattern.test(input.sid);
    case "jobObserve":
    case "jobStop":
      return scope(input);
    default:
      return false;
  }
}
function processRow(value) {
  return fields(value, ["pid", "ppid", "pgid", "started"]) && pid(value.pid) && Number.isSafeInteger(value.ppid) && value.ppid >= 0 && value.ppid <= 4294967295 && value.pgid === null && ticks(value.started);
}
function validResult(operation, result, input) {
  switch (operation) {
    case "pathCheck":
    case "pathTree":
    case "aclVerify":
    case "aclProtect":
    case "rootPublish":
      return result === true;
    case "processStop":
      return typeof result === "boolean";
    case "processStart":
      return result === null || ticks(result);
    case "processIdentity":
      return result === null || processRow(result) && result.pid === input.pid;
    case "processTable":
      return Array.isArray(result) && result.every(processRow) && new Set(result.map((row) => row.pid)).size === result.length && result.some((row) => row.pid === process.pid);
    case "jobObserve":
    case "jobStop":
      return Array.isArray(result) && result.every(pid) && new Set(result).size === result.length;
    default:
      return false;
  }
}
async function windowsJobExecutable() {
  windowsJobTool ??= Promise.resolve().then(() => (init_native_tool_reader(), native_tool_reader_exports)).then(({ readNativeTool: readNativeTool2 }) => {
    const tool = readNativeTool2("windows-job", "aw.windows-job.v1");
    if (tool.state !== "ready") throw new Error();
    return tool;
  }).catch(() => {
    fail("platformUnavailable", "The Windows native tool context is missing or invalid. Run this command through AW.");
  });
  return (await windowsJobTool).executable;
}
async function windowsNativeOperation(operation, input = {}) {
  if (!validInput(operation, input)) fail("platformOperationFailed", "A native Windows operation input is invalid.");
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, operation, input }));
  if (payload.length > inputLimit) fail("platformOperationFailed", "A native Windows operation input is too large.");
  const executable = await windowsJobExecutable();
  const started = performance.now();
  const failure = (reason, code = null, signal = null) => {
    fail("platformOperationFailed", `A native Windows identity, access-control, or process operation failed. ${JSON.stringify({ operation, reason, elapsedMs: Math.round(performance.now() - started), timeoutMs, exitCode: Number.isSafeInteger(code) ? code : null, signal: ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGBREAK"].includes(signal) ? signal : null })}`);
  };
  let bytes;
  try {
    bytes = await new Promise((resolve, reject) => {
      const child = spawnNative(executable, ["--operation"], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: process.env });
      const chunks = [];
      let length = 0;
      let reason;
      const timer = setTimeout(() => {
        reason = "timeout";
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        length += chunk.length;
        if (length <= outputLimit) chunks.push(chunk);
        else {
          reason = "outputLimit";
          child.kill("SIGKILL");
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject({ reason: "launchFailed" });
      });
      child.stdin.once("error", () => {
        reason ??= "inputFailed";
        child.kill("SIGKILL");
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (reason || code !== 0) reject({ reason: reason ?? "processExit", code, signal });
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(payload);
    });
  } catch (error) {
    failure(error.reason ?? "launchFailed", error.code, error.signal);
  }
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    failure("invalidJson");
  }
  if (!fields(envelope, ["schemaVersion", "result"]) || envelope.schemaVersion !== 1 || !validResult(operation, envelope.result, input)) failure("invalidResult");
  return envelope.result;
}
export {
  windowsJobExecutable,
  windowsNativeOperation
};
