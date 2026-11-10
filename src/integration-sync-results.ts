import { isDeepStrictEqual } from "node:util";
import { IntegrationRun,integrationFailure } from "./integration-run.js";
import type { FixtureRole } from "./integration-bootstrap.js";
import { ResultPages } from "./result-pages.js";
import { readDecoded } from "./content-encoding.js";

export function ackMap(rows:{type:string;ack:string}[]){
  const value:Record<string,string>={};
  for(const row of rows){
    if(typeof row?.type!=="string"||typeof row.ack!=="string"||row.ack.split("|",1)[0]!==row.type||Object.hasOwn(value,row.type))
      integrationFailure("fixture_sync","Invalid or duplicate synchronization checkpoint");
    value[row.type]=row.ack;
  }
  return value;
}
export function lastAcks(rows:{type:string;ack:string}[]){
  const value:Record<string,string>={};
  for(const row of rows){
    const type=row.ack.split("|",1)[0]!;
    if(!type||!row.ack.includes("|"))integrationFailure("fixture_sync","Missing synchronization acknowledgement");
    value[type]=row.ack;
  }
  return value;
}
export async function completeSyncRows(run:IntegrationRun,actor:FixtureRole,result:any){
  const p=run.context.actors[actor].principal,record=run.context.vault.get(p,result.result_ref,"result");
  run.contexts.assertResult(p,record);
  const projection=record.projection;
  if(record.raw.interrupted||record.decoded_complete!==true||projection?.kind!=="jsonl"||!projection.complete||projection.error||
    !Number.isSafeInteger(projection.total_records)||projection.total_records<1||projection.total_records>2048)
    integrationFailure("fixture_sync","Expected a complete bounded synchronization projection");
  const pages=new ResultPages(run.context.vault,p,undefined,projection.stream_id),rows:any[]=[];
  for(let offset=0;offset<projection.total_records;offset+=64){
    const page=pages.read(offset,64);
    if(page.length!==Math.min(64,projection.total_records-offset))integrationFailure("fixture_sync","A sanitized synchronization page is missing");
    rows.push(...page);
  }
  const raw=await readDecoded(run.context.vault.rawStream(p,record.raw.raw_ref),record.raw.content_encoding??"identity",8*1024*1024);
  const originals=raw.toString("utf8").split("\n").filter(line=>line.trim()).map(line=>JSON.parse(line));
  if(originals.length!==rows.length)integrationFailure("fixture_sync","Original and sanitized synchronization counts differ");
  for(let i=0;i<rows.length;i++){
    const expected=structuredClone(originals[i]),shown=rows[i];
    if(expected.type==="AuthUserV2"&&expected.data.pinCode!==null){
      const ref=shown?.data?.pinCode?.secret_ref;
      if(typeof ref!=="string")integrationFailure("fixture_sync_secret","Synchronization PIN was not protected");
      const secret=run.context.vault.get(p,ref,"secret");
      if(secret.value!==expected.data.pinCode||secret.revision!==record.revision||secret.context_ref!==record.context_ref||secret.context_generation!==record.context_generation)
        integrationFailure("fixture_sync_secret","Synchronization secret provenance differs");
      expected.data.pinCode={secret_ref:ref};
    }
    if(!isDeepStrictEqual(shown,expected))integrationFailure("fixture_sync","Sanitized synchronization order or formal data differs");
  }
  if(rows.at(-1)?.type!==projection.terminal||!["SyncCompleteV1","SyncResetV1"].includes(projection.terminal))
    integrationFailure("fixture_sync","The synchronization terminal is missing or inconsistent");
  return rows;
}
