import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function participantSkills(ownerSkill, includeOwner) {
  const raw = process.env.AW_PLUGIN_EVAL_PARTICIPANT_SKILLS;
  if (!raw) throw new Error('AW_PLUGIN_EVAL_PARTICIPANT_SKILLS is required.');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.includes(ownerSkill)) {
    throw new Error(`Eval participants must include owner Skill ${ownerSkill}.`);
  }
  return new Set(includeOwner ? parsed : parsed.filter((entry) => entry !== ownerSkill));
}

export async function isolateMaterializedSkills(agentsRoot, ownerSkill, includeOwner) {
  const allowed = participantSkills(ownerSkill, includeOwner);
  const skillsRoot = path.join(agentsRoot, 'skills');
  for (const entry of await readdir(skillsRoot)) {
    if (!allowed.has(entry)) {
      await rm(path.join(skillsRoot, entry), { recursive: true, force: true });
    }
  }
}
