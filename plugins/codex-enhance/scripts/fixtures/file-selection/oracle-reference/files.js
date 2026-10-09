import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { FileValidationError } from "./errors.js";
export const DEFAULT_MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB
const DEFAULT_FS = fs;
const DEFAULT_IGNORED_DIRS = new Set([
    "node_modules",
    "dist",
    "coverage",
    ".git",
    ".turbo",
    ".next",
    "build",
    "tmp",
]);
export async function readFiles(filePaths, { cwd = process.cwd(), fsModule = DEFAULT_FS, maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES, readContents = true, } = {}) {
    if (!filePaths || filePaths.length === 0) {
        return [];
    }
    const partitioned = await partitionFileInputs(filePaths, cwd, fsModule);
    const useNativeFilesystem = fsModule === DEFAULT_FS || isNativeFsModule(fsModule);
    let candidatePaths = [];
    if (useNativeFilesystem) {
        if (partitioned.globPatterns.length === 0 &&
            partitioned.excludePatterns.length === 0 &&
            partitioned.literalDirectories.length === 0) {
            candidatePaths = Array.from(new Set(partitioned.literalFiles));
        }
        else {
            candidatePaths = await expandWithNativeGlob(partitioned, cwd);
        }
    }
    else {
        if (partitioned.globPatterns.length > 0 || partitioned.excludePatterns.length > 0) {
            throw new Error("Glob patterns and exclusions are only supported for on-disk files.");
        }
        candidatePaths = await expandWithCustomFs(partitioned, fsModule);
    }
    const allowedLiteralDirs = partitioned.literalDirectories
        .map((dir) => path.resolve(dir))
        .filter((dir) => DEFAULT_IGNORED_DIRS.has(path.basename(dir)));
    const allowedLiteralFiles = partitioned.literalFiles.map((file) => path.resolve(file));
    const resolvedLiteralDirs = new Set(allowedLiteralDirs);
    const allowedPaths = new Set([...allowedLiteralDirs, ...allowedLiteralFiles]);
    const ignoredWhitelist = await buildIgnoredWhitelist(candidatePaths, cwd, fsModule);
    const ignoredLog = new Set();
    const filteredCandidates = candidatePaths.filter((filePath) => {
        const ignoredDir = findIgnoredAncestor(filePath, cwd, resolvedLiteralDirs, allowedPaths, ignoredWhitelist);
        if (!ignoredDir) {
            return true;
        }
        const displayFile = relativePath(filePath, cwd);
        const key = `${ignoredDir}|${displayFile}`;
        if (!ignoredLog.has(key)) {
            console.log(`Skipping default-ignored path: ${displayFile} (matches ${ignoredDir})`);
            ignoredLog.add(key);
        }
        return false;
    });
    if (filteredCandidates.length === 0) {
        throw new FileValidationError("No files matched the provided --file patterns.", {
            patterns: partitioned.globPatterns,
            excludes: partitioned.excludePatterns,
        });
    }
    const oversized = [];
    const accepted = [];
    for (const filePath of filteredCandidates) {
        let stats;
        try {
            stats = await fsModule.stat(filePath);
        }
        catch (error) {
            throw new FileValidationError(`Missing file or directory: ${relativePath(filePath, cwd)}`, { path: filePath }, error);
        }
        if (!stats.isFile()) {
            continue;
        }
        if (maxFileSizeBytes && typeof stats.size === "number" && stats.size > maxFileSizeBytes) {
            const relative = path.relative(cwd, filePath) || filePath;
            oversized.push(`${relative} (${formatBytes(stats.size)})`);
            continue;
        }
        accepted.push(filePath);
    }
    if (oversized.length > 0) {
        throw new FileValidationError(`The following files exceed the ${formatBytes(maxFileSizeBytes)} limit:\n- ${oversized.join("\n- ")}`, {
            files: oversized,
            limitBytes: maxFileSizeBytes,
        });
    }
    const files = [];
    for (const filePath of accepted) {
        const content = readContents ? await fsModule.readFile(filePath, "utf8") : "";
        files.push({ path: filePath, content });
    }
    return files;
}
async function partitionFileInputs(rawPaths, cwd, fsModule) {
    const result = {
        globPatterns: [],
        excludePatterns: [],
        literalFiles: [],
        literalDirectories: [],
    };
    for (const entry of rawPaths) {
        const raw = entry?.trim();
        if (!raw) {
            continue;
        }
        if (raw.startsWith("!")) {
            const normalized = normalizeGlob(raw.slice(1), cwd);
            if (normalized) {
                result.excludePatterns.push(normalized);
            }
            continue;
        }
        if (fg.isDynamicPattern(raw)) {
            result.globPatterns.push(normalizeGlob(raw, cwd));
            continue;
        }
        const absolutePath = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
        let stats;
        try {
            stats = await fsModule.stat(absolutePath);
        }
        catch (error) {
            throw new FileValidationError(`Missing file or directory: ${raw}`, { path: absolutePath }, error);
        }
        if (stats.isDirectory()) {
            result.literalDirectories.push(absolutePath);
        }
        else if (stats.isFile()) {
            result.literalFiles.push(absolutePath);
        }
        else {
            throw new FileValidationError(`Not a file or directory: ${raw}`, { path: absolutePath });
        }
    }
    return result;
}
async function expandWithNativeGlob(partitioned, cwd) {
    const patterns = [
        ...partitioned.globPatterns,
        ...partitioned.literalFiles.map((absPath) => toPosixRelativeOrBasename(absPath, cwd)),
        ...partitioned.literalDirectories.map((absDir) => makeDirectoryPattern(toPosixRelative(absDir, cwd))),
    ].filter(Boolean);
    if (patterns.length === 0) {
        return [];
    }
    const dotfileOptIn = patterns.some((pattern) => includesDotfileSegment(pattern));
    const gitignoreSets = await loadGitignoreSets(cwd);
    const matches = (await fg(patterns, {
        cwd,
        absolute: false,
        dot: true,
        ignore: partitioned.excludePatterns,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
    }));
    const resolved = matches.map((match) => path.resolve(cwd, match));
    const filtered = resolved.filter((filePath) => !isGitignored(filePath, gitignoreSets));
    const finalFiles = dotfileOptIn
        ? filtered
        : filtered.filter((filePath) => !path.basename(filePath).startsWith("."));
    return Array.from(new Set(finalFiles));
}
async function loadGitignoreSets(cwd) {
    const gitignorePaths = await fg("**/.gitignore", {
        cwd,
        dot: true,
        absolute: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
    });
    const sets = [];
    for (const filePath of gitignorePaths) {
        try {
            const raw = await fs.readFile(filePath, "utf8");
            const patterns = raw
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0 && !line.startsWith("#"));
            if (patterns.length > 0) {
                sets.push({ dir: path.dirname(filePath), patterns });
            }
        }
        catch {
            // Ignore unreadable .gitignore files
        }
    }
    // Ensure deterministic parent-before-child ordering
    return sets.sort((a, b) => a.dir.localeCompare(b.dir));
}
function isGitignored(filePath, sets) {
    for (const { dir, patterns } of sets) {
        if (!filePath.startsWith(dir)) {
            continue;
        }
        const relative = path.relative(dir, filePath) || path.basename(filePath);
        if (matchesAny(relative, patterns)) {
            return true;
        }
    }
    return false;
}
async function buildIgnoredWhitelist(filePaths, cwd, fsModule) {
    const whitelist = new Set();
    for (const filePath of filePaths) {
        const absolute = path.resolve(filePath);
        const rel = path.relative(cwd, absolute);
        const parts = rel.split(path.sep).filter(Boolean);
        for (let i = 0; i < parts.length - 1; i += 1) {
            const part = parts[i];
            if (!DEFAULT_IGNORED_DIRS.has(part)) {
                continue;
            }
            const dirPath = path.resolve(cwd, ...parts.slice(0, i + 1));
            if (whitelist.has(dirPath)) {
                continue;
            }
            try {
                const stats = await fsModule.stat(path.join(dirPath, ".gitignore"));
                if (stats.isFile()) {
                    whitelist.add(dirPath);
                }
            }
            catch {
                // no .gitignore at this level; keep ignored
            }
        }
    }
    return whitelist;
}
function findIgnoredAncestor(filePath, cwd, _literalDirs, allowedPaths, ignoredWhitelist) {
    const absolute = path.resolve(filePath);
    if (Array.from(allowedPaths).some((allowed) => absolute === allowed || absolute.startsWith(`${allowed}${path.sep}`))) {
        return null; // explicitly requested path overrides default ignore when the ignored dir itself was passed
    }
    const rel = path.relative(cwd, absolute);
    const parts = rel.split(path.sep);
    for (let idx = 0; idx < parts.length; idx += 1) {
        const part = parts[idx];
        if (!DEFAULT_IGNORED_DIRS.has(part)) {
            continue;
        }
        const ignoredDir = path.resolve(cwd, parts.slice(0, idx + 1).join(path.sep));
        if (ignoredWhitelist.has(ignoredDir)) {
            continue;
        }
        return part;
    }
    return null;
}
function matchesAny(relativePath, patterns) {
    return patterns.some((pattern) => matchesPattern(relativePath, pattern));
}
function matchesPattern(relativePath, pattern) {
    if (!pattern) {
        return false;
    }
    const normalized = pattern.replace(/\\+/g, "/");
    // Directory rule
    if (normalized.endsWith("/")) {
        const dir = normalized.slice(0, -1);
        return relativePath === dir || relativePath.startsWith(`${dir}/`);
    }
    // Simple glob support (* and **)
    const regex = globToRegex(normalized);
    return regex.test(relativePath);
}
function globToRegex(pattern) {
    const withMarkers = pattern.replace(/\*\*/g, "§§DOUBLESTAR§§").replace(/\*/g, "§§SINGLESTAR§§");
    const escaped = withMarkers.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const restored = escaped.replace(/§§DOUBLESTAR§§/g, ".*").replace(/§§SINGLESTAR§§/g, "[^/]*");
    return new RegExp(`^${restored}$`);
}
function includesDotfileSegment(pattern) {
    const segments = pattern.split("/");
    return segments.some((segment) => segment.startsWith(".") && segment.length > 1);
}
async function expandWithCustomFs(partitioned, fsModule) {
    const paths = new Set();
    partitioned.literalFiles.forEach((file) => {
        paths.add(file);
    });
    for (const directory of partitioned.literalDirectories) {
        const nested = await expandDirectoryRecursive(directory, fsModule);
        nested.forEach((entry) => {
            paths.add(entry);
        });
    }
    return Array.from(paths);
}
async function expandDirectoryRecursive(directory, fsModule) {
    const entries = await fsModule.readdir(directory);
    const results = [];
    for (const entry of entries) {
        const childPath = path.join(directory, entry);
        const stats = await fsModule.stat(childPath);
        if (stats.isDirectory()) {
            results.push(...(await expandDirectoryRecursive(childPath, fsModule)));
        }
        else if (stats.isFile()) {
            results.push(childPath);
        }
    }
    return results;
}
function makeDirectoryPattern(relative) {
    if (relative === "." || relative === "") {
        return "**/*";
    }
    return `${stripTrailingSlashes(relative)}/**/*`;
}
function isNativeFsModule(fsModule) {
    return (fsModule.__nativeFs === true ||
        (fsModule.readFile === DEFAULT_FS.readFile &&
            fsModule.stat === DEFAULT_FS.stat &&
            fsModule.readdir === DEFAULT_FS.readdir));
}
function normalizeGlob(pattern, cwd) {
    if (!pattern) {
        return "";
    }
    let normalized = pattern;
    if (path.isAbsolute(normalized)) {
        normalized = path.relative(cwd, normalized);
    }
    normalized = toPosix(normalized);
    if (normalized.startsWith("./")) {
        normalized = normalized.slice(2);
    }
    return normalized;
}
function toPosix(value) {
    return value.replace(/\\/g, "/");
}
function toPosixRelative(absPath, cwd) {
    const relative = path.relative(cwd, absPath);
    if (!relative) {
        return ".";
    }
    return toPosix(relative);
}
function toPosixRelativeOrBasename(absPath, cwd) {
    const relative = path.relative(cwd, absPath);
    return toPosix(relative || path.basename(absPath));
}
function stripTrailingSlashes(value) {
    const normalized = toPosix(value);
    return normalized.replace(/\/+$/g, "");
}
function formatBytes(size) {
    if (size >= 1024 * 1024) {
        return `${formatScaled(size / (1024 * 1024))} MB`;
    }
    if (size >= 1024) {
        return `${formatScaled(size / 1024)} KB`;
    }
    return `${size} B`;
}
function formatScaled(value) {
    return value.toFixed(1).replace(/\.0$/, "");
}
export function normalizeMaxFileSizeBytes(value, source = "max file size") {
    if (value == null || value === "") {
        return undefined;
    }
    const parsed = typeof value === "number"
        ? value
        : Number.parseInt(typeof value === "string" ? value.trim() : String(value), 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${source} must be a positive integer number of bytes.`);
    }
    return parsed;
}
function relativePath(targetPath, cwd) {
    const relative = path.relative(cwd, targetPath);
    return relative || targetPath;
}
function formatLegacyFileSection(index, displayPath, content) {
    return [`### File ${index}: ${displayPath}`, "```", content.trimEnd(), "```"].join("\n");
}
export function createFileSections(files, cwd = process.cwd()) {
    return files.map((file, index) => {
        const relative = toPosix(path.relative(cwd, file.path) || file.path);
        const sectionText = formatLegacyFileSection(index + 1, relative, file.content);
        return {
            index: index + 1,
            absolutePath: file.path,
            displayPath: relative,
            sectionText,
            content: file.content,
        };
    });
}
