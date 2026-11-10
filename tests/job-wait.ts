import { setTimeout as delay } from "node:timers/promises";

/** Observe one accepted job; never resubmit it or hide an unexpected terminal state. */
export async function waitForTestJob<T extends {state:string}>(read:()=>T|Promise<T>):Promise<T>{
  const timeoutMs=30000,deadline=performance.now()+timeoutMs;
  for(;;){
    const value=await read();
    if(!["queued","running","cancel_requested"].includes(value.state))return value;
    const remaining=deadline-performance.now();
    if(remaining<=0)throw Error("Job remained "+value.state+" after "+timeoutMs+"ms");
    await delay(Math.min(25,remaining));
  }
}
