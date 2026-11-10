import assert from "node:assert/strict";
type GitObject={type:string;sha:string};
function object(value:any):GitObject{
  assert.ok(value&&typeof value==="object"&&!Array.isArray(value),"Invalid GitHub object");
  assert.ok(value.type==="commit"||value.type==="tag","Reference does not target a commit/tag");
  assert.match(value.sha,/^[0-9a-f]{40}$/i,"Invalid GitHub object SHA");
  return value;
}
/** Verify a release tag without conflating a missing commit name(422) with a missing ref(404). */
export async function verifyReleaseTag(request:(path:string)=>Promise<Response>,tag:string,expectedSha:string):Promise<"absent"|"matching">{
  assert.match(tag,/^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[1-9][0-9]*$/);
  assert.match(expectedSha,/^[0-9a-f]{40}$/i);
  const response=await request("/git/ref/tags/"+encodeURIComponent(tag));
  if(response.status===404)return "absent";
  assert.equal(response.status,200,"Unexpected GitHub reference response");
  const reference=await response.json();
  assert.equal(reference.ref,"refs/tags/"+tag,"GitHub returned a different reference");
  let target=object(reference.object);
  for(let depth=0;target.type==="tag";depth++){
    assert.ok(depth<8,"Annotated tag chain exceeded limit");
    const nested=await request("/git/tags/"+target.sha);
    assert.equal(nested.status,200,"Unexpected GitHub annotated-tag response");
    const annotation=await nested.json();
    assert.equal(annotation.sha.toLowerCase(),target.sha.toLowerCase(),"Annotated tag identity changed");
    target=object(annotation.object);
  }
  assert.equal(target.sha.toLowerCase(),expectedSha.toLowerCase(),"Existing tag points to a different source commit");
  return "matching";
}
