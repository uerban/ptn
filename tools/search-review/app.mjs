import {validateReviewBundle} from "./contract.mjs";
import {VERDICTS,CHOICES,REASONS,createReviewSession,appendReviewAction,effectiveReviewActions,reviewActionsFile,validateReviewActions,mergeReviewActions} from "./state.mjs";

const $=id=>document.getElementById(id);
const LAST="ptn-search-review-last-v1",key=id=>`ptn-search-review-v1:${id}`;
let model={bundle:null,actions:null,activeId:null,index:0,drafts:{}},diskValue=null,busy=false,pairs=[];
const session=()=>model.actions?.sessions.find(item=>item.id===model.activeId);
const row=()=>model.bundle?.cases[model.index];
const label=index=>index<0?"Unshown option":`Option ${index+1}`;
const readable=value=>String(value).replaceAll("-"," ");
const element=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;};
const tell=(message,error=false)=>{$("status").textContent=message;$("status").classList.toggle("error",error);};
const clock=seconds=>{if(!Number.isFinite(seconds))return "Unknown";const value=Math.abs(seconds);return `${seconds<0?"−":""}${String(Math.floor(value/3600)).padStart(2,"0")}:${String(Math.floor(value%3600/60)).padStart(2,"0")}:${String(Math.floor(value%60)).padStart(2,"0")}`;};
const minutes=seconds=>{if(!Number.isFinite(seconds))return "Unknown";const value=Math.ceil(seconds),mins=Math.floor(value/60),secs=value%60;return mins?`${mins} min${secs?` ${secs} s`:""}`:`${secs} s`;};

let labeledBundle=null,stopLabels=new Map();
function stopLabel(id) {
  if(labeledBundle!==model.bundle) {
    labeledBundle=model.bundle;
    stopLabels=new Map((model.bundle?.stopContext?.stops??[]).map(stop=>[stop.stopId,stop.name]));
  }
  const name=stopLabels.get(id);
  return name?.trim()?`${name} (${id})`:id??"Unknown stop";
}

function persist() {
  try {
    const storageKey=key(model.bundle.bundleId);
    if(localStorage.getItem(storageKey)!==diskValue) throw new Error("Progress changed in another tab. Reload to recover it; export this tab’s reviews first.");
    const next=JSON.stringify(model);
    localStorage.setItem(storageKey,next);diskValue=next;localStorage.setItem(LAST,model.bundle.bundleId);
    return true;
  } catch(error) {tell(`Progress is in memory only. Export reviews before closing. ${error.message}`,true);return false;}
}
async function perform(work) {
  if(busy)return;
  busy=true;updateDisabled();
  try {await work();}catch(error){tell(error.message,true);}
  finally{busy=false;updateDisabled();}
}
function updateDisabled() {
  const loaded=!!model.bundle,active=!!session(),hasCandidates=!!row()?.candidates.length;
  for(const node of document.querySelectorAll(".mutable")) node.disabled=busy;
  for(const id of ["actions-file","export","markdown","previous","next","start","case"]) $(id).disabled=busy||!loaded;
  $("previous").disabled||=model.index===0;$("next").disabled||=model.index>=((model.bundle?.cases.length??0)-1);
  $("judgment-fields").disabled=busy||!active||!hasCandidates;
  $("save").disabled=busy||!active||!hasCandidates||($("mode").value==="compare"&&pairs.length===0);
  $("skip").disabled=busy||!active||!row();
  $("undo").disabled=busy||!active||!effectiveReviewActions(session()).length;
}
function options(select,values,selected) {
  select.replaceChildren();
  for(const [value,text] of values) {const option=element("option",text);option.value=value;select.append(option);}
  if(values.some(([value])=>value===selected))select.value=selected;
}
function candidateOrder() {
  const current=row();if(!current)return [];
  const ids=session()?.assignments.find(item=>item.caseId===current.id)?.candidateIds;
  // Without a reviewer no source order is exposed; starting creates a blind order.
  return ids?.map(id=>current.candidates.find(candidate=>candidate.id===id))??[];
}
function frontendContext(candidate) {
  if(!candidate.source)return row().context;
  return model.bundle.comparison[candidate.source.side].cases.find(item=>item.id===candidate.source.caseId).context;
}
function pedestrianRoute(parent,route) {
  if(!route)return;
  parent.append(element("p",`Recorded pedestrian route · ${route.distanceMeters} m`));
  if(route.coords.length>1) {
    const xs=route.coords.map(point=>point[0]),ys=route.coords.map(point=>point[1]);
    const xmin=Math.min(...xs),ymin=Math.min(...ys),width=Math.max(...xs)-xmin,height=Math.max(...ys)-ymin;
    const svg=document.createElementNS("http://www.w3.org/2000/svg","svg"),line=document.createElementNS(svg.namespaceURI,"polyline");
    svg.setAttribute("viewBox","0 0 320 160");svg.setAttribute("role","img");svg.setAttribute("aria-label","Recorded pedestrian geometry; schematic without basemap");
    line.setAttribute("points",route.coords.map(([x,y])=>`${10+(width?(x-xmin)/width:0.5)*300},${150-(height?(y-ymin)/height:0.5)*140}`).join(" "));
    line.setAttribute("fill","none");line.setAttribute("stroke","currentColor");line.setAttribute("stroke-width","3");svg.append(line);parent.append(svg);
  }
  const steps=element("ol","");
  for(const step of route.steps)steps.append(element("li",`${step.kind??"Walk"}${step.name?` · ${step.name}`:""}${Number.isFinite(step.distanceMeters)?` · ${step.distanceMeters} m`:""}`));
  parent.append(steps);
}
function drawFrontendCandidate(card,candidate) {
  const itinerary=candidate.itinerary,context=frontendContext(candidate);
  const stops=new Map(context.stops.map(stop=>[stop.id,stop.name]));
  const name=id=>stops.get(id)?.trim()?`${stops.get(id)} (${id})`:id??"Unknown stop";
  card.append(element("p",`Arrival ${clock(itinerary.arrivalSecs)} · Full duration ${minutes(itinerary.totalSecs)} · Transfers ${itinerary.transfers}`));
  card.append(element("p",`Walking ${minutes(itinerary.totalWalkSecs)} · Distance ${Number.isFinite(itinerary.totalWalkMeters)?`${itinerary.totalWalkMeters} m`:"unknown"} · Access ${minutes(itinerary.sourceWalkSecs)} · Egress ${minutes(itinerary.destWalkSecs)}`));
  card.append(element("small","Times use the captured timetable frame. Planner timings below are observations, not a real-time correctness verdict."));
  if(itinerary.directWalk){card.append(element("h3","Walk directly"));pedestrianRoute(card,itinerary.directWalk.route);}
  for(const flag of ["cancelled","timingUnreliable"])if(itinerary[flag])card.append(element("p",`Captured flag: ${flag}`));
  if(itinerary.accessRunToCatch)card.append(element("p","Captured access requires running to catch the service."));
  const timeline=element("ol","");timeline.className="timeline";
  for(const [index,leg] of itinerary.legs.entries()) {
    const item=element("li","");if(leg.type==="walk")item.className="walk";
    item.append(element("strong",leg.type==="walk"?"Walk":`Transit ${leg.routeShortName??leg.mode??""}`));
    item.append(element("p",`${name(leg.fromStopId)} → ${name(leg.toStopId)}`));
    item.append(element("p",`Captured ${clock(leg.departSecs)}–${clock(leg.arriveSecs)} · ${minutes(leg.arriveSecs-leg.departSecs)}`));
    const scheduled=candidate.evidence.scheduled?.find(value=>value.index===index);
    if(scheduled)item.append(element("p",`Planner ${clock(scheduled.departSecs)}–${clock(scheduled.arriveSecs)}`));
    for(const flag of ["cancelled","timingUnreliable","approximate"])if(leg[flag])item.append(element("p",`Captured flag: ${flag}`));
    if(leg.type==="walk") {
      const evidence=candidate.evidence.walkRoutes.find(value=>value.index===index);
      if(evidence?.route)pedestrianRoute(item,evidence.route);
      else item.append(element("small",`${Number.isFinite(leg.distanceMeters)?`${leg.distanceMeters} m · `:""}Pedestrian geometry not uniquely captured`));
    }
    timeline.append(item);
  }
  card.append(timeline);
}
function drawCandidates(ordered) {
  $("candidates").replaceChildren();
  if(!row())return;
  if(!row().candidates.length){$("candidates").append(element("p","No captured candidates for this query. You may record an explicit skip."));return;}
  if(!session()){$("candidates").append(element("p","Start a reviewer session to show the alternatives in blind order."));return;}
  for(const [index,candidate] of ordered.entries()) {
    const card=element("article","");card.className="candidate";card.dataset.candidateId=candidate.id;
    card.append(element("h2",label(index)));
    if([3,4].includes(model.bundle.version)){drawFrontendCandidate(card,candidate);$("candidates").append(card);continue;}
    const itinerary=candidate.itinerary,legs=itinerary.legs;
    const estimatedJourney=legs.some(leg=>leg.type==="transit"&&leg.approximate===true),journeyMarker=estimatedJourney?"~":"";
    if(estimatedJourney) {
      const note=element("p","Includes approximate headway service; journey totals use estimated times.");note.className="badge";card.append(note);
    }
    const access=row().query.entryStops?.find(stop=>stop.stopId===legs[0]?.fromStopId)?.walkSecs;
    const egress=row().query.exitStops?.find(stop=>stop.stopId===legs.at(-1)?.toStopId)?.walkSecs;
    const total=Number.isFinite(egress)?itinerary.alightSecs+egress-row().query.departureSecs:NaN;
    card.append(element("p",`Arrival ${journeyMarker}${clock(Number.isFinite(egress)?itinerary.alightSecs+egress:NaN)} · Full duration ${journeyMarker}${minutes(total)} · Transfers ${itinerary.transfers??"Unknown"}`));
    const transferWalk=legs.filter(leg=>leg.type==="walk").reduce((sum,leg)=>sum+leg.arriveSecs-leg.departSecs,0);
    const riding=legs.filter(leg=>leg.type==="transit").reduce((sum,leg)=>sum+leg.arriveSecs-leg.departSecs,0);
    const walking=access+egress+transferWalk,waiting=total-riding-walking;
    card.append(element("p",`Walking ${minutes(walking)} · Waiting ${journeyMarker}${minutes(waiting)} · Access ${minutes(access)} · Egress ${minutes(egress)}`));
    card.append(element("small","Total walking distance unavailable at this boundary"));
    const timeline=element("ol","");timeline.className="timeline";
    for(const leg of legs) {
      const item=element("li","");if(leg.type==="walk")item.className="walk";
      item.append(element("strong",leg.type==="walk"?"Walk":`Transit ${leg.routeShortName??leg.mode??""}`));
      item.append(element("p",`${stopLabel(leg.fromStopId)} → ${stopLabel(leg.toStopId)}`));
      const estimated=leg.type==="transit"&&leg.approximate===true;
      const marker=estimated?"~":"";
      item.append(element("p",`${marker}${clock(leg.departSecs)}–${marker}${clock(leg.arriveSecs)} · ${minutes(leg.arriveSecs-leg.departSecs)}`));
      if(estimated)item.append(element("p","Headway estimate: departure and arrival are approximate."));
      if(leg.type==="walk") item.append(element("small",Number.isFinite(leg.distanceMeters)?`${leg.distanceMeters} m`:"Physical distance unknown"));
      else item.append(element("small",`Stop occurrences ${leg.boardStopIdx??"?"} → ${leg.alightStopIdx??"?"}`));
      timeline.append(item);
    }
    card.append(timeline);$("candidates").append(card);
  }
}
function renderForm(ordered) {
  const draft=model.drafts[row()?.id]??{};
  $("mode").value=draft.mode==="compare"?"compare":"judge";
  options($("target"),ordered.map((candidate,index)=>[candidate.id,label(index)]),draft.target);
  pairs=[];
  for(let a=0;a<ordered.length;a++)for(let b=a+1;b<ordered.length;b++)if(ordered[a].id!==ordered[b].id)
    pairs.push({id:`${a}:${b}`,candidateIds:[ordered[a].id,ordered[b].id],a:label(a),b:label(b)});
  options($("pair"),pairs.map(pair=>[pair.id,`${pair.a} vs ${pair.b}`]),draft.pair);
  renderVerdicts(draft.verdict);
  $("confidence").value=["low","medium","high"].includes(draft.confidence)?draft.confidence:"medium";
  $("familiarity").value=["unknown","visitor","local"].includes(draft.familiarity)?draft.familiarity:"unknown";
  $("notes").value=typeof draft.notes==="string"?draft.notes:"";
  for(const box of $("reasons").querySelectorAll("input"))box.checked=draft.reasons?.includes(box.value)??false;
}
function renderVerdicts(selected) {
  const compare=$("mode").value==="compare",pair=pairs.find(pair=>pair.id===$("pair").value);
  $("target-label").hidden=compare;$("pair-label").hidden=!compare;
  options($("verdict"),(compare?CHOICES:VERDICTS).map(value=>[value,value==="A"?`Prefer ${pair?.a??"first option"}`:value==="B"?`Prefer ${pair?.b??"second option"}`:readable(value)]),selected??"cannot-judge");
}
function render() {
  $("workspace").hidden=!model.bundle;if(!model.bundle)return;
  options($("case"),model.bundle.cases.map((_,index)=>[String(index),`Query ${index+1}`]),String(model.index));
  const current=row(),active=session();
  $("session-status").textContent=active?`Reviewing as ${active.reviewerId}. Blind order saved.`:"No reviewer selected.";
  if(active)$("reviewer").value=active.reviewerId;
  $("query-title").textContent=current?`Query ${model.index+1} of ${model.bundle.cases.length}`:"Bundle has no queries";
  $("query-summary").textContent=current?`Service date ${current.query.date??"unspecified"} · Departure ${clock(current.context?.departureSecs??current.query.departureSecs)} · ${current.candidates.length} captured options`:"";
  $("limits").textContent=`Stop-level schematic; no pedestrian geometry or applied real-time composition. ${current?.capture.truncated?"Capture is truncated; additional candidates may exist.":"Shows the complete captured candidate array, not proof of all possible journeys."}`;
  if([3,4].includes(model.bundle.version)) {
    $("limits").textContent="Complete returned frontend candidate array, including captured walking and applied timing. Access/egress geometry and original live application identity remain unverified. This is not proof of all possible journeys.";
    $("query-summary").textContent=`Service date ${current.context.serviceDate??"unspecified"} · Departure ${clock(current.context.departureSecs)} (captured timetable frame) · ${current.candidates.length} captured options`;
  }
  if(current?.query.entryStops&&current.query.exitStops) {
    $("query-summary").textContent+=` · From ${current.query.entryStops.map(stop=>stopLabel(stop.stopId)).join(", ")} → ${current.query.exitStops.map(stop=>stopLabel(stop.stopId)).join(", ")}`;
  }
  $("query-settings").textContent=JSON.stringify({query:current?.query??{},settings:model.bundle.provenance.settings},null,2);
  if(model.bundle.comparison) $("limits").textContent+=` Comparison: ${current?.comparisonStatus??"unknown"}; both source arrays and their original order are retained. Source identities are hidden until provenance is opened.`;
  $("provenance-data").textContent=JSON.stringify(model.bundle.comparison?{
    primarySource:"before",before:model.bundle.comparison.before.provenance,after:model.bundle.comparison.after.provenance,
    displayedCandidates:candidateOrder().map((candidate,index)=>({option:label(index),source:candidate.source})),
  }:model.bundle.provenance,null,2);
  const ordered=candidateOrder();drawCandidates(ordered);renderForm(ordered);
  $("history").replaceChildren();
  let count=0;
  for(const owner of model.actions.sessions)for(const action of effectiveReviewActions(owner)) {
    count++;
    const targets=action.candidateIds??(action.candidateId?[action.candidateId]:[]);
    const targetText=targets.map(id=>label(ordered.findIndex(candidate=>candidate.id===id))).join(" vs ");
    const verdict=action.choice==="A"?`prefer ${label(ordered.findIndex(candidate=>candidate.id===targets[0]))}`:action.choice==="B"?`prefer ${label(ordered.findIndex(candidate=>candidate.id===targets[1]))}`:readable(action.verdict??action.choice??action.kind);
    if(action.caseId===current?.id)$("history").append(element("li",`${owner.reviewerId}: ${targetText?targetText+" · ":""}${verdict}${action.confidence?` · ${action.confidence} confidence · ${action.familiarity}`:""}${action.reasons?.length?` · ${action.reasons.map(readable).join(", ")}`:""}${action.notes?` — ${action.notes}`:""}`));
  }
  $("progress").textContent=`${count} active explicit actions across ${model.actions.sessions.length} reviewer sessions`;
  updateDisabled();
}
function draft() {
  if(!row())return;
  model.drafts[row().id]={mode:$("mode").value,target:$("target").value,pair:$("pair").value,verdict:$("verdict").value,
    confidence:$("confidence").value,familiarity:$("familiarity").value,notes:$("notes").value,
    reasons:[...$("reasons").querySelectorAll("input:checked")].map(input=>input.value)};
  persist();
}
async function commit(input) {
  if(!session())throw new Error("Start a reviewer session first.");
  const next=await appendReviewAction(model.bundle,session(),input);
  model.actions.sessions=model.actions.sessions.map(item=>item.id===next.id?next:item);
  delete model.drafts[row()?.id];render();if(persist())tell("Review action saved locally.");
}
async function saveJudgment() {
  const input={kind:$("mode").value,caseId:row().id,confidence:$("confidence").value,familiarity:$("familiarity").value,
    notes:$("notes").value,reasons:[...$("reasons").querySelectorAll("input:checked")].map(input=>input.value)};
  if(input.kind==="compare") {input.candidateIds=pairs.find(pair=>pair.id===$("pair").value)?.candidateIds;input.choice=$("verdict").value;}
  else {input.candidateId=$("target").value;input.verdict=$("verdict").value;}
  await commit(input);
}
async function undo() {
  const last=session()&&effectiveReviewActions(session()).at(-1);if(!last)return;
  await commit({kind:"undo",targetActionId:last.id});
}
function move(index) {
  if(busy||!model.bundle)return;
  model.index=Math.max(0,Math.min(model.bundle.cases.length-1,index));render();persist();
}
async function readJson(file) {
  if(!file||file.size>10*1024*1024)throw new Error("Import requires a JSON file no larger than 10 MiB.");
  return JSON.parse(await file.text());
}
async function load(bundle) {
  await validateReviewBundle(bundle);
  if(bundle.cases.length>1000||bundle.cases.some(item=>item.candidates.length>200)||bundle.cases.reduce((sum,item)=>sum+item.candidates.length,0)>5000)
    throw new Error("This local viewer supports up to 1,000 queries, 200 options per query and 5,000 options total. Nothing was truncated.");
  let saved=null;try{saved=localStorage.getItem(key(bundle.bundleId));}catch{/* Memory-only operation remains available. */}
  let next={bundle,actions:await reviewActionsFile(bundle,[]),activeId:null,index:0,drafts:{}};
  if(saved) {
    const stored=JSON.parse(saved);await validateReviewBundle(stored.bundle);await validateReviewActions(stored.actions,bundle);
    if(stored.bundle.bundleId!==bundle.bundleId)throw new Error("Saved bundle identity mismatch.");
    next={...next,actions:stored.actions,activeId:stored.activeId,index:Math.max(0,Math.min(bundle.cases.length-1,Number.isSafeInteger(stored.index)?stored.index:0)),drafts:stored.drafts??{}};
  }
  model=next;diskValue=saved;$("provenance").open=false;render();
  if(persist())tell(saved?"Saved bundle, blind order, reviews and drafts restored locally.":"Bundle imported. Start a reviewer session to begin.");
}
function download(name,text,type="application/json") {
  const url=URL.createObjectURL(new Blob([text],{type})),link=document.createElement("a");link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function markdown() {
  const escape=value=>String(value).replace(/[\\`*_{}[\]()#+.!<>|~-]/g,"\\$&");
  const lines=["# Journey review opinions","",`Bundle: ${model.bundle.bundleId}`,"","Subjective opinions; not correctness verdicts. Undo history is retained in the JSON export.",""];
  for(const owner of model.actions.sessions)for(const action of effectiveReviewActions(owner)) {
    lines.push(`- ${escape(owner.reviewerId)} · ${escape(action.verdict??action.choice??action.kind)} · case ${action.caseId}`);
    const targets=action.candidateIds??(action.candidateId?[action.candidateId]:[]);
    if(targets.length)lines.push(`  Candidates (A/B order for pairs): ${targets.join(", ")}`);
    if(action.notes)lines.push(`  ${escape(action.notes).replaceAll("\n","\n  ")}`);
  }
  return lines.join("\n")+"\n";
}
for(const reason of REASONS) {
  const label=element("label",""),box=document.createElement("input");box.type="checkbox";box.value=reason;label.append(box,document.createTextNode(` ${readable(reason)}`));$("reasons").append(label);
}
$("bundle-file").onchange=event=>{const file=event.target.files[0];event.target.value="";perform(async()=>load(await readJson(file)));};
$("actions-file").onchange=event=>{const file=event.target.files[0];event.target.value="";perform(async()=>{
  model.actions=await mergeReviewActions(model.actions,await readJson(file),model.bundle);render();if(persist())tell("Review actions imported; separate opinions preserved.");
});};
$("start").onclick=()=>perform(async()=>{
  const reviewerId=$("reviewer").value.trim();if(!reviewerId)throw new Error("Enter a reviewer name or alias.");
  let active=model.actions.sessions.find(item=>item.reviewerId===reviewerId);
  if(!active){active=await createReviewSession(model.bundle,reviewerId);model.actions.sessions.push(active);}
  model.activeId=active.id;render();if(persist())tell("Reviewer ready; blind order saved locally.");
});
$("review-form").onsubmit=event=>{event.preventDefault();perform(saveJudgment);};
$("skip").onclick=()=>perform(()=>commit({kind:"skip",caseId:row().id}));
$("undo").onclick=()=>perform(undo);
$("previous").onclick=()=>move(model.index-1);$("next").onclick=()=>move(model.index+1);$("case").onchange=()=>move(Number($("case").value));
$("mode").onchange=()=>{renderVerdicts();draft();updateDisabled();};$("pair").onchange=()=>{renderVerdicts();draft();};
for(const id of ["target","verdict","confidence","familiarity","reasons","notes"])$(id).addEventListener("input",draft);
$("export").onclick=()=>perform(async()=>download("journey-review-actions.json",JSON.stringify(await reviewActionsFile(model.bundle,model.actions.sessions),null,2)+"\n"));
$("markdown").onclick=()=>download("journey-review-opinions.md",markdown(),"text/markdown");
document.addEventListener("keydown",event=>{
  if(event.altKey&&["ArrowLeft","ArrowRight"].includes(event.key)){event.preventDefault();move(model.index+(event.key==="ArrowLeft"?-1:1));}
  if((event.ctrlKey||event.metaKey)&&event.key==="Enter"&&!$("save").disabled){event.preventDefault();perform(saveJudgment);}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="z"&&!event.target.matches("input,textarea,[contenteditable=true]")){event.preventDefault();perform(undo);}
});
perform(async()=>{
  let id;try{id=localStorage.getItem(LAST);}catch{return;}
  if(id){const saved=localStorage.getItem(key(id));if(saved)await load(JSON.parse(saved).bundle);}
});
