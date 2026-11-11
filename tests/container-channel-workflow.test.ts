import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("publisher validates stable/beta releases, retains full checks and preserves fixed versions",async()=>{
 const p=JSON.parse(await readFile(new URL("../.github/workflows/publish-ghcr.yml",import.meta.url),"utf8"));
 assert.equal(p.name,"Publish container to GHCR");assert.deepEqual(p.on.release.types,["published"]);assert.ok(p.on.workflow_dispatch);
 assert.match(p.jobs.publish.concurrency.group,/needs\.metadata\.outputs\.version/);assert.equal(p.jobs.publish.concurrency["cancel-in-progress"],false);
 const steps=p.jobs.publish.steps;
 assert.ok(steps.some((s:any)=>s.run==="pnpm check"));assert.ok(steps.some((s:any)=>s.run?.includes("container-smoke.mjs")));
 const a=steps.findIndex((s:any)=>s.run==="node scripts/container-channels.ts prepare"),b=steps.findIndex((s:any)=>s.name==="Build Linux amd64 image"),c=steps.findIndex((s:any)=>s.name==="Publish the fixed version");
 assert.ok(a<b&&b<c);assert.equal(steps[c].if,"steps.existing.outputs.reuse != 'true'");assert.equal(steps[b].if,steps[c].if);
 assert.equal(p.jobs.publish.permissions.packages,"write");
 assert.ok((await readFile(new URL("../scripts/container-smoke.mjs",import.meta.url),"utf8")).includes("assert.ok(containerVersion(version)"));
});
test("refresh uses trusted default-context checkout, successful publisher events and dry runs",async()=>{
 const c=JSON.parse(await readFile(new URL("../.github/workflows/container-channels.yml",import.meta.url),"utf8"));
 assert.deepEqual(c.on.workflow_run.workflows,["Publish container to GHCR"]);assert.deepEqual(c.on.workflow_run.types,["completed"]);
 assert.equal(c.on.workflow_dispatch.inputs.dry_run.type,"boolean");assert.equal(c.concurrency["cancel-in-progress"],false);
 assert.ok(c.jobs.channels.if.includes("conclusion == 'success'"));assert.ok(c.jobs.channels.if.includes("head_repository.full_name == github.repository"));
 const checkout=c.jobs.channels.steps[0];assert.equal(checkout.with.ref,"$"+"{{ github.sha }}");assert.equal(checkout.with["persist-credentials"],false);
 assert.equal(c.jobs.channels.permissions.actions,"read");assert.equal(c.jobs.channels.permissions.packages,"write");
 assert.ok(c.jobs.channels.steps.some((s:any)=>s.run==="node scripts/container-channels.ts refresh"));assert.ok(!JSON.stringify(c).includes("workflow_run.head_sha"));
});
