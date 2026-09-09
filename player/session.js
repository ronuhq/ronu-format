// The session record: the engine's event log shaped as xAPI-like statements.
//
// Identity follows spec section 3: the activity IRI comes from manifest.json
// (`activityIri`), and node sub-activities hang off it as `{iri}/nodes/{id}`.
// The verbs are the ADL set; the simulation-grade detail (branches taken,
// hotspots, timer expiries, variable changes) rides in extensions under
// https://ronunest.com/xapi/ext/. Nothing here touches the network.

const VERB = {
  launched: 'http://adlnet.gov/expapi/verbs/launched',
  experienced: 'http://adlnet.gov/expapi/verbs/experienced',
  answered: 'http://adlnet.gov/expapi/verbs/answered',
  interacted: 'http://adlnet.gov/expapi/verbs/interacted',
  completed: 'http://adlnet.gov/expapi/verbs/completed',
  passed: 'http://adlnet.gov/expapi/verbs/passed',
  failed: 'http://adlnet.gov/expapi/verbs/failed',
  exited: 'http://adlnet.gov/expapi/verbs/exited',
};
const EXT = 'https://ronunest.com/xapi/ext/';
export const PLACEHOLDER_ACTOR = { account: { name: 'local' } };

function verbObj(id) {
  return { id, display: { en: id.split('/').pop() } };
}

export function activityIriFor(manifest) {
  if (manifest?.activityIri) return manifest.activityIri;
  const family = manifest?.module?.familyId;
  return family ? `https://ronunest.com/xapi/modules/${family}` : 'urn:ronu:unknown';
}

/**
 * Map engine events to statements.
 * @param {Array} events   engine.events
 * @param {object} manifest
 * @param {object} [opts]  { actor, module, registration }
 */
export function buildStatements(events, manifest, opts = {}) {
  const actor = opts.actor ?? PLACEHOLDER_ACTOR;
  const iri = activityIriFor(manifest);
  const title = manifest?.module?.title ?? 'Untitled';
  const nodes = new Map((opts.module?.nodes ?? []).map((n) => [n?.id, n]));
  const moduleObject = { id: iri, objectType: 'Activity', definition: { name: { en: title } } };
  const nodeObject = (nodeId) => {
    const n = nodes.get(nodeId);
    return { id: `${iri}/nodes/${encodeURIComponent(nodeId ?? '')}`, objectType: 'Activity', definition: { name: { en: n?.config?.title ?? n?.title ?? nodeId ?? '' }, type: n ? `${EXT}node/${n.type}` : undefined } };
  };
  const context = { contextActivities: { parent: [{ id: iri, objectType: 'Activity' }] } };
  if (opts.registration) context.registration = opts.registration;
  const base = (e, verb, object, extra = {}) => ({
    id: `urn:ronu:statement:${e.at}-${String(e.seq).replace('.', '-')}`,
    timestamp: new Date(e.at).toISOString(),
    actor, verb: verbObj(verb), object, context, ...extra,
  });

  const out = [];
  for (const e of events) {
    switch (e.type) {
      case 'launched':
        out.push(base(e, VERB.launched, moduleObject));
        break;
      case 'entered':
        out.push(base(e, VERB.experienced, nodeObject(e.nodeId)));
        break;
      case 'answered': {
        const result = { response: typeof e.response === 'string' ? e.response : JSON.stringify(e.response) };
        if (typeof e.score === 'number') result.score = { raw: e.score, min: 0, max: 100, scaled: e.score / 100 };
        const ext = e.texts ? { [`${EXT}answer-labels`]: e.texts } : undefined;
        out.push(base(e, VERB.answered, nodeObject(e.nodeId), { result: ext ? { ...result, extensions: ext } : result }));
        break;
      }
      case 'variable':
        out.push(base(e, VERB.interacted, moduleObject, { result: { extensions: { [`${EXT}variable-changed`]: { variableId: e.variableId, name: e.name, from: e.from, to: e.to, source: e.source } } } }));
        break;
      case 'branch':
        out.push(base(e, VERB.experienced, nodeObject(e.nodeId), { result: { extensions: { [`${EXT}branch-taken`]: { fromNodeId: e.nodeId, targetId: e.targetNodeId } } } }));
        break;
      case 'hotspot':
        out.push(base(e, VERB.experienced, { id: `${iri}/nodes/${encodeURIComponent(e.nodeId)}/hotspots/${encodeURIComponent(e.hotspotId)}`, objectType: 'Activity', definition: { name: { en: e.label ?? e.hotspotId } } }, { result: { extensions: { [`${EXT}scene-hotspot`]: { nodeId: e.nodeId, hotspotId: e.hotspotId } } } }));
        break;
      case 'scene-miss':
        out.push(base(e, VERB.interacted, nodeObject(e.nodeId), { result: { success: false, extensions: { [`${EXT}scene-miss`]: e.point } } }));
        break;
      case 'timer-expiry':
        out.push(base(e, VERB.interacted, e.nodeId ? nodeObject(e.nodeId) : moduleObject, { result: { extensions: { [`${EXT}timer-expiry`]: { scope: e.scope, nodeId: e.nodeId ?? undefined, behavior: e.behavior } } } }));
        break;
      case 'procedure-step':
      case 'procedure-misstep':
        out.push(base(e, VERB.interacted, nodeObject(e.nodeId), { result: { success: e.type === 'procedure-step', extensions: { [`${EXT}procedure-step`]: { step: e.step, expected: e.expected, critical: e.critical } } } }));
        break;
      case 'completed': {
        const result = { completion: true };
        if (typeof e.score === 'number') result.score = { raw: e.score, min: 0, max: 100, scaled: Math.max(0, Math.min(1, e.score / 100)) };
        if (e.passed === true || e.passed === false) result.success = e.passed;
        out.push(base(e, VERB.completed, moduleObject, { result }));
        if (e.passed === true) out.push(base({ ...e, seq: e.seq + 0.5 }, VERB.passed, moduleObject, { result }));
        if (e.passed === false) out.push(base({ ...e, seq: e.seq + 0.5 }, VERB.failed, moduleObject, { result }));
        break;
      }
      default:
        break; // exited, skipped, trigger: kept in the raw log, not as statements
    }
  }
  return out;
}

/** The whole downloadable record. */
export function sessionRecord(engine, manifest, opts = {}) {
  const view = engine.view();
  return {
    format: 'ronu-session',
    generatedAt: new Date().toISOString(),
    player: 'ronu-reference-player',
    activityIri: activityIriFor(manifest),
    module: { familyId: manifest?.module?.familyId ?? null, versionId: manifest?.module?.versionId ?? null, title: manifest?.module?.title ?? null },
    actor: opts.actor ?? PLACEHOLDER_ACTOR,
    result: view.kind === 'end' ? view.result : null,
    variables: view.variables,
    responses: engine.responses,
    nodeScores: engine.nodeScores,
    trail: engine.trail,
    statements: buildStatements(engine.events, manifest, { ...opts, module: engine.module }),
    rawEvents: engine.events,
  };
}
