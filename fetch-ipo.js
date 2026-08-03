/* ============================================================
   भाव (Bhaav) - automatic data fetcher
   Runs on GitHub Actions (free) every 30 minutes. Calls InvestorGain's
   own JSON data endpoint (the same one their website frontend uses),
   transforms it into bhaav.html's format, and writes bhaav-data.json.

   Runs on GitHub's servers, NOT on your Bluehost - so your business
   sites carry zero risk. No API key. No HTML scraping.
   Built for CA Anshul Karwa.
   ============================================================ */

const fs = require('fs');

/* InvestorGain's data endpoint. The path segment 2026/2026-27 is the
   financial year - update it each April (e.g. 2027/2027-28). */
const FY_START = 2026;
const FY_LABEL = '2026-27';
const BASE = `https://webnodejs.investorgain.com/cloud/v2/report/data-read/331/1/7/${FY_START}/${FY_LABEL}/0/all`;

/* source weight for the weighted-average engine (single source for now) */
const SOURCE_WEIGHTS = { investorgain: 91 };

/* ---------- helpers ---------- */
function stripTags(s){ return String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&#8377;/g,'₹').trim(); }
function num(s){ if(s==null) return null; const v=String(s).replace(/[^\d.\-]/g,''); return v===''||v==='--'?null:parseFloat(v); }
function isoDate(s){ if(!s) return null; const d=new Date(s); return isNaN(d)?null:d.toISOString().slice(0,10); }
function dispDate(iso){ if(!iso) return '-'; const d=new Date(iso+'T00:00:00'); if(isNaN(d)) return '-';
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

  // price band from "Price (₹)" - may be "163-172" or single
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

  // subscription (times, e.g. "1.74x"). Try several fields; strip HTML; sanity-cap.
  function parseSub(v){
    if(v==null) return 0;
    let str=stripTags(String(v)).toLowerCase();
    str=str.replace(/times|x|,|\s/g,'').trim();
    if(str===''||str==='-'||str==='--') return 0;
    const n=parseFloat(str);
    if(!isFinite(n) || n<0) return 0;
    if(n>5000) return 0;              // subscription realistically 0..5000x; above = parse error
    return +n.toFixed(2);
  }
  const subTotal = parseSub(row['Sub'] ?? row['~sub'] ?? row['Subscription'] ?? row['~subscription'] ?? row['Total Sub'] ?? row['~total_sub']);
  const subQib   = parseSub(row['QIB'] ?? row['~qib']);
  const subHni   = parseSub(row['NII'] ?? row['HNI'] ?? row['~nii'] ?? row['~hni']);
  const subRet   = parseSub(row['Retail'] ?? row['RII'] ?? row['~retail']);

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

  // listing price: ONLY accept a value that's plausibly a real listing price.
  // A real listing is never 90% below issue price. Require it within 40%-300% of issue.
  let actualList = null;
  if(issueHi){
    const cands = [row['Listing Price'], row['~listing_price'], row['Last Trade'],
                   row['~last_trade_price'], row['LTP'], row['~ltp']];
    for(const c of cands){
      const v = num(stripTags(c));
      if(v!=null && v >= issueHi*0.4 && v <= issueHi*3){ actualList=v; break; }  // sanity band
    }
    // else derive from an explicit listing-gain % if present and sane
    if(actualList==null){
      const lg = num(row['Listing Gain']) ?? num(row['~listing_gain']) ?? num(row['~list_gain_percent']);
      if(lg!=null && lg>=-60 && lg<=300) actualList = Math.round(issueHi * (1 + lg/100));
    }
  }
  // if we still don't have a trustworthy number, leave it null -> card shows "awaited"

  // extra info fields from the feed
  const issueSize = stripTags(row['IPO Size'] || '').replace(/&#8377;/g,'\u20B9').trim() || null;
  const folder = row['~urlrewrite_folder_name'] || '';
  const infoUrl = folder ? ('https://www.investorgain.com' + folder) : null;   // page has DRHP + anchor list
  const hasAnchor = /✅|green/i.test(String(row['Anchor']||''));

  const rec = {
    name, type, status,
    band:[lo||0, hi||0], lot,
    open:dispDate(openI), close:dispDate(closeI), list:dispDate(listI),
    openISO:openI, closeISO:closeI, listISO:listI,
    prevPct: gmpPct,
    sub:{ qib:subQib, hni:subHni, retail:subRet, total: subTotal||0, day:0 },
    upd:0, new:false, actualList,
    issueSize, infoUrl, hasAnchor,
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
  // Try several endpoint variants - investorgain's data path can vary.
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

  /* ---------- manual corrections (optional) ----------
     The feed has NO listing price, so add real listing prices (or fix any figure)
     in corrections.json in this repo. Format:
       { "Indo-MIM": { "actualList": 640 },
         "Some IPO": { "actualList": 512, "gmpPct": 12.5, "gmpValue": 60 } }
     Whatever you put here ALWAYS overrides the feed and never gets wiped. */
  try {
    if(fs.existsSync('corrections.json')){
      const corr = JSON.parse(fs.readFileSync('corrections.json','utf8'));
      const cmap={}; for(const k in corr) cmap[k.toLowerCase().trim()]=corr[k];
      let applied=0;
      out.forEach(r=>{
        const c = cmap[r.name.toLowerCase().trim()];
        if(!c) return;
        if(c.actualList!=null) r.actualList = c.actualList;
        if(c.gmpPct!=null || c.gmpValue!=null){
          r.readings.investorgain = {
            gmp: c.gmpValue!=null ? Math.round(c.gmpValue) : (r.readings.investorgain?.gmp||0),
            pct: c.gmpPct!=null ? +(+c.gmpPct).toFixed(1) : (r.readings.investorgain?.pct||0)
          };
        }
        if(c.type) r.type = c.type;
        if(c.issueSize) r.issueSize = c.issueSize;
        applied++;
      });
      if(applied) console.log('applied '+applied+' manual correction(s) from corrections.json');
    }
  } catch(e){ console.log('corrections.json skipped:', e.message); }

  fs.writeFileSync('bhaav-data.json', JSON.stringify(out, null, 2));
  console.log('WROTE bhaav-data.json with '+out.length+' IPOs');

  await maybeNotifyTelegram(out);
}

/* ---------- Telegram daily reminder ----------
   Posts "closing today" IPOs to a Telegram channel, once per day.
   Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as GitHub repo secrets.
   Only fires between 09:30-10:30 UTC-ish window check handled by the workflow schedule;
   here we guard so it posts at most once per day using a marker file. */
async function maybeNotifyTelegram(out){
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  if(!token || !chat){ console.log('Telegram not configured (no secrets) - skipping.'); return; }

  // Use IST date + time (India), not UTC, so "today" and the 10 AM window match the IPO calendar.
  const nowIST = new Date(Date.now() + (5.5*60 - new Date().getTimezoneOffset())*60000);
  const today = nowIST.toISOString().slice(0,10);
  const istHour = nowIST.getUTCHours();   // nowIST is shifted, so getUTCHours() = IST hour
  const testMode = process.env.TG_TEST==="1";

  // Only send during the 10 AM IST hour (10:00-10:59). Test mode ignores the time window.
  if(!testMode && istHour!==10){
    console.log(`Telegram: not the 10 AM IST window (IST hour=${istHour}) - skipping.`);
    return;
  }

  // once-a-day guard (skipped in test mode)
  if(!testMode){
    try{ if(fs.existsSync('.tg-last') && fs.readFileSync('.tg-last','utf8').trim()===today){ console.log('Telegram already posted today for '+today+'.'); return; } }catch(e){}
  }

  // IPOs whose last day is today (any status - date is what matters), and opening today
  const closing = out.filter(r=> r.closeISO===today);
  const opening = out.filter(r=> r.openISO===today);
  console.log(`Telegram check: today(IST)=${today}, IST hour=${istHour}, closing=${closing.length}, opening=${opening.length}`);
  if(!testMode && !closing.length && !opening.length){ console.log('Nothing closing/opening today for Telegram.'); return; }

  let msg = "🔔 *Bhaav IPO reminder* - "+today+"\n\n";
  if(testMode && !closing.length && !opening.length){
    msg += "_(test message - Telegram alerts are working. Real alerts will list IPOs opening/closing that day.)_\n\n";
  }
  if(closing.length){
    msg += "⏳ *Last day to apply today:*\n";
    closing.forEach(r=>{
      const g=r.readings.investorgain;
      const gtxt = g ? `GMP ${g.pct>0?"+":""}${g.pct}% (\u20B9${g.gmp}/share)` : "GMP n/a";
      msg += `• *${r.name}* (${r.type})\n   ${gtxt}  |  Price \u20B9${r.band[0]}-${r.band[1]}\n`;
    });
    msg += "\n";
  }
  if(opening.length){
    msg += "🟢 *Opening today:*\n";
    opening.forEach(r=>{
      const g=r.readings.investorgain;
      const gtxt = g ? `GMP ${g.pct>0?"+":""}${g.pct}% (\u20B9${g.gmp}/share)` : "GMP not out yet";
      msg += `• *${r.name}* (${r.type})\n   ${gtxt}  |  Price \u20B9${r.band[0]}-${r.band[1]}\n`;
    });
    msg += "\n";
  }
  msg += "_GMP is unofficial - verify before applying._\n\n";
  msg += "Posted automatically by *Bhaav*\n";
  msg += "Made by [CA Anshul Karwa](https://www.linkedin.com/in/anshulkarwa/)";

  try{
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ chat_id:chat, text:msg, parse_mode:"Markdown", disable_web_page_preview:true })
    });
    const j = await res.json();
    if(j.ok){ console.log('Telegram posted.'); if(!testMode) fs.writeFileSync('.tg-last', today); }
    else console.log('Telegram error:', JSON.stringify(j).slice(0,300));
  }catch(e){ console.log('Telegram send failed:', e.message); }
}

main();
