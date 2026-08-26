import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}
export async function computeCaseCorpusDigest(casePaths) {
    const documents = await Promise.all(casePaths.map(async (filePath) => canonicalJson(JSON.parse(await readFile(filePath, 'utf8')))));
    documents.sort();
    return `sha256:${createHash('sha256').update(documents.join('\n')).digest('hex')}`;
}
//# sourceMappingURL=corpus-digest.js.map