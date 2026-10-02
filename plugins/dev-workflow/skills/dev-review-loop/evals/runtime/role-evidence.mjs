/**
 * Eval-only arrangement check using observed Engine fields.
 * It does not grade review content or infer independence from task text.
 * scopeThreadIds and rootAxisProof must be produced from trusted Engine evidence;
 * an absent mapper/proof remains unknown. Not a production Skill protocol.
 */
const AXES = new Map([['design-reviewer','design'], ['quality-reviewer','quality']]);
const result = (verdict, reason) => ({ name: 'axis-arrangement', verdict, evidence: reason });

export function checkIndependentArrangement(evidence, options = {}) {
  if (!evidence || !Array.isArray(evidence.threadGraph) || !Array.isArray(evidence.collaborationCalls)
      || !Array.isArray(evidence.skillLoads) || typeof evidence.rootThreadId !== 'string') {
    return result('unknown', 'Missing actual Engine identity, graph, calls or skill-load evidence.');
  }
  if (!Array.isArray(options.scopeThreadIds) || !options.scopeThreadIds.length) {
    return result('unknown', 'Current review scope/round has not been bound to actual threads.');
  }
  const scope = new Set(options.scopeThreadIds);
  const rootId = evidence.rootThreadId;
  const reviewers = evidence.threadGraph.filter(t => scope.has(t.threadId) && t.threadId !== rootId && AXES.has(t.agentRole));
  const ids = new Set(reviewers.map(t => t.threadId));
  if (ids.size !== reviewers.length) return result('fail', 'Duplicate identity records.');
  // Reject this scope's same-review expansion, not unrelated authorised evidence work.
  const repeated = evidence.threadGraph.some(t => ids.has(t.parentThreadId) && AXES.has(t.agentRole));
  if (repeated) return result('fail', 'Assigned axis agent delegated another copy of the same review.');
  const proofs = [];
  for (const t of reviewers) {
    const spawn = evidence.collaborationCalls.find(c => c.tool === 'spawn_agent' && c.linkedThreadId === t.threadId);
    if (!spawn || spawn.status !== 'completed') return result('unknown', 'Actual completed spawn evidence missing.');
    const args = spawn.arguments || {};
    if (args.fork_turns === 'all' || args.fork_context === true) return result('fail', 'Review agent inherited author working history.');
    if (!(args.fork_turns === 'none' || args.fork_context === false)) return result('unknown', 'Context isolation not established.');
    if (!evidence.skillLoads.some(s => s.threadId === t.threadId && s.skill === 'dev-review-code')) {
      return result('unknown', 'Assigned reviewer method use not observed.');
    }
    if (t.parentThreadId !== rootId) return result('unknown', 'Review coordinator lineage requires a verified mapping.');
    proofs.push({ actor: t.threadId, axis: AXES.get(t.agentRole) });
  }
  const p = options.rootAxisProof;
  if (p) {
    if (options.rootIndependent === false) return result('fail', 'Author/root history cannot count as an independent axis.');
    if (options.rootIndependent !== true || !scope.has(rootId)) return result('unknown', 'Root independence is not proven by setup.');
    if (!['design','quality'].includes(p.axis) || typeof p.sourceRef !== 'string' || !p.sourceRef
        || !Number.isInteger(p.judgmentOrdinal) || !Number.isInteger(p.firstOtherConclusionReadOrdinal)) {
      return result('unknown', 'Root judgment and first exposure to other conclusions require sourced actual events.');
    }
    if (p.judgmentOrdinal >= p.firstOtherConclusionReadOrdinal) {
      return result('fail', 'Root judgment was formed after reading another axis conclusion.');
    }
    if (!evidence.skillLoads.some(s => s.threadId === rootId && s.skill === 'dev-review-code')) {
      return result('unknown', 'Root method use not observed.');
    }
    proofs.push({ actor: rootId, axis: p.axis });
  }
  if (proofs.length !== 2 || new Set(proofs.map(p=>p.actor)).size !== 2 || new Set(proofs.map(p=>p.axis)).size !== 2) {
    return result('fail', 'This scope does not have exactly two distinct independent axis assignments.');
  }
  return result('pass', JSON.stringify(proofs));
}

/** Missing/unknown required evidence is never dropped from the denominator. */
export function combineRequiredChecks(required, checks) {
  if (!Array.isArray(required) || !required.length || new Set(required).size !== required.length || !Array.isArray(checks)) {
    throw new TypeError('Distinct required check names and a check array are required.');
  }
  const normalized = required.map(name => {
    const matches = checks.filter(c=>c?.name===name);
    if (matches.length !== 1) return {name,verdict:'unknown',evidence:'Missing or duplicate check.'};
    const c=matches[0];
    if (!['pass','fail','unknown'].includes(c.verdict) || typeof c.evidence !== 'string' || !c.evidence) {
      return {name,verdict:'unknown',evidence:'Malformed or unsupported evidence.'};
    }
    return c;
  });
  const complete=normalized.every(c=>c.verdict!=='unknown');
  const passed=complete && normalized.every(c=>c.verdict==='pass');
  // This is compatible with the observed adapter result envelope; the runner's
  // UI treatment of details.complete=false must still be verified on integration.
  return {passed,score:passed?1:0,details:{complete,checks:normalized}};
}
