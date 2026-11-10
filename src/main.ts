import { config } from "./config.js";
import { Application } from "./app.js";
import { serve } from "./http.js";
try {
  const settings=await config();
  const app=await Application.create(settings);
  let http:Awaited<ReturnType<typeof serve>>;
  try{http=await serve(app);}catch(error){await app.close();throw error;}
  console.log(JSON.stringify({event:"listening",host:settings.host,port:settings.port,version_state:app.health.state}));
  let stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;void http.close().then(()=>{process.exitCode=0;},()=>{process.exitCode=1;});};
  process.once("SIGTERM",stop);process.once("SIGINT",stop);
}catch{
  console.error(JSON.stringify({event:"startup_failed",message:"Check required configuration, the master-key file and exclusive database ownership"}));
  process.exitCode=1;
}
