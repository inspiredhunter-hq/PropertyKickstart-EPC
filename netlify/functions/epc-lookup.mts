import type { Context } from "@netlify/functions";

const BASE = "https://api.get-energy-performance-data.communities.gov.uk/api";
const ORIGINS = ["https://epc.propertykickstart.co.uk","http://localhost:8888","http://localhost:3000"];
const excluded = ["AB","DD","DG","EH","FK","G","HS","IV","KA","KW","KY","ML","PA","PH","TD","ZE","BT","GY","JE","IM"];
const reply = (body: unknown, status=200, origin?: string|null) => new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":origin&&ORIGINS.includes(origin)?origin:ORIGINS[0],"Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"POST, OPTIONS"}});
const fail = (code:string,error:string) => ({ok:false,code,error});
const postcode = (s:string) => {const p=s.replace(/\s/g,"").toUpperCase();if(!/^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][ABD-HJLNP-UW-Z]{2}$/.test(p))throw Error("INVALID_POSTCODE");if(excluded.some(x=>p.startsWith(x)))throw Error("OUTSIDE_ENGLAND_WALES");return p.slice(0,-3)+" "+p.slice(-3)};
const str = (v:unknown) => v==null?"":String(v);
const date = (v:unknown) => str(v)||null;
const numeric = (v:unknown) => v===null||v===undefined||v===""?null:Number.isFinite(Number(v))?Number(v):null;
const address = (r:Record<string,unknown>) => [r.address1,r.address2,r.address3,r.posttown].filter(Boolean).join(", ");
const rowsOf = (payload:unknown):Record<string,unknown>[] => {if(!payload||typeof payload!=="object")throw Error("INVALID_UPSTREAM");const p=payload as Record<string,unknown>;const rows=p.data??p.rows;if(!Array.isArray(rows))throw Error("INVALID_UPSTREAM");if(rows.some(r=>!r||typeof r!=="object"||Array.isArray(r)))throw Error("INVALID_UPSTREAM");return rows as Record<string,unknown>[]};
function map(r:Record<string,unknown>, historical=false) {
 const certDate=date(r["lodgement-date"]??r["inspection-date"]);const expiryDate=date(r["valid-until"])||(certDate?new Date(new Date(certDate).setFullYear(new Date(certDate).getFullYear()+10)).toISOString().slice(0,10):null);
 const certNumber=date(r["lmk-key"]);return {uprn:str(r.uprn??r["building-reference-number"]),address:address(r),postcode:str(r.postcode),epcRating:str(r["current-energy-rating"])||"Unknown",score:numeric(r["current-energy-efficiency"]),potentialRating:date(r["potential-energy-rating"]),potentialScore:numeric(r["potential-energy-efficiency"]),certDate,expiryDate,certNumber,propertyType:date(r["property-type"]),builtForm:date(r["built-form"]),totalFloorArea:numeric(r["total-floor-area"]),floorLevel:date(r["floor-level"]),heatingType:date(r["main-heat-description"]),hotWaterDescription:date(r["hot-water-description"]),wallsDescription:date(r["walls-description"]),roofDescription:date(r["roof-description"]),windowsDescription:date(r["windows-description"]),recommendations:[],isExpired:!!expiryDate&&new Date(expiryDate)<new Date(),isHistorical:historical,lookupTimestamp:new Date().toISOString(),source:"MHCLG EPC API",epcEvidenceStatus:"Verified",officialCertUrl:certNumber?"https://find-energy-certificate.service.gov.uk/energy-certificate/"+encodeURIComponent(certNumber):null};
}
async function upstream(path:string,token:string) {
 for(let attempt=0;attempt<3;attempt++){
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);
  try{
   const auth=token.startsWith("Basic ")||token.startsWith("Bearer ")?token:token.includes(":")?"Basic "+btoa(token):"Bearer "+token;
   const res=await fetch(BASE+path,{headers:{Authorization:auth,Accept:"application/json"},signal:controller.signal});
   if(res.status===429&&attempt<2){await new Promise(r=>setTimeout(r,1000*(2**attempt)));continue}
   if(res.status===401||res.status===403)throw Error("AUTH_ERROR");
   if(res.status===404)return [];
   if(!res.ok)throw Error(res.status===429?"RATE_LIMIT":"UPSTREAM_ERROR");
   return rowsOf(await res.json());
  }finally{clearTimeout(timeout)}
 }
 throw Error("RATE_LIMIT");
}
export default async function handler(req:Request,_ctx:Context){
 const origin=req.headers.get("origin");if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":origin&&ORIGINS.includes(origin)?origin:ORIGINS[0],"Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"POST, OPTIONS"}});
 if(req.method!=="POST")return reply(fail("METHOD_NOT_ALLOWED","Method not allowed."),405,origin);
 let body:any;try{body=await req.json();if(!body||typeof body!=="object")throw Error()}catch{return reply(fail("BAD_REQUEST","Invalid request."),400,origin)}
 const token=Netlify.env.get("EPC_API_TOKEN");if(!token||token.toLowerCase()==="mock")return reply(fail("AUTH_ERROR","EPC service is temporarily unavailable."),503,origin);
 try{
  if(body.op==="search"){
   if(typeof body.postcode!=="string")return reply(fail("MISSING_POSTCODE","postcode is required."),400,origin);
   const p=postcode(body.postcode);const rows=await upstream("/domestic/search?postcode="+encodeURIComponent(p)+"&size=100",token);
   const seen=new Set<string>();const data=rows.map(r=>({uprn:str(r.uprn??r["building-reference-number"]),address:address(r),postcode:str(r.postcode)||p})).filter(r=>{const key=r.uprn||r.address.toUpperCase();if(!r.address||seen.has(key))return false;seen.add(key);return true});
   return reply({ok:true,data},200,origin);
  }
  if(body.op==="certificate"){
   if(!body.uprn&&!(body.address&&body.postcode))return reply(fail("MISSING_PARAMS","Provide a UPRN or address and postcode."),400,origin);
   const p=body.postcode?postcode(str(body.postcode)):null;
   // Search by postcode or UPRN, then match the exact selected property. UPRNs are not certificate LMK keys.
   const qs=body.uprn?"uprn="+encodeURIComponent(str(body.uprn)):"postcode="+encodeURIComponent(p!);
   const rows=await upstream("/domestic/search?"+qs+"&size=100",token);
   const matched=rows.filter(r=>body.uprn?str(r.uprn??r["building-reference-number"])===str(body.uprn):address(r).toUpperCase()===str(body.address).trim().toUpperCase());
   if(!matched.length)return reply({ok:true,data:[],code:"NOT_FOUND"},200,origin);
   matched.sort((a,b)=>str(b["lodgement-date"]).localeCompare(str(a["lodgement-date"])));
   const mapped=matched.map((r,i)=>map(r,i>0));return reply({ok:true,data:mapped.length===1?mapped[0]:mapped},200,origin);
  }
  return reply(fail("UNKNOWN_OP","Unknown operation."),400,origin);
 }catch(e){const code=e instanceof Error?e.message:"UPSTREAM_ERROR";const known=["INVALID_POSTCODE","OUTSIDE_ENGLAND_WALES","AUTH_ERROR","RATE_LIMIT","INVALID_UPSTREAM"].includes(code)?code:"UPSTREAM_ERROR";return reply(fail(known,known==="INVALID_POSTCODE"?"Please enter a valid postcode.":known==="OUTSIDE_ENGLAND_WALES"?"This tool covers England and Wales only.":"The EPC lookup service is temporarily unavailable."),known==="AUTH_ERROR"?503:known==="INVALID_POSTCODE"||known==="OUTSIDE_ENGLAND_WALES"?400:502,origin)}
}
export const config={path:"/api/epc-lookup"};
