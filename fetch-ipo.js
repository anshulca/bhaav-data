/* ============================================================
   भाव (Bhaav) — automatic data fetcher
   Runs on GitHub Actions (free) every 30 minutes. Calls InvestorGain's
   own JSON data endpoint (the same one their website frontend uses),
   transforms it into bhaav.html's format, and writes bhaav-data.json.

   Runs on GitHub's servers, NOT on your Bluehost — so your business
   sites carry zero risk. No API key. No HTML scraping.
   Built for CA Anshul Karwa.
   ============================================================ */

const fs = require('fs');

/* InvestorGain's data endpoint. The path segment 2026/2026-27 is the
   financial year — update it each April (e.g. 2027/2027-28). */
const FY_START = 2026;
const FY_LABEL = '2026-27';
const BASE = `https://webnodejs.investorgain.com/cloud/v2/report/data-read/331/1/7/${FY_START}/${FY_LABEL}/0/all`;

/* source weight for the weighted-average engine (single source for now) */
const SOURCE_WEIGHTS = { investorgain: 91 };

/* ---------- helpers ---------- */
function stripTags(s){ return String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&#8377;/g,'₹').trim(); }
function num(s){ if(s==null) return null; const v=String(s).replace(/[^\d.\-]/g,''); return v===''||v==='--'?null:parseFloat(v); }
function isoDate(s){ if(!s) return null; const d=new Date(s); return isNaN(d)?null:d.toISOString().slice(0,10); }
function dispDate(iso){ if(!iso) return '—'; const d=new Date(iso+'T00:00:00'); if(isNaN(d)) return '—';
  return d.getDate()+' '+d.toLocaleString('en-US',{month:'short'}); }

/* ---------- transform one API row into bhaav's shape ---------- */
function transform(row){
  // name: prefer plain ~ipo_name, else parse title="" out of the Name HTML
  const plain = (row['~ipo_name'] || '').trim();
  const titleM = String(row['Name']||'').match(/title="([^"]+)"/);
  let name = plain || (titleM ? titleM[1] : stripTags(row['Name']));
  name = name.replace(/\s+IPO\s*$/i,'').trim();
  if(!name) return null;

  // type: IPO_Category (SME vs Mainboard)
  const cat = String(row['~IPO_Category']||'').toLowerCase();
  const type = cat.includes('sme') ? 'SME' : 'MAINBOARD';

  // GMP: value inside <b>..</b>, percent inside (...)
  const gmpB = String(row['GMP']||'').match(/<b>([^<]+)<\/b>/);
  let gmpValue = gmpB ? num(gmpB[1]) : num(row['GMP']);
  const pctM = String(row['GMP']||'').match(/\(([^)]+)\)/);
  let gmpPct = pctM ? num(pctM[1]) : (row['~gmp_percent_calc'] ? num(row['~gmp_percent_calc']) : null);

  // price band from "Price (₹)" — may be "163-172" or single
  const priceRaw = stripTags(row['Price (₹)']||'');
  let lo=null, hi=null;
  if(priceRaw.includes('-')){ const [a,b]=priceRaw.split('-'); lo=num(a); hi=num(b); }
  else { hi=lo=num(priceRaw); }
  const issueHi = hi || lo;

  // if GMP % missing but we have value and price, compute it
  if(gmpPct==null && gmpValue!=null && issueHi) gmpPct = +((gmpValue/issueHi)*100).toFixed(1);

  const lot = Math.max(0, Math.floor(num(row['Lot'])||0));

  // dates: sortable ISO fields
  const openI  = isoDate(row['~Srt_Open']);
  const closeI = isoDate(row['~Srt_Close']);
  const listI  = isoDate(row['~Str_Listing']);

  // subscription: "Sub" is often like "1.74x" (total). Keep total; QIB/HNI need the sub endpoint.
  const subTotal = num(row['Sub']);

  // status: badge class + date logic (mirrors investorgain's own frontend)
  const badgeM = String(row['Name']||'').match(/bg-(\w+)/);
  const badge = badgeM ? badgeM[1] : '';
  const today = new Date(); today.setHours(0,0,0,0);
  const dow = today.getDay();
  const todayISO = today.toISOString().slice(0,10);
  let status = 'UPCOMING';
  if(badge==='success') status='OPEN';
  else if(badge==='warning'||badge==='info') status='UPCOMING';
  else if(badge==='secondary'||badge==='light') status='LISTED';
  // refine with dates
  if(openI && closeI){
    if(listI && todayISO >= listI) status='LISTED';
    else if(todayISO > closeI) status='CLOSED';
    else if(closeI===todayISO && (dow===0||dow===6)) status='CLOSED';
    else if(todayISO < openI) status='UPCOMING';
    else if(todayISO>=openI && todayISO<=closeI) status='OPEN';
  }

  // listing price: try several field names the feed may use for a listed IPO
  let actualList = null;
  const listCands = [row['Listing Price'], row['~listing_price'], row['Last Trade'],
                     row['~last_trade_price'], row['LTP'], row['~ltp'], row['Listing']];
  for(const c of listCands){ const v=num(stripTags(c)); if(v!=null && v>0){ actualList=v; break; } }
  // else derive from a listing-gain % if the feed provides one
  if(actualList==null && issueHi){
    const lg = num(row['Listing Gain']) ?? num(row['~listing_gain']) ?? num(row['~list_gain_percent']);
    if(lg!=null) actualList = Math.round(issueHi * (1 + lg/100));
  }

  const rec = {
    name, type, status,
    band:[lo||0, hi||0], lot,
    open:dispDate(openI), close:dispDate(closeI), list:dispDate(listI),
    openISO:openI, closeISO:closeI, listISO:listI,
    prevPct: gmpPct,
    sub:{ qib:0, hni:0, retail:0, total: subTotal||0, day:0 },
    upd:0, new:false, actualList,
    readings: {}
  };
  if(gmpPct!=null) rec.readings.investorgain = { gmp: Math.round(gmpValue||0), pct: +gmpPct.toFixed(1) };
  if(status==='LISTED') rec.lastGmpPct = gmpPct!=null ? +gmpPct.toFixed(1) : 0;

  // estimate bidding day for fake-GMP rule
  if(openI && status==='OPEN'){
    const d = Math.floor((Date.parse(todayISO)-Date.parse(openI))/86400000)+1;
    rec.sub.day = Math.max(1, Math.min(3, d));
  } else if(status==='CLOSED'||status==='LISTED'){ rec.sub.day=3; }

  return rec;
}

/* ---------- weighted GMP (mirror of bhaav.html) ---------- */
function weightedGmp(readings){
  const entries = Object.entries(readings).filter(([k,v])=>v && v.pct!=null && SOURCE_WEIGHTS[k]);
  if(!entries.length) return null;
  let used=entries;
  if(entries.length>=3){
    const pcts=entries.map(([,v])=>v.pct).sort((a,b)=>a-b);
    const med=pcts[Math.floor(pcts.length/2)];
    const trim=entries.filter(([,v])=>Math.abs(v.pct-med)<=25);
    if(trim.length) used=trim;
  }
  let wS=0,pS=0; for(const [k,v] of used){ const w=SOURCE_WEIGHTS[k]; wS+=w; pS+=v.pct*w; }
  return wS? +(pS/wS).toFixed(1) : null;
}

/* ---------- main ---------- */
async function main(){
  // Try several endpoint variants — investorgain's data path can vary.
  const now = Date.now();
  // Confirmed working endpoint (note: /cloud/v2/report/ and /1/7/).
  const candidates = [
    `https://webnodejs.investorgain.com/cloud/v2/report/data-read/331/1/7/${FY_START}/${FY_LABEL}/0/all?search=&v=${now}`,
    `https://webnodejs.investorgain.com/cloud/v2/report/data-read/331/1/7/${FY_START}/${FY_LABEL}/0/0?search=&v=${now}`,
  ];

  let json = null, okUrl = null;
  for (const url of candidates) {
    try {
      console.log('trying:', url);
      const res = await fetch(url, { headers:{
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        'Accept':'application/json, text/plain, */*',
        'Referer':'https://www.investorgain.com/'
      }});
      console.log('  -> HTTP', res.status, res.headers.get('content-type'));
      if (!res.ok) continue;
      const text = await res.text();
      console.log('  -> body length', text.length, '| first 200 chars:', text.slice(0,200).replace(/\n/g,' '));
      let parsed;
      try { parsed = JSON.parse(text); } catch(e){ console.log('  -> not JSON, skipping'); continue; }
      const rows = parsed.reportTableData || parsed.data || parsed.rows;
      if (Array.isArray(rows) && rows.length) { json = parsed; okUrl = url; console.log('  -> SUCCESS: found', rows.length, 'rows'); break; }
      else { console.log('  -> JSON but no usable rows. keys:', Object.keys(parsed).join(', ')); }
    } catch(e){ console.log('  -> error:', e.message); }
  }

  if (!json) {
    console.error('DATA SOURCE FAILED: no candidate returned usable rows.');
    console.error('Leaving any existing bhaav-data.json untouched. See output above for what each URL returned.');
    process.exit(0);
  }

  const rows = json.reportTableData || json.data || json.rows;
  let out = rows.map(transform).filter(Boolean);
  console.log('transformed', out.length, 'IPOs from', okUrl);

  // preserve trend from previous file if present
  try {
    if(fs.existsSync('bhaav-data.json')){
      const prev = JSON.parse(fs.readFileSync('bhaav-data.json','utf8'));
      const pmap={}; prev.forEach(p=>{ if(p.name) pmap[p.name.toLowerCase()]=p; });
      out.forEach(r=>{
        const key=r.name.toLowerCase();
        if(pmap[key]){ const oldW=weightedGmp(pmap[key].readings||{}); if(oldW!=null) r.prevPct=oldW; r.new=false; }
        else { r.new=true; }
      });
    }
  } catch(e){ /* ignore */ }

  fs.writeFileSync('bhaav-data.json', JSON.stringify(out, null, 2));
  console.log('WROTE bhaav-data.json with '+out.length+' IPOs');
}

main();
