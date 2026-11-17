import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync,mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {pathToFileURL,fileURLToPath} from "node:url";
import {chromium} from "../../packages/frontend/node_modules/@playwright/test/index.mjs";
import {retainArtifact,retainRun} from "../../crates/pt-wasm/tests/baseline_store.mjs";
import {exportReviewBundle} from "../../crates/pt-wasm/tests/baseline_review.mjs";
import {validateReviewActions,effectiveReviewActions} from "./state.mjs";
import {createReviewComparison} from "./contract.mjs";
import {buildReviewerPage} from "./build.mjs";

const here=dirname(fileURLToPath(import.meta.url)),url=pathToFileURL(join(here,"index.html")).href;
const unsafe='<img src="https://invalid.example/image" onerror="globalThis.injected=true">';
let browser,bundle;
before(async()=>{
 assert.equal(readFileSync(join(here,"index.html"),"utf8"),buildReviewerPage());
 const root=mkdtempSync(join(tmpdir(),"review-browser-"));
 try {
  const artifacts=Object.fromEntries(["ptb","queryTuples","glue","wasm"].map(name=>[name,retainArtifact(root,Buffer.from(name))]));
  artifacts.reviewStopContext=retainArtifact(root,Buffer.from(JSON.stringify({format:"ptn-search-review-stop-context",version:1,
   derivation:"pt-core-reader-e7-name-v1",ptbSha256:artifacts.ptb,
   stops:[{stopId:"A",name:unsafe,latE7:540000000,lonE7:250000000}]})));
  const candidates=[0,1,2].map(index=>({legs:[{type:"transit",routeShortName:index===0?unsafe:String(index),tripId:"hidden-engine-trip",
   fromStopId:"A",toStopId:"B",approximate:index===0,departSecs:3660,arriveSecs:3900+index*60,boardStopIdx:0,alightStopIdx:1}],boardSecs:3660,alightSecs:3900+index*60,transfers:0}));
  const capture={boundary:"stop-level engine",equivalence:"exact",truncated:false};
  retainRun(root,"fixture",{schemaVersion:1,completion:"success",scope:"stop-level compiled engine",classification:"partial capture",replayVerification:"unverified",
   missingDependencies:["fixture"],unsupported:["pedestrian geometry","real-time composition"],artifacts,
   report:{runtime:{node:"fixture",v8:"fixture",platform:"fixture",arch:"fixture",release:"fixture"},patternMode:"covering-merge",objective:"plan",input:{windowStart:null,windowEnd:null},
    tuples:[{query:{date:"20261113",departureSecs:3600,entryStops:[{stopId:"A",walkSecs:10}],exitStops:[{stopId:"B",walkSecs:20}]},candidates,capture},
     {query:{date:"20261113",departureSecs:90000},candidates:[],capture:{...capture,truncated:true}}]}});
  bundle=await exportReviewBundle(root,"fixture",join(root,"review.json"));
 } finally {rmSync(root,{recursive:true,force:true});}
 browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();});

test("derived old/new bundle stays blind through offline reload and neutral export",async()=>{
 const comparison=await createReviewComparison(bundle,bundle);
 const context=await browser.newContext({offline:true});
 try {
  const page=await context.newPage();await page.goto(url);
  await page.locator("#bundle-file").setInputFiles(inputFile("comparison.json",comparison));
  await page.locator("#workspace").waitFor({state:"visible"});await start(page,"Comparison reviewer");
  assert.equal(await page.locator(".candidate").count(),6);
  const order=await page.locator(".candidate").evaluateAll(nodes=>nodes.map(node=>node.dataset.candidateId));
  assert.match(await page.locator("#limits").textContent(),/Comparison: unchanged/);
  assert.equal(await page.locator("#provenance-data").isVisible(),false);
  await page.reload();await page.locator(".candidate").first().waitFor();
  assert.deepEqual(await page.locator(".candidate").evaluateAll(nodes=>nodes.map(node=>node.dataset.candidateId)),order);
  await page.locator("#mode").selectOption("compare");await page.locator("#verdict").selectOption("equivalent");
  await page.locator("#save").click();await saved(page);
  const actions=await exported(page);await validateReviewActions(actions,comparison);
  assert.equal(actions.sessions[0].actions[0].choice,"equivalent");
  await page.getByText("Reveal provenance",{exact:true}).click();
  const provenance=JSON.parse(await page.locator("#provenance-data").textContent());
  assert.deepEqual(new Set(provenance.displayedCandidates.map(c=>c.source.side)),new Set(["before","after"]));
 } finally {await context.close();}
});
const inputFile=(name,value)=>({name,mimeType:"application/json",buffer:Buffer.from(JSON.stringify(value))});
async function importBundle(page) {
 await page.goto(url);
 await page.locator("#bundle-file").setInputFiles(inputFile("bundle.json",bundle));
 await page.locator("#workspace").waitFor({state:"visible"});
}
async function start(page,name="Reviewer one") {
 await page.locator("#reviewer").fill(name);await page.locator("#start").click();
 await page.waitForFunction(()=>document.querySelector("#session-status").textContent.includes("Blind order saved"));
}
async function exported(page) {
 const download=page.waitForEvent("download");await page.locator("#export").click();
 return JSON.parse(readFileSync(await (await download).path(),"utf8"));
}
async function saved(page) {await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("Review action saved"));}

test("local page preserves blind order, drafts and explicit actions through offline reload, undo and reimport",async()=>{
 const context=await browser.newContext();
 try {
  const requests=[],errors=[];context.on("request",request=>{if(/^https?:/.test(request.url()))requests.push(request.url());});
  const page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));
  await importBundle(page);assert.equal(await page.locator(".candidate").count(),0);
  await start(page);assert.equal(await page.locator(".candidate").count(),3);
  assert.equal(await page.locator("#pair-label").isVisible(),false);
  assert.equal(await page.locator("#verdict").inputValue(),"cannot-judge");
  assert.equal(await page.locator("#provenance").getAttribute("open"),null);
  assert.equal((await page.locator("body").innerText()).includes("hidden-engine-trip"),false);
  assert.equal(await page.locator("img").count(),0);
  assert.equal(await page.getByText("Headway estimate: departure and arrival are approximate.",{exact:true}).count(),1);
  assert.equal(await page.getByText("~01:01:00–~01:05:00 · 4 min",{exact:true}).count(),1);
  const estimated=page.locator(".candidate").filter({hasText:"Includes approximate headway service"});
  assert.match(await estimated.textContent(),/Arrival ~01:05:20 · Full duration ~5 min 20 s/);
  assert.match(await estimated.textContent(),/Waiting ~50 s/);
  assert.equal(await page.getByText("01:01:00–01:06:00 · 5 min",{exact:true}).count(),1);
  const order=await page.locator(".candidate").evaluateAll(nodes=>nodes.map(node=>node.dataset.candidateId));
  await page.locator("#notes").fill(unsafe);
  assert.equal((await exported(page)).sessions[0].actions.length,0,"draft is not an exported opinion");
  await context.setOffline(true);await page.reload();await page.locator(".candidate").first().waitFor();
  assert.deepEqual(await page.locator(".candidate").evaluateAll(nodes=>nodes.map(node=>node.dataset.candidateId)),order);
  assert.equal(await page.locator("#notes").inputValue(),unsafe);
  await page.locator("#notes").press("Control+Enter");await saved(page);
  assert.ok((await page.locator("#query-summary").textContent()).includes(`${unsafe} (A) → B`));
  assert.ok((await page.locator(".timeline").first().textContent()).includes(`${unsafe} (A) → B`));
  assert.equal(await page.locator("#workspace img").count(),0);
  const committed=await exported(page);await validateReviewActions(committed,bundle);
  assert.equal(committed.sessions[0].actions[0].notes,unsafe);
  const markdownDownload=page.waitForEvent("download");await page.locator("#markdown").click();
  const markdown=readFileSync(await (await markdownDownload).path(),"utf8");
  assert.equal(/(?<!\\)<img/.test(markdown),false);assert.ok(markdown.includes("\\<img"));assert.ok(markdown.includes("Candidates (A/B order for pairs)"));
  assert.equal(await page.locator("#history img").count(),0);
  await page.locator("h1").click();await page.keyboard.press("Control+z");await saved(page);
  const undone=await exported(page);assert.equal(undone.sessions[0].actions.length,2);
  assert.equal(effectiveReviewActions(undone.sessions[0]).length,0);
  await page.reload();await page.locator(".candidate").first().waitFor();assert.equal(await page.locator("#history li").count(),0);
  await page.locator("#next").click();assert.match(await page.locator("#query-summary").textContent(),/25:00:00/);
  assert.equal(await page.locator("#save").isDisabled(),true);await page.locator("#skip").click();await saved(page);
  assert.equal((await exported(page)).sessions[0].actions.at(-1).kind,"skip");
  assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);
  const fresh=await browser.newContext();
  try {
   const other=await fresh.newPage();await importBundle(other);
   await other.locator("#actions-file").setInputFiles(inputFile("actions.json",committed));
   await other.waitForFunction(()=>document.querySelector("#history li"));
   assert.equal(await other.locator("#history li").count(),1);
   assert.equal((await other.locator("#history").textContent()).includes("Option 0"),false);
   await start(other);assert.equal(await other.locator("#history li").count(),1);
  } finally {await fresh.close();}
 } finally {await context.close();}
});

test("pair judgments retain neutral choice and independent opinions; stale imports do not replace reviews",async()=>{
 const context=await browser.newContext();
 try {
  const page=await context.newPage();await importBundle(page);await start(page);
  await page.locator("#mode").selectOption("compare");assert.equal(await page.locator("#pair-label").isVisible(),true);
  await page.locator("#verdict").selectOption("equivalent");await page.locator("#save").click();await saved(page);
  const first=await exported(page);assert.equal(first.sessions[0].actions[0].choice,"equivalent");
  await start(page,"Reviewer two");await page.locator("#verdict").selectOption("would-avoid");await page.locator("#save").click();await saved(page);
  const both=await exported(page);assert.equal(both.sessions.length,2);assert.equal(await page.locator("#history li").count(),2);
  await page.locator("#actions-file").setInputFiles(inputFile("same.json",both));
  await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("actions imported"));
  assert.equal(await page.locator("#history li").count(),2);
  const stale=structuredClone(both);stale.bundleId="c".repeat(64);
  await page.locator("#actions-file").setInputFiles(inputFile("stale.json",stale));
  await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("stale bundle"));
  assert.deepEqual(await exported(page),both);
  const changed=structuredClone(bundle);changed.cases[0].candidates[0].itinerary.alightSecs++;
  await page.locator("#bundle-file").setInputFiles(inputFile("changed.json",changed));
  await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("identity mismatch"));
  assert.deepEqual(await exported(page),both);
  if(process.env.REVIEW_SCREENSHOTS) {
   mkdirSync(process.env.REVIEW_SCREENSHOTS,{recursive:true});
   await page.screenshot({path:join(process.env.REVIEW_SCREENSHOTS,"desktop.png"),fullPage:true});
   await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(process.env.REVIEW_SCREENSHOTS,"mobile.png"),fullPage:true});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  }
 } finally {await context.close();}
});

test("storage failure leaves opinions exportable and never claims they were saved",async()=>{
 const context=await browser.newContext();
 try {
  const page=await context.newPage();await page.addInitScript(()=>{Storage.prototype.setItem=()=>{throw new DOMException("Test quota","QuotaExceededError");};});
  await importBundle(page);await start(page);
  await page.locator("#notes").fill("recover me");await page.locator("#save").click();
  await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("memory only"));
  assert.equal((await exported(page)).sessions[0].actions[0].notes,"recover me");
 } finally {await context.close();}
});

test("another tab cannot silently overwrite newer local progress",async()=>{
 const context=await browser.newContext();
 try {
  const one=await context.newPage();await importBundle(one);
  const two=await context.newPage();await two.goto(url);await two.locator("#workspace").waitFor({state:"visible"});
  await start(one,"First tab");await start(two,"Second tab");
  await two.locator("#save").click();await two.waitForFunction(()=>document.querySelector("#status").textContent.includes("another tab"));
  assert.equal((await exported(two)).sessions[0].reviewerId,"Second tab");
  await one.reload();await one.locator(".candidate").first().waitFor();
  assert.equal((await exported(one)).sessions[0].reviewerId,"First tab");
 } finally {await context.close();}
});
