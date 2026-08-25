export function supportedProfiles(manifest) {
  const products = Array.isArray(manifest.marketplace?.policy?.products)
    && manifest.marketplace.policy.products.length > 0
    ? manifest.marketplace.policy.products.map((value) => String(value).toUpperCase())
    : ['CODEX', 'CLAUDE'];
  return [...new Set(products.flatMap((product) => {
    if (product === 'CODEX') return ['codex-user', 'codex-project'];
    if (product === 'CLAUDE') return ['claude-user', 'claude-project'];
    return [];
  }))];
}

export function dynamicSkillLeaves(manifest) {
  const leaves = [];
  for (const target of manifest.artifacts?.targets ?? []) {
    if (target.target !== 'codex.skill' && target.target !== 'claude.skill') continue;
    const platform = target.target === 'claude.skill' ? 'claude' : 'codex';
    const sourceDir = (target.sourceDirs ?? []).find((entry) =>
      entry.replace(/^\.\//u, '') === `skills/${target.skillKey}`) ?? null;
    for (const scope of target.scopes ?? []) {
      leaves.push({
        id: target.id,
        name: target.skillKey,
        skillKey: target.skillKey,
        profile: `${platform}-${scope}`,
        sourceDir,
        requiresEval: true,
      });
    }
  }
  return leaves;
}

function platformForProfile(profile) {
  return profile.startsWith('claude-') ? 'claude' : 'codex';
}

export function reviewSkillLeafPlan(manifest, staticNames, requestedProfiles = supportedProfiles(manifest)) {
  const profiles = [...new Set(requestedProfiles)];
  const dynamic = dynamicSkillLeaves(manifest).filter((leaf) => profiles.includes(leaf.profile));
  const dynamicKeysByPlatform = new Map([
    ['codex', new Set()],
    ['claude', new Set()],
  ]);
  for (const leaf of dynamicSkillLeaves(manifest)) {
    dynamicKeysByPlatform.get(platformForProfile(leaf.profile)).add(leaf.skillKey);
  }
  const staticLeaves = [...new Set(staticNames)].sort().map((name) => ({
    name,
    profiles: profiles.filter((profile) =>
      !dynamicKeysByPlatform.get(platformForProfile(profile)).has(name)),
  })).filter((leaf) => leaf.profiles.length > 0);
  return {
    profiles,
    staticLeaves,
    dynamicLeaves: dynamic,
    finalLeaves: [
      ...staticLeaves.flatMap((leaf) => leaf.profiles.map((profile) => ({
        kind: 'static', name: leaf.name, profile, requiresEval: false,
      }))),
      ...dynamic.map((leaf) => ({ kind: 'dynamic', ...leaf })),
    ],
  };
}
