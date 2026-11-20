import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { clients, sha256 } from './native-platform-runtime.mjs';
import { readPublicOpenCodeManualSkill } from './native-platform-opencode-public.mjs';

const piProbe = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const [packageEntry, name, packageDirectory, expectedSha256] = process.argv.slice(1);
const { createAgentSession, DefaultResourceLoader, formatSkillsForPrompt, SessionManager } = await import(pathToFileURL(packageEntry).href);
const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR;
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noContextFiles: true });
await resourceLoader.reload();
const matches = resourceLoader.getSkills().skills.filter(skill => skill.name === name);
assert.equal(matches.length, 1, 'pi-native-manual-skill-discovery-mismatch');
const [skill] = matches;
const skillPath = path.join(packageDirectory, 'skills', name, 'SKILL.md');
assert.equal(await fs.realpath(skill.filePath), await fs.realpath(skillPath), 'pi-native-manual-skill-location-mismatch');
assert.equal(skill.disableModelInvocation, true, 'pi-native-manual-skill-policy-mismatch');
const contents = await fs.readFile(skillPath, 'utf8');
const frontmatter = /^---\\r?\\n[\\s\\S]*?\\r?\\n---(?:\\r?\\n|$)/u.exec(contents);
assert(frontmatter, 'pi-native-manual-skill-frontmatter-invalid');
const body = contents.slice(frontmatter[0].length);
const bodySha256 = createHash('sha256').update(body).digest('hex');
assert.equal(bodySha256, expectedSha256, 'pi-native-manual-skill-body-mismatch');
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, tools: ['read'], sessionManager: SessionManager.inMemory() });
try {
  const guidanceEntry = '<name>' + name + '</name>';
  assert(formatSkillsForPrompt([{ ...skill, disableModelInvocation: false }]).includes(guidanceEntry), 'pi-native-manual-guidance-control-mismatch');
  assert(!session.systemPrompt.includes(guidanceEntry) && !session.systemPrompt.includes(skill.filePath), 'pi-native-manual-system-prompt-discovery');
  const command = '/skill:' + name;
  const argument = 'AW offline qualification argument';
  const expected = '<skill name="' + name + '" location="' + skill.filePath + '">\\nReferences are relative to ' + skill.baseDir
    + '.\\n\\n' + body.trim() + '\\n</skill>\\n\\n' + argument;
  // Exercise the exact fixed-version slash expansion before any model or tool can run.
  assert(session._expandSkillCommand(command + ' ' + argument) === expected, 'pi-native-manual-slash-expansion-mismatch');
  console.log(JSON.stringify({ level: 'explicit-skill-command-expansion', invocation: command, modelGuidance: 'omitted',
    resolvedExactBody: true, bodySha256, modelRequests: 0 }));
} finally { session.dispose(); }
`;

function skillBody(source) {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(source);
  assert(frontmatter, 'manual-skill-source-frontmatter-invalid');
  return source.slice(frontmatter[0].length);
}

async function readPiManualSkill(ctx, cwd) {
  const entry = await fs.realpath(ctx.launcher.prefix[0] ?? ctx.publicClientEntry);
  const packageDirectory = path.resolve(path.dirname(entry), '../..');
  const metadata = JSON.parse(await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  assert.equal(metadata.name, clients.pi.package, 'pi-manual-sdk-package-mismatch');
  assert.equal(metadata.version, clients.pi.version, 'pi-manual-sdk-version-mismatch');
  assert.equal(await fs.realpath(path.resolve(packageDirectory, metadata.bin.pi)), entry, 'pi-manual-sdk-entry-mismatch');
  const sdk = path.join(packageDirectory, 'dist', 'index.js');
  const result = await ctx.rpc(cwd);
  assert.equal(result.state.messageCount, 0, 'pi-manual-inventory-session-not-empty');
  assert.equal(result.state.pendingMessageCount, 0, 'pi-manual-inventory-session-not-idle');
  assert.equal(result.state.isStreaming, false, 'pi-manual-inventory-model-boundary-unverified');
  const commands = result.commands.commands.filter(item => item.name === `skill:${ctx.skillName}`);
  assert.equal(commands.length, 1, 'pi-manual-command-availability-mismatch');
  const [command] = commands;
  assert.equal(command.source, 'skill', 'pi-manual-command-source-mismatch');
  assert.equal(command.sourceInfo?.scope, ctx.scope, 'pi-manual-command-scope-mismatch');
  assert.equal(command.sourceInfo?.origin, 'package', 'pi-manual-command-origin-mismatch');
  const packagePath = await fs.realpath(command.sourceInfo.baseDir);
  const relative = path.relative(ctx.root, packagePath);
  assert(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`), 'pi-manual-command-package-outside-fixture');
  const source = await fs.readFile(ctx.publicSkillFile, 'utf8');
  const bodySha256 = sha256(skillBody(source));
  const probe = await ctx.command(['--input-type=module', '-e', piProbe, sdk, ctx.skillName, packagePath, bodySha256], cwd,
    { launcher: { executable: process.execPath, prefix: [] } });
  assert.equal(probe.terminationReason, 'complete', 'pi-manual-command-process-incomplete');
  const observed = JSON.parse(probe.stdout);
  assert.equal(observed.bodySha256, bodySha256, 'pi-manual-command-body-mismatch');
  return observed;
}

export async function readPublicManualSkill(ctx, cwd = ctx.project) {
  if (ctx.platform === 'pi') return readPiManualSkill(ctx, cwd);
  assert.equal(ctx.platform, 'opencode', 'manual-skill-platform-unverified');
  const result = await readPublicOpenCodeManualSkill(ctx, cwd);
  return { ...result, modelGuidance: 'omitted-by-registry-policy-in-fixed-v2-runtime', modelRequests: 0 };
}
