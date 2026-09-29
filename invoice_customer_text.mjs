import './public/inspection-checklist.js';

const CYRILLIC=/[\u0400-\u052f]/u;
const WORDS=/[\p{L}\p{N}]+/gu;
const checklist=globalThis.ITTRInspectionChecklist||{};
const catalog=[];
const seen=new Set();
for(const section of [...(checklist.TRUCK_SECTIONS||[]),...(checklist.TRAILER_SECTIONS||[])]){
  for(const item of section.items||[]){
    if(!item?.en||seen.has(item.id))continue;
    seen.add(item.id);
    catalog.push({id:item.id,en:String(item.en),uk:String(item.uk||''),tokens:new Set(tokens(`${item.en} ${item.uk||''}`))});
  }
}

function tokens(value){
  return (String(value||'').toLowerCase().match(WORDS)||[]).filter(x=>x.length>1||/^\d+$/.test(x));
}

function normalizedSide(raw){
  const m=String(raw||'').match(/\b(left|right)\s+side\b/i);
  if(!m)return '';
  return m[1][0].toUpperCase()+m[1].slice(1).toLowerCase()+' side';
}

function inspectionEnglish(raw){
  const source=String(raw||'').trim();
  const body=source.replace(/^inspection\s*:\s*/i,'');
  const input=tokens(body);
  if(!input.length)return '';
  let best=null;
  for(const item of catalog){
    let hits=0;
    for(const token of input)if(item.tokens.has(token))hits++;
    const ratio=hits/Math.max(1,Math.min(input.length,item.tokens.size));
    const score=hits+ratio*3;
    if((hits>=3&&ratio>=0.42)&&(!best||score>best.score))best={item,hits,ratio,score};
  }
  if(!best)return '';
  let out=`Inspection: ${best.item.en}`;
  const side=normalizedSide(source);
  if(side&&!new RegExp(side.replace(' ','\\s+'),'i').test(out))out+=` - ${side}`;
  return out;
}

const PHRASES=[
  [/заміна\s+масла/giu,'oil change'],
  [/заміна\s+оливи/giu,'oil change'],
  [/заміна\s+фільтр(?:а|ів)?/giu,'filter replacement'],
  [/діагностика/giu,'diagnostic'],
  [/перевірка/giu,'inspection'],
  [/ліва\s+сторона/giu,'left side'],
  [/права\s+сторона/giu,'right side'],
  [/передні\s+шини/giu,'steer tires'],
  [/ведуча\s+вісь\s+1/giu,'drive axle 1'],
  [/ведуча\s+вісь\s+2/giu,'drive axle 2'],
  [/передня\s+вісь/giu,'steer axle'],
  [/шини/giu,'tires'],
  [/протектор/giu,'tread'],
  [/пошкодження/giu,'damage'],
  [/тиск/giu,'pressure'],
  [/колодки/giu,'brake linings'],
  [/барабани/giu,'drums'],
  [/барабан/giu,'drum'],
  [/ротори/giu,'rotors'],
  [/ротор/giu,'rotor'],
  [/ремонт/giu,'repair'],
  [/ліва/giu,'left'],
  [/права/giu,'right']
];

export function invoiceEnglishText(value,fallback='Repair / service'){
  const raw=String(value??'').trim();
  if(!raw)return '';
  if(!CYRILLIC.test(raw))return raw;
  const matched=inspectionEnglish(raw);
  if(matched)return matched;
  let out=raw;
  for(const [pattern,replacement] of PHRASES)out=out.replace(pattern,replacement);
  out=out.replace(/\s+/g,' ').replace(/\s*[-–—]+\s*/g,' - ').replace(/\s*\/\s*/g,' / ').trim();
  if(!CYRILLIC.test(out))return out;
  const latin=out.replace(/[\u0400-\u052f]+/gu,' ').replace(/\s+/g,' ').replace(/(^[\s\-/:·]+|[\s\-/:·]+$)/g,'').trim();
  if(/[A-Za-z]/.test(latin)&&latin.length>=4)return latin;
  return fallback;
}

export function invoiceDateText(value){
  if(!value)return '—';
  const d=value instanceof Date?value:new Date(value);
  if(!Number.isNaN(d.getTime()))return new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(d);
  const s=String(value).trim();
  const iso=s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(iso){
    const d2=new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    return new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(d2);
  }
  return s;
}

export function invoiceContainsCyrillic(value){return CYRILLIC.test(String(value||''));}
