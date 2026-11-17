import {canonical,fingerprint,validateReviewBundle} from "./contract.mjs";

export const VERDICTS = ["would-take","acceptable","feels-off","would-avoid","cannot-judge"];
export const CHOICES = ["A","B","equivalent","neither","cannot-judge"];
export const REASONS = ["walking-away-back","unnecessary-loop","excessive-walk","awkward-crossing","fragile-connection","long-wait","confusing-boarding","safety-accessibility","other"];
const fail = message => {throw new Error(`Invalid review actions: ${message}`);};
const same = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const text = (value,max) => typeof value === "string" && value.length <= max;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys = (object,names) => object && typeof object === "object" && !Array.isArray(object)
  && Object.keys(object).length === names.length && names.every(name=>Object.hasOwn(object,name));

async function assignmentsFor(bundle,seed) {
  const assignments=[];
  for(const row of bundle.cases) {
    const scored=await Promise.all(row.candidates.map(async(candidate,index)=>({
      id:candidate.id,index,score:await fingerprint({seed,caseId:row.id,candidateId:candidate.id,index}),
    })));
    scored.sort((a,b)=>(a.score<b.score?-1:a.score>b.score?1:0)||a.index-b.index);
    assignments.push({caseId:row.id,candidateIds:scored.map(candidate=>candidate.id)});
  }
  return assignments;
}

export async function createReviewSession(bundle,reviewerId,seed=crypto.randomUUID()) {
  await validateReviewBundle(bundle);
  if (!text(reviewerId,200) || !reviewerId.trim() || !text(seed,200) || !seed.trim()) fail("reviewer and seed required");
  return {id:await fingerprint({bundleId:bundle.bundleId,reviewerId,seed}),reviewerId,seed,
    assignments:await assignmentsFor(bundle,seed),actions:[]};
}

function validateAction(action,row,previous) {
  if (!digest(action.id) || !text(action.at,40) || !Number.isFinite(Date.parse(action.at))) fail("invalid action identity or time");
  if (action.kind === "undo") {
    if (!keys(action,["id","kind","at","targetActionId"])) fail("invalid undo fields");
    const target=previous.find(item=>item.id===action.targetActionId);
    if (!target || target.kind === "undo" || previous.some(item=>item.kind==="undo"&&item.targetActionId===target.id)) fail("undo target missing or already undone");
    return;
  }
  if (!row) fail("stale or unknown case");
  if (action.kind === "skip") {
    if (!keys(action,["id","kind","at","caseId"])) fail("invalid skip fields");
    return;
  }
  const common=["id","kind","at","caseId","confidence","familiarity","reasons","notes"];
  if (!["low","medium","high"].includes(action.confidence)
      || !["unknown","visitor","local"].includes(action.familiarity)
      || !Array.isArray(action.reasons) || !action.reasons.every(reason=>REASONS.includes(reason))
      || new Set(action.reasons).size!==action.reasons.length || !text(action.notes,10000)) fail("invalid judgment context");
  const candidates=new Set(row.candidates.map(candidate=>candidate.id));
  if (action.kind === "judge") {
    if (!keys(action,[...common,"candidateId","verdict"]) || !candidates.has(action.candidateId)
        || !VERDICTS.includes(action.verdict)) fail("stale candidate or invalid judgment");
  } else if (action.kind === "compare") {
    if (!keys(action,[...common,"candidateIds","choice"]) || !Array.isArray(action.candidateIds)
        || action.candidateIds.length!==2 || action.candidateIds[0]===action.candidateIds[1]
        || !action.candidateIds.every(id=>candidates.has(id)) || !CHOICES.includes(action.choice)) fail("stale pair or invalid choice");
  } else fail("unsupported action kind");
}

async function validateSession(session,bundle) {
  if (!keys(session,["id","reviewerId","seed","assignments","actions"])
      || !text(session.reviewerId,200) || !session.reviewerId.trim()
      || !text(session.seed,200) || !session.seed.trim() || !Array.isArray(session.actions)) fail("invalid session");
  if (session.id !== await fingerprint({bundleId:bundle.bundleId,reviewerId:session.reviewerId,seed:session.seed})) fail("stale session identity");
  if (!same(session.assignments,await assignmentsFor(bundle,session.seed))) fail("blind assignment changed");
  const rows=new Map(bundle.cases.map(row=>[row.id,row]));
  const previous=[];
  for(const [index,action] of session.actions.entries()) {
    validateAction(action,rows.get(action.caseId),previous);
    const {id,...content}=action;
    if (id!==await fingerprint({sessionId:session.id,index,action:content})) fail("action identity mismatch");
    if (action.kind === "compare") {
      const order=session.assignments.find(item=>item.caseId===action.caseId).candidateIds;
      if (order.indexOf(action.candidateIds[0])>=order.indexOf(action.candidateIds[1])) fail("pair does not match blind order");
    }
    previous.push(action);
  }
  return session;
}

export async function appendReviewAction(bundle,session,input,at=new Date().toISOString()) {
  await validateReviewBundle(bundle);
  await validateSession(session,bundle);
  // Clone data so later form edits cannot mutate a committed action.
  const content=canonical({...input,at});
  const action={...content,id:await fingerprint({sessionId:session.id,index:session.actions.length,action:content})};
  const next={...structuredClone(session),actions:[...structuredClone(session.actions),action]};
  await validateSession(next,bundle);
  return next;
}

export function effectiveReviewActions(session) {
  const undone=new Set(session.actions.filter(action=>action.kind==="undo").map(action=>action.targetActionId));
  return session.actions.filter(action=>action.kind!=="undo"&&!undone.has(action.id));
}

export async function reviewActionsFile(bundle,sessions) {
  const file={format:"ptn-search-review-actions",version:1,bundleId:bundle.bundleId,sessions:structuredClone(sessions)};
  return validateReviewActions(file,bundle);
}

export async function validateReviewActions(file,bundle) {
  await validateReviewBundle(bundle);
  if (!keys(file,["format","version","bundleId","sessions"]) || file.format!=="ptn-search-review-actions"
      || file.version!==1 || file.bundleId!==bundle.bundleId || !Array.isArray(file.sessions)) fail("unsupported or stale bundle");
  const ids=new Set();
  for(const session of file.sessions) {
    await validateSession(session,bundle);
    if(ids.has(session.id)) fail("duplicate session");
    ids.add(session.id);
  }
  return file;
}

/** Idempotent import; independent reviewers stay separate. A fork of one
 * session must be resolved explicitly, never by replacing an opinion. */
export async function mergeReviewActions(left,right,bundle) {
  await validateReviewActions(left,bundle);
  await validateReviewActions(right,bundle);
  const sessions=structuredClone(left.sessions);
  for(const incoming of right.sessions) {
    const index=sessions.findIndex(session=>session.id===incoming.id);
    if(index<0) {sessions.push(structuredClone(incoming));continue;}
    const existing=sessions[index];
    const common=Math.min(existing.actions.length,incoming.actions.length);
    if(!same(existing.actions.slice(0,common),incoming.actions.slice(0,common))) fail("conflicting session branches; neither was overwritten");
    if(incoming.actions.length>existing.actions.length) sessions[index]=structuredClone(incoming);
  }
  return reviewActionsFile(bundle,sessions);
}
