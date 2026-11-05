import type { Context } from "@netlify/functions";

const BASE = "https://api.get-energy-performance-data.communities.gov.uk/api";
const ORIGINS = ["https://epc.propertykickstart.co.uk","http://localhost:8888","http://localhost:3000"];
const excluded = ["AB","DD","DG","EH","FK","G","HS","IV","KA","KW","KY","ML","PA","PH","TD","ZE","BT","GY","JE","IM"];
const reply = (body: unknown, status=200, origin?: string|null) => new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":origin&&ORIGINS.includes(origin)?origin:ORIGINS[0],"Cache-Control":"no-store","X-PK-EPC-Version":"ACT-711-2026-11-05","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"POST, OPTIONS"}});
const fail = (code:string,error:string) => ({ok:false,code,error});
const postcode = (s:string) => {const p=s.replace(/\s/g,"").toUpperCase();if(!/^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][ABD-HJLNP-UW-Z]{2}$/.test(p))throw Error("INVALID_POSTCODE");if(excluded.includes(p.match(/^[A-Z]+/)![0]))throw Error("OUTSIDE_ENGLAND_WALES");return p.slice(0,-3)+" "+p.slice(-3)};
const str = (v:unknown) => v==null?"":String(v);
const scalar = (v:any):any => v && typeof v==="object" && "value" in v ? scalar(v.value) : v;
const text = (v:unknown):string|null => {const x=scalar(v);return typeof x==="string"||typeof x==="number"?String(x):null};
const date = (v:unknown) => text(v);
const numeric = (v:unknown) => v===null||v===undefined||v===""?null:Number.isFinite(Number(v))?Number(v):null;
const field=(r:Record<string,unknown>,...names:string[])=>names.map(n=>r[n]).find(v=>v!==undefined&&v!==null&&v!=="");
const address = (r:Record<string,unknown>) => {const parts=[field(r,"address_line_1","addressLine1","address1","address-1"),field(r,"address_line_2","addressLine2","address2","address-2"),field(r,"address_line_3","addressLine3","address3","address-3"),field(r,"address_line_4","addressLine4"),field(r,"post_town","postTown","posttown","post-town")].filter(Boolean).map(String);return parts.join(", ")||str(field(r,"address","fullAddress","full-address"));};
const uprn=(r:Record<string,unknown>)=>str(field(r,"uprn","buildingReferenceNumber","building-reference-number"));
const BigIntSafeEqual=(a:string,b:string)=>a.replace(/^0+/,"")===b.replace(/^0+/,"");
const certificateKey=(r:Record<string,unknown>)=>str(field(r,"certificateNumber","certificate_number","lmkKey","lmk-key"));
const rowsOf = (payload:unknown):Record<string,unknown>[] => {if(!payload||typeof payload!=="object")throw Error("INVALID_UPSTREAM");const p=payload as Record<string,unknown>;const rows=p.data??p.rows;if(!Array.isArray(rows))throw Error("INVALID_UPSTREAM");if(rows.some(r=>!r||typeof r!=="object"||Array.isArray(r)))throw Error("INVALID_UPSTREAM");return rows as Record<string,unknown>[]};
const descriptions = (v:any):string|null => {
 const list=Array.isArray(v)?v:[v];
 const values=list.map(x=>typeof x==="string"?x:text(x?.description)||"").filter(Boolean);
 return values.length?[...new Set(values)].join("; "):null;
};
const safeDate=(v:unknown)=>{const s=str(v);return /^\d{4}-\d{2}-\d{2}/.test(s)&&!Number.isNaN(Date.parse(s))?s.slice(0,10):null};
function map(r:Record<string,unknown>, historical=false) {
 const certDate=safeDate(field(r,"registration_date","registrationDate","lodgementDate","lodgement-date","inspection_date","inspectionDate","inspection-date"));
 const expiryDate=safeDate(field(r,"validUntil","valid_until","valid-until"))||(certDate?new Date(new Date(certDate).setUTCFullYear(new Date(certDate).getUTCFullYear()+10)-86400000).toISOString().slice(0,10):null);
 const certNumber=certificateKey(r);const rating=str(field(r,"current_energy_efficiency_band","currentEnergyEfficiencyBand","current-energy-rating"));
 const score=numeric(field(r,"energy_rating_current","currentEnergyEfficiency","current-energy-efficiency"));
 if(!/^\d{4}(?:-\d{4}){4}$/.test(certNumber)||!certDate||!address(r)||!uprn(r)||!/^[A-G]$/.test(rating)||score===null||score<1||score>100)throw Error("INVALID_UPSTREAM");
 const recommendations=Array.isArray(r.suggested_improvements)?r.suggested_improvements.map((v:any)=>({
  improvement:text(v.improvement_details?.improvement_texts?.improvement_summary)||text(v.improvement_details?.improvement_texts?.improvement_description)||"See improvement details on the official certificate",
  indicativeCost:text(v.indicative_cost),typicalSaving:text(v.typical_saving)
 })):[];
 return {uprn:uprn(r),address:address(r),postcode:str(r.postcode),epcRating:rating,score,
 potentialRating:date(field(r,"potential_energy_efficiency_band","potentialEnergyEfficiencyBand","potential-energy-rating")),potentialScore:numeric(field(r,"energy_rating_potential","potentialEnergyEfficiency","potential-energy-efficiency")),
 certDate,expiryDate,certNumber,propertyType:date(field(r,"dwelling_type","propertyType","property-type")),builtForm:typeof r.built_form==="string"?r.built_form:date(field(r,"builtForm","built-form")),totalFloorArea:numeric(field(r,"total_floor_area","totalFloorArea","total-floor-area")),
 floorLevel:date(field(r,"floorLevel","floor-level")),heatingType:descriptions(r.main_heating)||date(field(r,"mainHeatDescription","main-heat-description")),hotWaterDescription:descriptions(r.hot_water)||date(field(r,"hotWaterDescription","hot-water-description")),wallsDescription:descriptions(r.walls)||date(field(r,"wallsDescription","walls-description")),roofDescription:descriptions(r.roofs)||date(field(r,"roofDescription","roof-description")),windowsDescription:descriptions(r.window)||date(field(r,"windowsDescription","windows-description")),
 recommendations,isExpired:!!expiryDate&&expiryDate<new Date().toISOString().slice(0,10),isHistorical:historical,lookupTimestamp:new Date().toISOString(),source:"MHCLG EPC API",epcEvidenceStatus:"Verified",officialCertUrl:"https://find-energy-certificate.service.gov.uk/energy-certificate/"+encodeURIComponent(certNumber)};
}
async function upstream(path:string,token:string) {
 for(let attempt=0;attempt<3;attempt++){
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);
  try{
   const auth=token.startsWith("Bearer ")?token:"Bearer "+token;
   const res=await fetch(BASE+path,{headers:{Authorization:auth,Accept:"application/json"},signal:controller.signal});
   if(res.status===429&&attempt<2){await new Promise(r=>setTimeout(r,1000*(2**attempt)));continue}
   if(res.status===401||res.status===403)throw Error("AUTH_ERROR");
   if(res.status===404)return null;
   if(!res.ok)throw Error(res.status===429?"RATE_LIMIT":"UPSTREAM_ERROR");
   try{return await res.json()}catch{throw Error("INVALID_UPSTREAM")}
  }finally{clearTimeout(timeout)}
 }
 throw Error("RATE_LIMIT");
}
async function search(query:string,token:string){
 let rows:Record<string,unknown>[]=[];
 for(let page=1;page<=20;page++){
  const payload=await upstream("/domestic/search?"+query+"&page_size=5000&current_page="+page,token);
  if(payload===null){if(page===1)return [];throw Error("INVALID_UPSTREAM")}
  rows.push(...rowsOf(payload));
  const pagination=payload.pagination;
  if(!pagination||pagination.nextPage==null&&(!pagination.totalPages||page>=pagination.totalPages))return rows;
 }
 throw Error("INVALID_UPSTREAM");
}
export default async function handler(req:Request,_ctx:Context){
 const origin=req.headers.get("origin");if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":origin&&ORIGINS.includes(origin)?origin:ORIGINS[0],"Cache-Control":"no-store","X-PK-EPC-Version":"ACT-711-2026-11-05","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"POST, OPTIONS"}});
 if(req.method!=="POST")return reply(fail("METHOD_NOT_ALLOWED","Method not allowed."),405,origin);
 let body:any;try{body=await req.json();if(!body||typeof body!=="object")throw Error()}catch{return reply(fail("BAD_REQUEST","Invalid request."),400,origin)}
 const token=Netlify.env.get("EPC_API_TOKEN")?.trim();if(!token||token.toLowerCase()==="mock")return reply(fail("AUTH_ERROR","EPC service is temporarily unavailable."),503,origin);
 try{
  if(body.op==="search"){
   if(typeof body.postcode!=="string")return reply(fail("MISSING_POSTCODE","postcode is required."),400,origin);
   const p=postcode(body.postcode);const rows=await search("postcode="+encodeURIComponent(p),token);
   const seen=new Set<string>();const data=rows.map(r=>({uprn:uprn(r),address:address(r),postcode:str(r.postcode)||p})).filter(r=>{const key=r.uprn||r.address.toUpperCase();if(!r.address||seen.has(key))return false;seen.add(key);return true});
   if(rows.length>0&&data.length===0)return reply(fail("INVALID_UPSTREAM","The EPC service returned records without usable addresses."),502,origin);return reply({ok:true,data},200,origin);
  }
  if(body.op==="certificate"){
   if(!body.uprn&&!(body.address&&body.postcode))return reply(fail("MISSING_PARAMS","Provide a UPRN or address and postcode."),400,origin);
   const p=body.postcode?postcode(str(body.postcode)):null;
   // Search by postcode or UPRN, then match the exact selected property. UPRNs are not certificate LMK keys.
   const qs=p?"postcode="+encodeURIComponent(p):"uprn="+encodeURIComponent(str(body.uprn).padStart(12,"0"));
   const rows=await search(qs,token);
   const matched=rows.filter(r=>{const requestedUprn=str(body.uprn).trim();const actualUprn=uprn(r);if(requestedUprn&&actualUprn)return BigIntSafeEqual(requestedUprn,actualUprn);return address(r).trim().toUpperCase()===str(body.address).trim().toUpperCase();});
   if(!matched.length)return reply({ok:true,data:{epcEvidenceStatus:"Not found",failureReason:"No EPC certificate found for this property.",uprn:str(body.uprn),address:str(body.address),postcode:p||"",lookupTimestamp:new Date().toISOString(),source:"MHCLG EPC API",epcRating:"Unknown",score:null,recommendations:[],officialCertUrl:null}},200,origin);
   matched.sort((a,b)=>str(field(b,"registration_date","registrationDate","lodgementDate","lodgement-date")).localeCompare(str(field(a,"registration_date","registrationDate","lodgementDate","lodgement-date"))));
   const mapped=[];
   const seenCertificates=new Set<string>();
   for(const summary of matched){
    const key=certificateKey(summary);if(!/^\d{4}(?:-\d{4}){4}$/.test(key))throw Error("INVALID_UPSTREAM");
    if(seenCertificates.has(key))continue;seenCertificates.add(key);
    const payload=await upstream("/certificate?certificate_number="+encodeURIComponent(key),token);
    const detail=payload?.data;
    if(!detail||typeof detail!=="object"||Array.isArray(detail))throw Error("INVALID_UPSTREAM");
    if(uprn(detail)&&!BigIntSafeEqual(uprn(detail),uprn(summary)))throw Error("IDENTITY_MISMATCH");
    if(detail.postcode&&postcode(str(detail.postcode))!==postcode(str(summary.postcode)))throw Error("IDENTITY_MISMATCH");
    if(certificateKey(detail)&&certificateKey(detail)!==key)throw Error("IDENTITY_MISMATCH");
    mapped.push(map({...detail,certificate_number:key},mapped.length>0));
   }
   mapped.sort((a,b)=>b.certDate.localeCompare(a.certDate));mapped.forEach((r,i)=>r.isHistorical=i>0);return reply({ok:true,data:mapped.length===1?mapped[0]:mapped},200,origin);
  }
  return reply(fail("UNKNOWN_OP","Unknown operation."),400,origin);
 }catch(e){const code=e instanceof Error?e.message:"UPSTREAM_ERROR";const known=["INVALID_POSTCODE","OUTSIDE_ENGLAND_WALES","AUTH_ERROR","RATE_LIMIT","INVALID_UPSTREAM","IDENTITY_MISMATCH"].includes(code)?code:"UPSTREAM_ERROR";return reply(fail(known,known==="INVALID_POSTCODE"?"Please enter a valid postcode.":known==="OUTSIDE_ENGLAND_WALES"?"This tool covers England and Wales only.":"The EPC lookup service is temporarily unavailable."),known==="AUTH_ERROR"?503:known==="INVALID_POSTCODE"||known==="OUTSIDE_ENGLAND_WALES"?400:502,origin)}
}
export const config={path:"/api/epc-lookup"};

