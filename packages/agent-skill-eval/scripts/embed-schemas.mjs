import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const names = ['eval-execution-plan', 'eval-run-bundle', 'eval-audit-result', 'eval-runtime-capabilities']
const canonicalRoot = new URL('../../../plugins/agent-skill-toolkit/schemas/', import.meta.url)
const outputRoot = new URL('../dist/schemas/', import.meta.url)

await mkdir(outputRoot, { recursive: true })
const digests = {}
for (const name of names) {
  const fileName = `${name}.schema.json`
  const source = new URL(fileName, canonicalRoot)
  const destination = new URL(fileName, outputRoot)
  const bytes = await readFile(source)
  await copyFile(source, destination)
  const normalized = JSON.stringify(JSON.parse(bytes.toString('utf8')))
  digests[name] = `sha256:${createHash('sha256').update(normalized).digest('hex')}`
}
await writeFile(new URL('digests.json', outputRoot), `${JSON.stringify(digests, null, 2)}\n`, 'utf8')
