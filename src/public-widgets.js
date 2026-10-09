import { escapeHtml, fmtInt } from "./util.js";
import { siteCurrent } from "./store.js";

const snapshots = new Map();
const requestWindows = new Map();
let globalWindow = 0;
let globalRequests = 0;

export function widgetAllowed(ip, now) {
  const window = Math.floor(now/60);
  if (window !== globalWindow) { globalWindow=window;globalRequests=0;requestWindows.clear(); }
  if (++globalRequests > 1200) return false;
  const count = requestWindows.get(ip) || 0;
  if (!count && requestWindows.size >= 256) return false;
  if (count >= 120) return false;
  requestWindows.set(ip,count+1);
  return true;
}

export function widgetData(db, key, now) {
  const site = db.prepare("SELECT sites.id,sites.domain FROM sites JOIN public_widgets ON public_widgets.site_id=sites.id WHERE sites.public_key=? AND public_widgets.enabled=1").bind(key).first();
  if (!site) return null;
  const cached = snapshots.get(site.id);
  if (cached && cached.db === db && now - cached.at < 30) return cached.data;
  const today = Math.floor(now / 86400) * 86400;
  const rows = db.prepare("SELECT cast(ts/86400 AS INTEGER)*86400 AS day,count(*) AS pageviews,count(DISTINCT visitor) AS visitors FROM events WHERE site_id=? AND ts>=? AND ts<? AND name='pageview' GROUP BY day ORDER BY day").bind(site.id,today-6*86400,now+1).all().results;
  const days = [];
  let visitors = 0;
  let pageviews = 0;
  for (let i=0;i<7;i++) {
    const day = today-(6-i)*86400;
    const row = rows.find((item) => Number(item.day) === day);
    const value = row ? Number(row.visitors) : 0;
    days.push(value);
    visitors += value;
    pageviews += row ? Number(row.pageviews) : 0;
  }
  const data = { domain:site.domain, current:siteCurrent(db,site.id), visitors, pageviews, days, updated:now };
  if (snapshots.size >= 64) snapshots.delete(snapshots.keys().next().value);
  snapshots.set(site.id,{at:now,data,db});
  return data;
}

export function widgetPage(data, size, theme) {
  const maximum = Math.max(1,...data.days);
  const values = data.days.map((value) => 72-value/maximum*56);
  const slopes = values.slice(1).map((value,i) => (value-values[i])/80);
  const tangents = values.map((_value,i) => {
    if (i === 0) return slopes[0];
    if (i === values.length-1) return slopes[i-1];
    const left = slopes[i-1];
    const right = slopes[i];
    return left*right <= 0 ? 0 : 2*left*right/(left+right);
  });
  let curve = "M0 "+values[0];
  for (let i=1;i<values.length;i++) {
    curve += " C"+((i-1)*80+80/3)+" "+(values[i-1]+tangents[i-1]*80/3)+" "+(i*80-80/3)+" "+(values[i]-tangents[i]*80/3)+" "+(i*80)+" "+values[i];
  }
  const dark = theme === "dark";
  const text = escapeHtml(data.domain);
  const formatted = fmtInt;
  const chart = '<svg preserveAspectRatio="none" viewBox="0 0 480 84" role="img" aria-label="Daily visitors over the last seven UTC days"><path d="M0 72H480 M0 40H480" class="grid"/><path d="'+curve+' L480 84 L0 84Z" class="area"/><path d="'+curve+'" class="line"/></svg>';
  return '<!doctype html><html lang="en" class="'+(dark ? 'theme-dark' : '')+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+text+' traffic</title><link rel="preload" href="/widget-geist.woff2" as="font" type="font/woff2" crossorigin><style>'+`
:root{--widget-fg:#171717;--widget-bg:#ffffff;--widget-line:#eaeaea;--widget-muted:#666666}.theme-dark{--widget-fg:#ededed;--widget-bg:#111111;--widget-line:#2e2e2e;--widget-muted:#a1a1a1}@font-face{font-family:Geist;src:url(/widget-geist.woff2) format("woff2");font-weight:100 900;font-display:optional}*{box-sizing:border-box}html,body{margin:0;background:transparent}body{font:13px Geist,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--widget-fg);font-variant-numeric:tabular-nums}.card{width:100%;height:100vh;padding:20px;border:1px solid var(--widget-line);border-radius:10px;background:var(--widget-bg);overflow:hidden}.top,.bottom,.metrics,.live{display:flex;align-items:center;justify-content:space-between}.domain{font-weight:500;letter-spacing:-.2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.live{gap:6px;justify-content:flex-start;white-space:nowrap;font-size:11px;color:var(--widget-muted)}.dot.stale{background:#8f8f8f;box-shadow:none}.dot{width:6px;height:6px;border-radius:50%;background:#45a557;box-shadow:0 0 0 2px #45a5571f,0 0 8px 2px #45a5574d}.metrics{justify-content:flex-start;gap:40px;margin:22px 0 8px}.number{font-size:32px;font-weight:500;letter-spacing:-1.4px;line-height:1.1}.label,.bottom{color:var(--widget-muted);font-size:11px}.label{margin-top:5px}svg{display:block;width:100%;height:69px;overflow:visible}.grid{stroke:var(--widget-line);stroke-width:1;fill:none}.area{fill:var(--widget-fg);opacity:.06}.line{fill:none;stroke:var(--widget-fg);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}.bottom{margin-top:9px}.brand{font-weight:500;color:inherit;text-decoration:none}.small{padding:0 15px;display:flex;align-items:center;gap:12px;border-radius:10px}.small .domain{font-size:12px}.small .live{margin-left:auto}.medium .metrics{margin-top:21px}.medium .number{font-size:29px}.medium svg{height:58px}.wide .metrics{margin-top:23px}.wide .number{font-size:36px}@media(max-width:300px){.small{gap:8px;padding:0 10px}.small .domain{max-width:130px}}
`+'</style></head><body><article class="card '+size+'">'+
    (size === "small" ? '<span class="domain">'+text+'</span><span class="live"><span class="dot"></span><strong data-current>'+formatted(data.current)+'</strong> online now</span>' :
    '<div class="top"><span class="domain">'+text+'</span><span class="live"><span class="dot"></span><span data-current>'+formatted(data.current)+'</span> online</span></div><div class="metrics"><div><div class="number" data-visitors>'+formatted(data.visitors)+'</div><div class="label">Visitors</div></div><div><div class="number" data-pageviews>'+formatted(data.pageviews)+'</div><div class="label">Pageviews</div></div></div>'+chart+'<div class="bottom"><span data-status>Last 7 days · UTC</span><a class="brand" href="https://risulta.dev" target="_blank" rel="noopener">Risulta ↗</a></div>')+
    '</article><script defer src="/widget-frame.js"></script></body></html>';
}
