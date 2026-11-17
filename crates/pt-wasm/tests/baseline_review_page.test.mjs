import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Script} from "node:vm";
import {buildReviewerPage} from "../../../tools/search-review/build.mjs";

test("distributed offline page matches its sources and embeds valid standalone code",()=>{
 const html=readFileSync(new URL("../../../tools/search-review/index.html",import.meta.url),"utf8");
 assert.equal(html,buildReviewerPage());
 const code=html.match(/<script type="module">([\s\S]*)<\/script>/)[1];
 assert.doesNotThrow(()=>new Script(code));
 assert.equal(/<script[^>]+src=/.test(html),false);
});
