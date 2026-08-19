/* ============================================================
   CRT Desk — Futures Prop Tracker
   Motor de métricas + UI. Persistencia en localStorage.
   ============================================================ */

const STORE_KEY = 'swingdesk_v1';

/* ============================================================
   REGLAS MULTI-FIRMA
   Cada plan = { firm, plan, size, phases:{eval:{...}, funded:{...}} }
   Campos por fase:
     profitTarget  — objetivo de profit ($). 0 en funded si no aplica.
     drawdown      — cantidad del trailing EOD ($)
     trailLock     — balance de cierre en que el suelo se bloquea (0 = no bloquea)
     lockedFloor   — suelo una vez bloqueado ($) (0 = no aplica)
     dailyLoss     — daily loss limit ($). 0 = sin DLL.
     maxMicro/maxMini — tope de contratos
     minDays       — mínimo días de trading
     consistency   — % máx día/total (0 = sin regla)
     minDailyProfit — mínimo para contar día de payout (funded)
     payoutCap     — tope de retirada
   ============================================================ */

// Preset verificado: LucidFlex (support.lucidtrading.com). Eval y funded comparten trailing.
const FIRM_PRESETS = {
  'LucidFlex': {
    trailing:'eod',
    plans:{
      '25K': { size:25000, eval:{profitTarget:1250,drawdown:1000,trailLock:26100,lockedFloor:25100,dailyLoss:0,maxMicro:20,maxMini:2,minDays:1,consistency:50,minDailyProfit:100,payoutCap:1000},
                          funded:{profitTarget:0,drawdown:1000,trailLock:26100,lockedFloor:25100,dailyLoss:0,maxMicro:20,maxMini:2,minDays:5,consistency:0,minDailyProfit:100,payoutCap:1000} },
      '50K': { size:50000, eval:{profitTarget:3000,drawdown:2000,trailLock:52100,lockedFloor:50100,dailyLoss:0,maxMicro:40,maxMini:4,minDays:1,consistency:50,minDailyProfit:150,payoutCap:2000},
                          funded:{profitTarget:0,drawdown:2000,trailLock:52100,lockedFloor:50100,dailyLoss:0,maxMicro:40,maxMini:4,minDays:5,consistency:0,minDailyProfit:150,payoutCap:2000} },
      '100K':{ size:100000,eval:{profitTarget:6000,drawdown:3000,trailLock:103100,lockedFloor:100100,dailyLoss:0,maxMicro:60,maxMini:6,minDays:1,consistency:50,minDailyProfit:200,payoutCap:2500},
                          funded:{profitTarget:0,drawdown:3000,trailLock:103100,lockedFloor:100100,dailyLoss:0,maxMicro:60,maxMini:6,minDays:5,consistency:0,minDailyProfit:200,payoutCap:2500} },
      '150K':{ size:150000,eval:{profitTarget:9000,drawdown:4500,trailLock:154600,lockedFloor:150100,dailyLoss:0,maxMicro:100,maxMini:10,minDays:1,consistency:50,minDailyProfit:250,payoutCap:3000},
                          funded:{profitTarget:0,drawdown:4500,trailLock:154600,lockedFloor:150100,dailyLoss:0,maxMicro:100,maxMini:10,minDays:5,consistency:0,minDailyProfit:250,payoutCap:3000} }
    }
  },

  // Topstep — 50K (trailing EOD por elección del usuario). Combine + Express Funded (opción Standard).
  'Topstep': {
    trailing:'eod',
    plans:{
      '50K': { size:50000,
        eval:{profitTarget:3000,drawdown:2000,trailLock:0,lockedFloor:0,dailyLoss:1000,maxMicro:50,maxMini:5,minDays:1,consistency:50,minDailyProfit:0,payoutCap:0},
        funded:{profitTarget:0,drawdown:2000,trailLock:0,lockedFloor:0,dailyLoss:1000,maxMicro:50,maxMini:5,minDays:5,consistency:0,minDailyProfit:150,payoutCap:4000} }
    }
  },

  // MyFundedFutures — 50K Builder (Max Drawdown EOD + Daily Drawdown). Micro scaling 10:1.
  'MyFundedFutures': {
    trailing:'eod',
    plans:{
      '50K Builder': { size:50000,
        eval:{profitTarget:3000,drawdown:2000,trailLock:0,lockedFloor:0,dailyLoss:1000,maxMicro:40,maxMini:4,minDays:1,consistency:0,minDailyProfit:0,payoutCap:0},
        funded:{profitTarget:0,drawdown:2000,trailLock:0,lockedFloor:0,dailyLoss:1000,maxMicro:40,maxMini:4,minDays:2,consistency:50,minDailyProfit:0,payoutCap:2000} }
    }
  },

  // FundedNext Futures — 50K. Max Loss EOD, sin daily loss.
  'FundedNext': {
    trailing:'eod',
    plans:{
      '50K': { size:50000,
        eval:{profitTarget:2500,drawdown:1500,trailLock:0,lockedFloor:0,dailyLoss:0,maxMicro:30,maxMini:3,minDays:1,consistency:40,minDailyProfit:0,payoutCap:0},
        funded:{profitTarget:0,drawdown:1500,trailLock:0,lockedFloor:0,dailyLoss:0,maxMicro:30,maxMini:3,minDays:5,consistency:0,minDailyProfit:0,payoutCap:1500} }
    }
  }
};

const DEFAULTS = {
  trades: [],
  accounts: [],
  noTradeDays: [],   // {id, date, reason, note}
  propCosts: [],     // {id, date, amount, concept, firm}
  payouts: [],       // {id, date, amount, concept, firm}
  firms: null,   // se inicializa desde FIRM_PRESETS la primera vez (así el usuario puede editarlas)
  settings: { riskPerTradePct: 25 },
  meta: { created: Date.now() }
};

// Motius de dia sense trade
const NOTRADE_REASONS = {
  no_setup:'No hi havia setup vàlid',
  no_time:'No vaig poder mirar el mercat',
  rest:'Descans / dia off',
  news:'Notícies o mercat impredictible',
  stop_done:'Ja havia fet el meu stop del dia',
  other:'Altres'
};

let DB = load();

function load(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    const base = raw ? Object.assign(structuredClone(DEFAULTS), JSON.parse(raw)) : structuredClone(DEFAULTS);
    // inicializar firmas desde presets si es la primera vez
    if(!base.firms){ base.firms = structuredClone(FIRM_PRESETS); }
    // añadir firmas de preset que aún no estén (sin pisar las editadas por el usuario)
    Object.keys(FIRM_PRESETS).forEach(f=>{
      if(!base.firms[f]) base.firms[f]=structuredClone(FIRM_PRESETS[f]);
    });
    // migrar cuentas viejas (modelo size/maxDD) al nuevo firm/plan
    (base.accounts||[]).forEach(a=>{
      if(!a.plan && a.size){
        a.firm = a.firm||'LucidFlex';
        a.plan = (a.size/1000)+'K';
        a.phase = a.phase||'Evaluación';
      }
    });
    // migrar nombres de sesión antiguos a los nuevos
    const SESSION_MIGRATION={
      'Londres':'Londres (9-12)',
      'NY':'NY (15:30+)',
      'Asia':'Otra',
      'Overlap':'Otra'
    };
    (base.trades||[]).forEach(t=>{
      if(t.session && SESSION_MIGRATION[t.session]) t.session=SESSION_MIGRATION[t.session];
    });
    return base;
  }catch(e){
    const d = structuredClone(DEFAULTS);
    d.firms = structuredClone(FIRM_PRESETS);
    return d;
  }
}

// Helper: obtener specs de un plan/fase
function planSpec(firmName, planName, phase){
  const f = (DB.firms||{})[firmName];
  if(!f || !f.plans[planName]) return null;
  const p = f.plans[planName];
  return { size:p.size, trailing:f.trailing||'eod', ...(p[phase==='Funded'?'funded':'eval']) };
}
function save(){ localStorage.setItem(STORE_KEY, JSON.stringify(DB)); }

/* ---------- helpers ---------- */
const $ = (s,el=document)=>el.querySelector(s);
const $$ = (s,el=document)=>[...el.querySelectorAll(s)];
const uid = ()=>Math.random().toString(36).slice(2,10);
const fmt = (n,d=2)=> (n==null||isNaN(n)) ? '—' : Number(n).toLocaleString('es-ES',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtR = n => (n>0?'+':'')+fmt(n,2)+'R';
const fmt$ = n => (n<0?'-':'')+'$'+fmt(Math.abs(n),0);
const cls = n => n>0?'pos':n<0?'neg':'neu';
const todayISO = ()=> new Date().toISOString().slice(0,10);

function toast(msg){
  const t=$('#toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2200);
}

/* ============================================================
   SISTEMA DE AYUDA (?) — explicaciones de cada métrica
   ============================================================ */
const HELP_TEXTS={
  // Resumen
  expectancy:['Expectancy','Lo que ganas o pierdes de media por trade, en R. Es la métrica más importante: si es +0,3R, cada trade te da de media 0,3 veces lo que arriesgas. Positiva = tienes ventaja; negativa = pierdes a la larga.'],
  winrate:['Win rate','Porcentaje de trades ganadores. Ojo: un winrate alto no significa ganar dinero — depende de tu R:R. Por eso nunca se mira solo.'],
  profitfactor:['Profit factor','Dólares ganados ÷ dólares perdidos. Por encima de 1 ganas; 2 significa que ganas el doble de lo que pierdes.'],
  totalr:['R acumulado','La suma de todos tus R. Tu resultado total en unidades de riesgo, independiente del tamaño de cada trade.'],
  maxdd:['Max drawdown','La mayor caída desde un pico en tu curva de resultados. Mide tu peor racha: cuánto llegaste a bajar antes de recuperar.'],
  disccost:['Coste de la indisciplina','Cuántos R y euros pierdes por errores de ejecución. Compara lo que tu plan habría dado con lo que sacaste, en los trades donde marcaste algún error. Te dice en dinero lo que te cuesta saltarte tus reglas.'],
  equity:['Curva de equity','Tu R acumulado a lo largo del tiempo. La forma de tu progresión: idealmente sube de forma constante.'],
  cumchart:['Winrate y expectancy acumulados','Cómo evolucionan esas dos métricas trade a trade. Sirve para ver si tu ventaja mejora, se estabiliza o se degrada con el tiempo.'],
  // Disciplina
  discrate:['Tasa de disciplina','Porcentaje de trades sin ningún error marcado. Cuanto más alto, más fiel eres a tu plan.'],
  cleanstreak:['Racha días limpios','Cuántos días seguidos llevas sin cometer errores de ejecución.'],
  edgeclean:['Edge limpio vs con error','Compara tu expectancy cuando operas limpio contra cuando cometes errores. Te demuestra en números cuánto te penalizan los fallos.'],
  flagbreakdown:['Desglose por tipo de error','Cuántas veces cometes cada error (FOMO, cierre temprano...) y cuánto R te cuesta cada uno. Te dice cuál atacar primero.'],
  planadher:['Adherencia al plan','Compara tu expectancy cuando cumples las 6 reglas de tu plan vs cuando te saltas alguna. Demuestra si tu plan funciona.'],
  // Rendimiento
  avgwin:['Avg win','Tu ganancia media en los trades ganadores, en R.'],
  avgloss:['Avg loss','Tu pérdida media en los trades perdedores, en R.'],
  breakdowns:['Desgloses','Tu rendimiento separado por setup, sesión, símbolo... Sirve para ver dónde ganas de verdad y dónde pierdes.'],
  optimalrr:['R:R óptimo','Usa tu MFE para simular qué TP te daría más rentabilidad. Marca tu DOL medio (del campo "DOL en R" que registras) para comparar si tu óptimo cae antes, en o después del DOL.'],
  manualclose:['Cierres manuales','Analiza tus cierres antes del TP. Respeta tu criterio: si marcaste "limpio", fue buena decisión. Solo cuenta como coste los que marcaste con error.'],
  dolreach:['¿Llega al DOL?','De tus trades que no acabaron en stop, cada cuánto el precio llega a tu DOL final. Te dice si aguantar hasta el DOL compensa o conviene asegurar antes.'],
  beanalysis:['Análisis de BE','De tus salidas por BE saltado: cuántos moviste según plan vs por impulso, y cuántos habrían ido a TP (usando el MFE). Te dice si mover el BE pronto te cuesta ganadores.'],
  maeanalysis:['¿SL demasiado lejos?','Usa el MAE (cuánto fue el precio en contra) de tus ganadores para ver si tu stop está muy holgado. Si tus ganadores sufren poco antes de girarse, podrías ajustar el SL. Te avisa de no comerte las manipulaciones.'],
  movetype:['Origen del movimiento','Compara tu rendimiento según dónde empezó el movimiento: el impulso de apertura NY (9:30-10h) o el PO3 de la vela de 4h de las 10h. Te dice con qué estructura CRT ganas más.'],
  smt:['RS Scalp (SMT)','De las entradas por SMT que aparecieron (entraras o no): cuántas van a TP y si el timing respecto a la apertura NY influye. Sirve para validar esta subestrategia antes de confiar en ella.'],
  distribution:['Distribución de R','Cuántos trades caen en cada rango de R. La altura es número de trades. Muestra la forma de tus resultados.'],
  streaks:['Rachas','Tu racha actual y tus récords de victorias y derrotas seguidas. Ayuda con la psicología: saber tu peor racha histórica te calma cuando encadenas pérdidas.'],
  daydisc:['Día + disciplina','Tu rendimiento y % de errores por día de la semana. Te dice si un mal día es por el mercado o porque tú operas peor ese día.'],
  bymonth:['Rendimiento por mes','Tu expectancy, winrate, R acumulado y % de errores mes a mes. Sirve para ver tu evolución en el tiempo y si vas mejorando.'],
  // Sizing
  kelly:['Kelly','Termómetro de tu edge, no tu sizing. Valida si tienes ventaja real. Necesita 30+ trades para ser fiable.'],
  roiglobal:['ROI global','Tu negocio de props: total gastado en cuentas vs total cobrado en payouts. El ROI % te dice cuánto recuperas por cada $ invertido.'],
  funnel:['Estadística de cuentas','El recorrido de tus cuentas: cuántas pasaste (% aprobación), de las fondeadas cuántas dieron payout (% conversión), y el payout medio. Se calcula con el estado de cada cuenta.']
};
let _helpOpen=null;
function helpIcon(key){ return `<span class="help" onclick="showHelp(event,'${key}')">?</span>`; }
function showHelp(ev,key){
  ev.stopPropagation();
  const pop=$('#helpPop');
  const h=HELP_TEXTS[key];
  if(!h){ return; }
  if(_helpOpen===key){ pop.classList.remove('show'); _helpOpen=null; return; }
  pop.innerHTML=`<span class="hp-title">${h[0]}</span>${h[1]}`;
  pop.classList.add('show');
  _helpOpen=key;
  // posicionar cerca del icono
  const r=ev.target.getBoundingClientRect();
  const pw=280, ph=pop.offsetHeight||120;
  let left=r.left; let top=r.bottom+8;
  if(left+pw>window.innerWidth-12) left=window.innerWidth-pw-12;
  if(top+ph>window.innerHeight-12) top=r.top-ph-8;
  pop.style.left=Math.max(12,left)+'px';
  pop.style.top=Math.max(12,top)+'px';
}
document.addEventListener('click',e=>{
  if(!e.target.classList.contains('help')){ const p=$('#helpPop'); if(p){p.classList.remove('show'); _helpOpen=null;} }
});

/* ============================================================
   MÉTRICAS — el corazón del dashboard
   ============================================================ */

// Cada trade:
// {id, date, session, setup, symbol, account,
//  plannedR (R objetivo segun TP/SL al entrar),
//  realizedR (R que sacaste de verdad),
//  pnl ($ real), riskUSD ($ arriesgado),
//  result win|loss|be, flags:[], note}

// Filtro global de fase: 'all' | 'eval' | 'funded'
let PHASE_FILTER = 'all';

// Resuelve la fase de un trade a partir de la cuenta asignada
function tradePhase(t){
  // La fase se guarda en el trade al crearlo. Los trades viejos sin phase
  // la deducen de la fase actual de la cuenta (compatibilidad).
  if(t.phase==='funded'||t.phase==='eval') return t.phase;
  if(!t.account) return null;
  const acc = DB.accounts.find(a=>a.name===t.account);
  if(!acc) return null;
  return acc.phase==='Funded' ? 'funded' : 'eval';
}

function tradesFiltered(filterFn){
  let arr = DB.trades;
  if(PHASE_FILTER!=='all'){
    arr = arr.filter(t=> tradePhase(t)===PHASE_FILTER);
  }
  return arr.filter(filterFn||(()=>true)).sort((a,b)=> a.date<b.date?1:-1);
}

function expectancy(trades){
  if(!trades.length) return 0;
  const sum = trades.reduce((s,t)=> s + (t.realizedR||0), 0);
  return sum / trades.length;
}
function winrate(trades){
  const counted = trades.filter(t=>t.result!=='be');
  if(!counted.length) return 0;
  return counted.filter(t=>t.result==='win').length / counted.length * 100;
}
function avgWin(trades){
  const w = trades.filter(t=>t.result==='win');
  return w.length? w.reduce((s,t)=>s+(t.realizedR||0),0)/w.length : 0;
}
function avgLoss(trades){
  const l = trades.filter(t=>t.result==='loss');
  return l.length? l.reduce((s,t)=>s+(t.realizedR||0),0)/l.length : 0;
}
function profitFactor(trades){
  const gains = trades.filter(t=>t.realizedR>0).reduce((s,t)=>s+t.realizedR,0);
  const losses = Math.abs(trades.filter(t=>t.realizedR<0).reduce((s,t)=>s+t.realizedR,0));
  return losses? gains/losses : (gains>0?Infinity:0);
}
function totalR(trades){ return trades.reduce((s,t)=>s+(t.realizedR||0),0); }
function totalPnl(trades){ return trades.reduce((s,t)=>s+(t.pnl||0),0); }

// Rachas de victorias/derrotas (en orden cronológico). BE no rompe racha, la ignora.
function streaks(trades){
  const ch=[...trades].sort((a,b)=> a.date<b.date?-1: a.date>b.date?1:0);
  let maxWin=0, maxLoss=0, curW=0, curL=0, curType=null, curCount=0;
  ch.forEach(t=>{
    if(t.result==='win'){ curW++; maxWin=Math.max(maxWin,curW); curL=0; }
    else if(t.result==='loss'){ curL++; maxLoss=Math.max(maxLoss,curL); curW=0; }
    // be: no toca las rachas
  });
  // racha actual: recorrer desde el final
  for(let i=ch.length-1;i>=0;i--){
    const r=ch[i].result;
    if(r==='be') continue;
    if(curType===null){ curType=r; curCount=1; }
    else if(r===curType){ curCount++; }
    else break;
  }
  return { maxWin, maxLoss, curType, curCount };
}

// Día de la semana cruzado con disciplina: expectancy + tasa de errores por día
function dayDisciplineBreakdown(trades){
  const names=['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const map={};
  trades.forEach(t=>{
    const [yy,mm,dd]=t.date.split('-').map(Number);
    const wd=new Date(yy,mm-1,dd).getDay();
    const k=names[wd];
    map[k]=map[k]||[];
    map[k].push(t);
  });
  // orden lun-vie-sáb-dom
  const order=['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
  return order.filter(k=>map[k]).map(k=>{
    const ts=map[k];
    const errRate = ts.length? ts.filter(t=>(t.flags||[]).some(f=>f!=='clean')).length/ts.length*100 : 0;
    return { key:k, n:ts.length, exp:expectancy(ts), wr:winrate(ts), errRate };
  });
}

// Rendimiento por mes: expectancy, winrate, R acumulado, nº trades
function monthBreakdown(trades){
  const names=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const map={};
  trades.forEach(t=>{
    const [yy,mm]=t.date.split('-').map(Number);
    const k=`${names[mm-1]} ${String(yy).slice(2)}`;
    const sortKey=yy*100+mm;
    map[k]=map[k]||{ts:[],sortKey};
    map[k].ts.push(t);
  });
  return Object.keys(map)
    .sort((a,b)=>map[a].sortKey-map[b].sortKey)
    .map(k=>{
      const ts=map[k].ts;
      const errRate = ts.length? ts.filter(t=>(t.flags||[]).some(f=>f!=='clean')).length/ts.length*100 : 0;
      return { key:k, n:ts.length, exp:expectancy(ts), wr:winrate(ts), r:ts.reduce((s,t)=>s+(t.realizedR||0),0), errRate };
    });
}

/* ---------- R:R óptimo según MFE ----------
   Para cada nivel de TP simula: si el MFE del trade >= TP -> habría cobrado ese TP (+TP R).
   Si no -> el trade se habría ido al SL (-1R), asumiendo SL fijo de -1R.
   Devuelve la expectancy de cada nivel y cuál es el óptimo. */
function optimalRR(trades){
  const withMfe = trades.filter(t=>!isNaN(t.mfe)&&t.mfe!=null);
  if(withMfe.length<5) return { enough:false, n:withMfe.length };
  const levels=[0.5,1,1.5,2,2.5,3,3.5,4];
  const curve = levels.map(tp=>{
    let sumR=0, wins=0;
    withMfe.forEach(t=>{
      if(t.mfe>=tp){ sumR+=tp; wins++; }   // el precio alcanzó este TP
      else sumR+=-1;                         // no llegó -> SL
    });
    return { tp, exp:sumR/withMfe.length, wr:wins/withMfe.length*100 };
  });
  const best = curve.reduce((a,b)=> b.exp>a.exp?b:a, curve[0]);
  // DOL medio en R: MFE medio de los trades donde SÍ llegó al DOL final
  // DOL medio en R: media del campo dolR real (registrado por el trader), no del MFE.
  // El MFE sobreestima porque el precio a veces pasa de largo del DOL.
  const dolTrades = trades.filter(t=>!isNaN(t.dolR)&&t.dolR!=null&&t.dolR>0);
  const avgDol = dolTrades.length? dolTrades.reduce((s,t)=>s+t.dolR,0)/dolTrades.length : null;
  return { enough:true, n:withMfe.length, curve, best, avgDol, dolN:dolTrades.length };
}


// COSTE DE LA INDISCIPLINA — métrica estrella
// Diferencia entre lo planificado y lo realizado en trades marcados con error.
// Si cerraste antes de tiempo un ganador, o entraste por FOMO, etc.
function disciplineCost(trades){
  let lostR = 0, lost$ = 0, flaggedCount = 0, cleanCount = 0;
  trades.forEach(t=>{
    const hasError = (t.flags||[]).some(f=>f!=='clean');
    if(hasError){
      flaggedCount++;
      // R perdido = lo que el plan habria dado menos lo realizado (solo si el plan era mejor)
      const diff = (t.plannedR||0) - (t.realizedR||0);
      if(diff>0){
        lostR += diff;
        lost$ += diff * (t.riskUSD||0);
      }
    } else { cleanCount++; }
  });
  return { lostR, lost$, flaggedCount, cleanCount, total: trades.length };
}

// Tasa de disciplina (% trades sin errores)
function disciplineRate(trades){
  if(!trades.length) return 100;
  const clean = trades.filter(t=> !(t.flags||[]).some(f=>f!=='clean')).length;
  return clean/trades.length*100;
}

// Racha actual de días limpios (sin ningún trade con error)
function cleanDayStreak(trades){
  const byDay = {};
  trades.forEach(t=>{
    byDay[t.date] = byDay[t.date]||[];
    byDay[t.date].push(t);
  });
  const days = Object.keys(byDay).sort().reverse();
  let streak=0;
  for(const d of days){
    const dirty = byDay[d].some(t=>(t.flags||[]).some(f=>f!=='clean'));
    if(dirty) break;
    streak++;
  }
  return streak;
}

// Breakdown por dimensión (setup, session, symbol, weekday)
function breakdown(trades, key){
  const map={};
  trades.forEach(t=>{
    let k = t[key];
    if(key==='weekday') k = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][new Date(t.date).getDay()];
    k = k||'—';
    map[k]=map[k]||[];
    map[k].push(t);
  });
  return Object.entries(map).map(([k,ts])=>({
    key:k, n:ts.length, r:totalR(ts), exp:expectancy(ts), wr:winrate(ts), pnl:totalPnl(ts)
  })).sort((a,b)=>b.r-a.r);
}

// Equity curve (R acumulado en orden cronológico)
function equityCurve(trades){
  const ch = [...trades].sort((a,b)=> a.date<b.date?-1: a.date>b.date?1:0);
  let cum=0; const pts=[];
  ch.forEach(t=>{ cum+=(t.realizedR||0); pts.push({date:t.date, cum}); });
  return pts;
}

// Max drawdown sobre la curva de equity en R
function maxDrawdownR(trades){
  const curve = equityCurve(trades).map(p=>p.cum);
  let peak=0, maxDD=0;
  curve.forEach(v=>{ peak=Math.max(peak,v); maxDD=Math.max(maxDD, peak-v); });
  return maxDD;
}

/* ---------- Kelly / sizing ---------- */
// Kelly fraction usando winrate y ratio ganancia/perdida
function kellyFraction(trades){
  const wr = winrate(trades)/100;
  const aw = avgWin(trades);
  const al = Math.abs(avgLoss(trades));
  if(!al || !aw) return 0;
  const b = aw/al; // payoff ratio
  const k = wr - (1-wr)/b;
  return k; // puede ser negativo si no hay edge
}
/* ============================================================
   VISTAS / RENDER
   ============================================================ */

let CURRENT_TAB = 'overview';
let charts = {};

function destroyCharts(){ Object.values(charts).forEach(c=>{try{c.destroy()}catch(e){}}); charts={}; }

function render(){
  destroyCharts();
  const v = $('#view');
  const T = tradesFiltered();
  // pestañas donde el filtro eval/funded tiene sentido
  const metricTabs=['overview','discipline','performance'];
  const showFilter = metricTabs.includes(CURRENT_TAB);
  const hasNoTrade=(DB.noTradeDays||[]).length>0;
  if(CURRENT_TAB!=='roi' && !T.length && !(CURRENT_TAB==='calendar'&&hasNoTrade)){
    v.innerHTML = (showFilter?phaseFilterBar():'') + emptyState();
    return;
  }
  ({
    overview:renderOverview,
    discipline:renderDiscipline,
    performance:renderPerformance,
    roi:renderROI,
    calendar:renderCalendar,
    journal:renderJournal
  })[CURRENT_TAB](v, T);
  // prepend filter bar en pestañas de métricas
  if(showFilter){
    v.insertAdjacentHTML('afterbegin', phaseFilterBar());
  }
}

function phaseFilterBar(){
  const opts=[['all','Todo'],['eval','Eval'],['funded','Funded']];
  // contar trades por fase para mostrar
  const counts={all:DB.trades.length, eval:0, funded:0};
  DB.trades.forEach(t=>{ const p=tradePhase(t); if(p)counts[p]++; });
  return `<div class="phase-filter">
    ${opts.map(([k,label])=>`<button class="phase-btn ${PHASE_FILTER===k?'active':''}" onclick="setPhaseFilter('${k}')">${label} <span class="pf-count">${counts[k]}</span></button>`).join('')}
  </div>`;
}
function setPhaseFilter(p){ PHASE_FILTER=p; render(); }

function emptyState(){
  return `<div class="empty">
    <div class="ico">◴</div>
    <p style="font-size:15px;color:var(--ink-dim);margin-bottom:6px">Aún no hay trades registrados</p>
    <p class="hint" style="max-width:340px;margin:0 auto 18px">Empieza añadiendo tu primer trade. Registra el R planificado y el realizado para activar el coste de la indisciplina.</p>
    <button class="btn primary" onclick="openTradeModal()">+ Añadir primer trade</button>
  </div>`;
}

/* ---------- gauge SVG ---------- */
function gauge(pct, label, color){
  const r=64, c=2*Math.PI*r, off=c-(pct/100)*c;
  return `<div class="gauge">
    <svg width="150" height="150" viewBox="0 0 150 150">
      <circle cx="75" cy="75" r="${r}" fill="none" stroke="var(--line)" stroke-width="11"/>
      <circle cx="75" cy="75" r="${r}" fill="none" stroke="${color}" stroke-width="11"
        stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}"/>
    </svg>
    <div class="center"><div><div class="big" style="color:${color}">${Math.round(pct)}<span style="font-size:16px">%</span></div><div class="cap">${label}</div></div></div>
  </div>`;
}

function statCard(label,val,delta,deltaCls){
  return `<div class="card stat">
    <div class="label">${label}</div>
    <div class="val">${val}</div>
    ${delta?`<div class="delta ${deltaCls||''}">${delta}</div>`:''}
  </div>`;
}

/* ============================================================
   OVERVIEW
   ============================================================ */
function renderOverview(v, T){
  const exp = expectancy(T);
  const wr = winrate(T);
  const pf = profitFactor(T);
  const tR = totalR(T);
  const tP = totalPnl(T);
  const dc = disciplineCost(T);
  const dr = disciplineRate(T);
  const ddR = maxDrawdownR(T);

  v.innerHTML = `
    <div class="grid g-4" style="margin-bottom:14px">
      ${statCard('Expectancy', fmtR(exp), exp>=0?'edge positivo':'sin edge', cls(exp))}
      ${statCard('Win rate', fmt(wr,1)+'%', `PF ${pf===Infinity?'∞':fmt(pf,2)}`, 'neu')}
      ${statCard('R acumulado', fmtR(tR), fmt$(tP), cls(tR))}
      ${statCard('Max DD', '-'+fmt(ddR,2)+'R', `${T.length} trades`, 'neu')}
    </div>

    <div class="card disc-card" style="margin-bottom:14px">
      <h3>Coste de la indisciplina ${helpIcon("disccost")} <span style="color:var(--ink-faint);text-transform:none;font-weight:400">tu métrica nº1</span></h3>
      <div class="disc-wrap">
        ${gauge(dr, 'disciplina', dr>=80?'var(--green)':dr>=60?'var(--amber)':'var(--red)')}
        <div class="disc-detail">
          <div class="row"><span class="k">R perdido por errores</span><span class="v neg">-${fmt(dc.lostR,2)}R</span></div>
          <div class="row"><span class="k">En dinero</span><span class="v neg">${fmt$(-dc.lost$)}</span></div>
          <div class="row"><span class="k">Trades con error</span><span class="v">${dc.flaggedCount} / ${dc.total}</span></div>
          <div class="row"><span class="k">Racha días limpios</span><span class="v pos">${cleanDayStreak(T)} 🔥</span></div>
        </div>
      </div>
      ${dc.lostR>0?`<div class="insight bad" style="margin-top:16px">Siguiendo tu plan al pie de la letra habrías sumado <b>${fmt(dc.lostR,2)}R más</b> (${fmt$(dc.lost$)}). Eso es ${exp>0?Math.round(dc.lostR/exp):'—'} trades ganadores tirados por errores de ejecución.</div>`:`<div class="insight" style="margin-top:16px">Sin coste de indisciplina detectado en este periodo. Mantén el registro honesto de los flags para que la métrica siga siendo útil.</div>`}
    </div>

    <div class="grid g-2">
      <div class="card">
        <h3>Curva de equity (R) ${helpIcon("equity")}</h3>
        <div style="position:relative;height:220px"><canvas id="equityChart"></canvas></div>
      </div>
      <div class="card">
        <h3>Winrate y expectancy acumulados ${helpIcon("cumchart")}</h3>
        <div style="position:relative;height:220px"><canvas id="cumChart"></canvas></div>
        <div class="legend"><span><span class="dot" style="background:var(--blue)"></span>Winrate %</span><span><span class="dot" style="background:var(--green)"></span>Expectancy (R)</span></div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>Rendimiento por setup</h3>
      ${breakdownTable(breakdown(T,'setup'))}
    </div>

    ${autoInsights(T)}
  `;
  drawEquity('equityChart', T);
  drawCumulative('cumChart', T);
}

function breakdownTable(rows){
  if(!rows.length) return `<p class="hint">Sin datos</p>`;
  return `<div class="table-wrap" style="border:none"><table style="min-width:auto">
    <thead><tr><th>Categoría</th><th>N</th><th>Exp</th><th>WR</th><th>R</th></tr></thead>
    <tbody>${rows.map(r=>`<tr>
      <td style="font-family:var(--sans);font-weight:600">${r.key}</td>
      <td>${r.n}</td>
      <td class="${cls(r.exp)}">${fmtR(r.exp)}</td>
      <td>${fmt(r.wr,0)}%</td>
      <td class="${cls(r.r)}">${fmtR(r.r)}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function autoInsights(T){
  const ins=[];
  // mejor y peor setup
  const bs = breakdown(T,'setup');
  if(bs.length>=2){
    const best=bs[0], worst=bs[bs.length-1];
    if(best.exp>0) ins.push({t:`Tu mejor setup es <b>${best.key}</b> con ${fmtR(best.exp)} de expectancy sobre ${best.n} trades.`,c:''});
    if(worst.exp<0) ins.push({t:`<b>${worst.key}</b> tiene expectancy negativa (${fmtR(worst.exp)}). Plantéate filtrar o suspender este setup.`,c:'bad'});
  }
  // sesión
  const sb = breakdown(T,'session');
  if(sb.length>=2){
    const bestS=sb[0];
    ins.push({t:`Operas mejor en sesión <b>${bestS.key}</b> (${fmtR(bestS.exp)} exp). Concentra ahí tu tamaño.`,c:''});
  }
  // flags más comunes
  const flagCount={};
  T.forEach(t=>(t.flags||[]).forEach(f=>{if(f!=='clean'){flagCount[f]=(flagCount[f]||0)+1}}));
  const topFlag = Object.entries(flagCount).sort((a,b)=>b[1]-a[1])[0];
  if(topFlag) ins.push({t:`Tu error más repetido: <b>${FLAG_LABELS[topFlag[0]]||topFlag[0]}</b> (${topFlag[1]} veces). Ponlo en tu checklist pre-sesión.`,c:'warn'});

  if(!ins.length) return '';
  return `<div style="margin-top:14px">${ins.map(i=>`<div class="insight ${i.c}">${i.t}</div>`).join('')}</div>`;
}

/* ============================================================
   DISCIPLINE
   ============================================================ */
function renderDiscipline(v, T){
  const dc = disciplineCost(T);
  const dr = disciplineRate(T);
  // por flag
  const flagStats={};
  Object.keys(FLAG_LABELS).forEach(f=>{ if(f!=='clean') flagStats[f]={n:0,lostR:0}; });
  T.forEach(t=>{
    (t.flags||[]).forEach(f=>{
      if(f!=='clean' && flagStats[f]){
        flagStats[f].n++;
        const diff=(t.plannedR||0)-(t.realizedR||0);
        if(diff>0) flagStats[f].lostR+=diff;
      }
    });
  });
  const flagRows=Object.entries(flagStats).filter(([k,s])=>s.n>0).sort((a,b)=>b[1].lostR-a[1].lostR);

  // disciplina vs resultado: ¿los trades limpios rinden mejor?
  const clean=T.filter(t=>!(t.flags||[]).some(f=>f!=='clean'));
  const dirty=T.filter(t=>(t.flags||[]).some(f=>f!=='clean'));

  v.innerHTML=`
    <div class="section-title">Disciplina & errores</div>
    <div class="grid g-3" style="margin-bottom:14px">
      ${statCard('Tasa de disciplina', fmt(dr,1)+'%', `${dc.cleanCount} trades limpios`, dr>=80?'pos':'neg')}
      ${statCard('Coste total errores', '-'+fmt(dc.lostR,2)+'R', fmt$(-dc.lost$), 'neg')}
      ${statCard('Racha días limpios', cleanDayStreak(T)+' días', 'sin errores', 'pos')}
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3>¿Tu edge sobrevive a los errores? ${helpIcon("edgeclean")}</h3>
      <div class="grid g-2">
        <div class="calc-out">
          <div class="label" style="color:var(--green);font-size:11px;font-weight:600;margin-bottom:6px">TRADES LIMPIOS (${clean.length})</div>
          <div class="big pos">${fmtR(expectancy(clean))}</div>
          <div class="hint" style="margin-top:6px">WR ${fmt(winrate(clean),0)}% · PF ${fmt(profitFactor(clean),2)}</div>
        </div>
        <div class="calc-out">
          <div class="label" style="color:var(--red);font-size:11px;font-weight:600;margin-bottom:6px">TRADES CON ERROR (${dirty.length})</div>
          <div class="big neg">${fmtR(expectancy(dirty))}</div>
          <div class="hint" style="margin-top:6px">WR ${fmt(winrate(dirty),0)}% · PF ${fmt(profitFactor(dirty),2)}</div>
        </div>
      </div>
      ${clean.length&&dirty.length?`<div class="insight warn" style="margin-top:14px">La diferencia de expectancy entre operar limpio y operar con errores es de <b>${fmtR(expectancy(clean)-expectancy(dirty))}</b> por trade. Multiplícalo por tu volumen mensual para ver el coste real anual.</div>`:''}
    </div>

    <div class="card">
      <h3>Desglose por tipo de error ${helpIcon("flagbreakdown")}</h3>
      ${flagRows.length?`<div class="table-wrap" style="border:none"><table style="min-width:auto">
        <thead><tr><th>Error</th><th>Veces</th><th>R perdido</th><th>% de tus trades</th></tr></thead>
        <tbody>${flagRows.map(([k,s])=>`<tr>
          <td style="font-family:var(--sans);font-weight:600">${FLAG_LABELS[k]}</td>
          <td>${s.n}</td>
          <td class="neg">-${fmt(s.lostR,2)}R</td>
          <td>${fmt(s.n/T.length*100,0)}%</td>
        </tr>`).join('')}</tbody></table></div>`:`<p class="hint">Ningún error registrado. 🎯</p>`}
    </div>

    ${(()=>{
      const withPlan=T.filter(t=>t.planChecked!=null);
      if(withPlan.length<3) return '';
      const full=withPlan.filter(t=>(t.planChecked||[]).length===PLAN_CHECKLIST.length);
      const partial=withPlan.filter(t=>(t.planChecked||[]).length<PLAN_CHECKLIST.length);
      if(!full.length||!partial.length) return '';
      const diff=expectancy(full)-expectancy(partial);
      return `<div class="card" style="margin-top:14px">
        <h3>Adherencia al plan ${helpIcon("planadher")}</h3>
        <div class="grid g-2">
          <div class="calc-out">
            <div class="label" style="color:var(--green);font-size:11px;font-weight:600;margin-bottom:6px">PLAN COMPLETO (${full.length})</div>
            <div class="big pos">${fmtR(expectancy(full))}</div>
            <div class="hint" style="margin-top:6px">WR ${fmt(winrate(full),0)}%</div>
          </div>
          <div class="calc-out">
            <div class="label" style="color:var(--amber);font-size:11px;font-weight:600;margin-bottom:6px">PLAN INCOMPLETO (${partial.length})</div>
            <div class="big ${cls(expectancy(partial))}">${fmtR(expectancy(partial))}</div>
            <div class="hint" style="margin-top:6px">WR ${fmt(winrate(partial),0)}%</div>
          </div>
        </div>
        ${diff>0?`<div class="insight warn" style="margin-top:14px">Cuando cumples todas las reglas de tu plan ganas <b>${fmtR(diff)} más</b> por trade que cuando te saltas alguna. Tu plan funciona — respétalo.</div>`:`<div class="insight" style="margin-top:14px">Aún no hay diferencia clara entre cumplir todo el plan o no. Sigue registrando para que el dato sea fiable.</div>`}
      </div>`;
    })()}
  `;
}

/* ============================================================
   PERFORMANCE
   ============================================================ */
function renderPerformance(v, T){
  v.innerHTML=`
    <div class="section-title">Rendimiento</div>
    <div class="grid g-4" style="margin-bottom:14px">
      ${statCard('Expectancy', fmtR(expectancy(T)),'por trade',cls(expectancy(T)))}
      ${statCard('Avg win', fmtR(avgWin(T)),'',('pos'))}
      ${statCard('Avg loss', fmtR(avgLoss(T)),'',('neg'))}
      ${statCard('Profit factor', profitFactor(T)===Infinity?'∞':fmt(profitFactor(T),2),'',cls(profitFactor(T)-1))}
    </div>
    <div class="grid g-2" style="margin-bottom:14px">
      <div class="card"><h3>Por sesión</h3>${breakdownTable(breakdown(T,'session'))}</div>
      <div class="card"><h3>Por símbolo</h3>${breakdownTable(breakdown(T,'symbol'))}</div>
    </div>
    <div class="card" style="margin-bottom:14px">
      <h3>Por setup</h3>${breakdownTable(breakdown(T,'setup'))}
    </div>
    <div class="card" style="margin-bottom:14px">
      <h3>¿Dónde empieza el movimiento? (estructura CRT) ${helpIcon("movetype")}</h3>
      ${(()=>{
        const withMove=T.filter(t=>t.moveType);
        if(withMove.length<3) return `<p class="hint">Marca "¿Dónde empezó el movimiento?" en tus trades. Con 3+ te muestro si te va mejor con el impulso de apertura o con el PO3 de la vela de 4h.</p>`;
        const groups={};
        withMove.forEach(t=>{ (groups[t.moveType]=groups[t.moveType]||[]).push(t); });
        const rows=Object.keys(groups).map(k=>{
          const ts=groups[k];
          return { key:k, label:MOVE_TYPES[k]||k, n:ts.length, exp:expectancy(ts), wr:winrate(ts), r:ts.reduce((s,t)=>s+(t.realizedR||0),0) };
        }).sort((a,b)=>b.exp-a.exp);
        const best=rows[0];
        return `
        <div class="table-wrap" style="border:none"><table>
          <thead><tr><th>Origen</th><th>N</th><th>Exp</th><th>WR</th><th>R acum</th></tr></thead>
          <tbody>${rows.map(r=>`<tr>
            <td style="font-family:var(--sans);font-weight:600">${r.label}</td>
            <td>${r.n}</td>
            <td class="${cls(r.exp)}">${fmtR(r.exp)}</td>
            <td>${fmt(r.wr,0)}%</td>
            <td class="${cls(r.r)}">${fmtR(r.r)}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        ${rows.length>=2?`<div class="insight" style="margin-top:12px">Tu mejor estructura es <b>${best.label}</b> (${fmtR(best.exp)} de expectancy sobre ${best.n} trades). Si la diferencia es grande y tienes datos suficientes, prioriza operar esa estructura y sé más selectivo con las otras.</div>`:`<div class="insight" style="margin-top:12px">Solo tienes datos de una estructura por ahora. Registra más para poder comparar.</div>`}
        `;
      })()}
    </div>
    <div class="card" style="margin-bottom:14px">
      <h3>RS Scalp — entradas por SMT ${helpIcon("smt")}</h3>
      ${(()=>{
        const smt=T.filter(t=>t.smt==='yes' && t.smtResult);
        if(smt.length<3) return `<p class="hint">Marca "¿Hubo entrada por SMT?" en tus trades. Con 3+ te muestro cómo funciona esta subestrategia: cuántas van a TP y si el timing respecto a la apertura influye.</p>`;
        const tp=smt.filter(t=>t.smtResult==='tp').length;
        const sl=smt.filter(t=>t.smtResult==='sl').length;
        const be=smt.filter(t=>t.smtResult==='be').length;
        const wr=smt.length?tp/smt.length*100:0;
        // por timing
        const TIMING={before:'Antes apertura (<9:30)',open:'En apertura (9:30-10)',after:'Después (>10:00)'};
        const byTiming=Object.keys(TIMING).map(k=>{
          const ts=smt.filter(t=>t.smtTiming===k);
          const t_tp=ts.filter(t=>t.smtResult==='tp').length;
          return { key:k, label:TIMING[k], n:ts.length, tp:t_tp, wr:ts.length?t_tp/ts.length*100:0 };
        }).filter(r=>r.n>0).sort((a,b)=>b.wr-a.wr);
        return `
        <div class="grid g-4" style="gap:10px">
          <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">TOTAL SMT</div><div class="big">${smt.length}</div></div>
          <div class="calc-out" style="border-color:var(--green-dim)"><div class="label" style="font-size:10px;color:var(--green);font-weight:600">% A TP</div><div class="big ${wr>=50?'pos':'neg'}">${fmt(wr,0)}%</div><div class="hint" style="margin-top:4px">${tp}/${smt.length}</div></div>
          <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">A SL</div><div class="big neg">${sl}</div></div>
          <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">BE</div><div class="big">${be}</div></div>
        </div>
        ${byTiming.length?`
        <div class="table-wrap" style="border:none;margin-top:14px"><table style="min-width:auto">
          <thead><tr><th>Timing</th><th>N</th><th>A TP</th><th>% acierto</th></tr></thead>
          <tbody>${byTiming.map(r=>`<tr>
            <td style="font-family:var(--sans);font-weight:600">${r.label}</td>
            <td>${r.n}</td>
            <td>${r.tp}</td>
            <td class="${r.wr>=50?'pos':'neg'}">${fmt(r.wr,0)}%</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <div class="insight ${wr>=50?'':'warn'}" style="margin-top:12px">
          Los SMT van a TP el <b>${fmt(wr,0)}%</b> de las veces (${smt.length} señales). ${byTiming.length>=2?`Tu mejor timing es <b>${byTiming[0].label}</b> (${fmt(byTiming[0].wr,0)}% acierto). ${byTiming[0].wr-byTiming[byTiming.length-1].wr>=25?'La diferencia entre timings es notable — prioriza el mejor.':'Los timings rinden parecido de momento.'}`:''}
          ${smt.length<15?' ⚠ Aún pocos datos: no saques conclusiones firmes hasta 15-20 señales.':''}
        </div>`:''}
        `;
      })()}
    </div>
    <div class="card" style="margin-bottom:14px">
      <h3>Tu R:R óptimo (según MFE) ${helpIcon("optimalrr")}</h3>
      ${(()=>{
        const o=optimalRR(T);
        if(!o.enough) return `<p class="hint">Necesitas al menos 5 trades con MFE registrado para calcular tu R:R óptimo. Llevas ${o.n}. El MFE (R máximo alcanzado) es lo que permite simular cada nivel de TP.</p>`;
        return `
        <div class="grid g-2" style="gap:10px;margin-bottom:14px">
          <div class="calc-out" style="border-color:var(--green-dim)">
            <div class="label" style="font-size:11px;color:var(--green);font-weight:600;margin-bottom:6px">R:R ÓPTIMO 👑</div>
            <div class="big pos">1:${fmt(o.best.tp,1).replace('.0','')}</div>
            <div class="hint" style="margin-top:6px">Exp ${fmtR(o.best.exp)} · alcanzado ${fmt(o.best.wr,0)}% de las veces</div>
          </div>
          <div class="calc-out">
            <div class="label" style="font-size:11px;color:var(--ink-dim);font-weight:600;margin-bottom:6px">TU DOL MEDIO</div>
            <div class="big" style="color:var(--blue)">${o.avgDol!=null?'1:'+fmt(o.avgDol,1).replace('.0',''):'—'}</div>
            <div class="hint" style="margin-top:6px">${o.avgDol!=null?'media real de tu DOL ('+o.dolN+' trades)':'registra "DOL en R" en tus trades'}</div>
          </div>
        </div>
        <div style="position:relative;height:220px"><canvas id="rrChart"></canvas></div>
        <div class="legend"><span><span class="dot" style="background:var(--green)"></span>Expectancy por R:R</span>${o.avgDol!=null?'<span><span class="dot" style="background:var(--blue)"></span>Tu DOL medio</span>':''}</div>
        ${(()=>{
          if(o.avgDol==null) return `<div class="insight" style="margin-top:12px">Registra "DOL en R" en tus trades (a cuántos R está tu DOL) para ver si tu R:R óptimo cae antes, en, o después de tu DOL.</div>`;
          const diff=o.best.tp-o.avgDol;
          if(Math.abs(diff)<=0.25) return `<div class="insight" style="margin-top:12px">Tu R:R óptimo (1:${fmt(o.best.tp,1).replace('.0','')}) coincide casi con tu DOL medio (1:${fmt(o.avgDol,1).replace('.0','')}). <b>Tu estructura es correcta</b>: el DOL es exactamente donde más rentabilidad sacas.</div>`;
          if(diff<0) return `<div class="insight warn" style="margin-top:12px">Tu R:R óptimo (1:${fmt(o.best.tp,1).replace('.0','')}) cae <b>antes</b> de tu DOL medio (1:${fmt(o.avgDol,1).replace('.0','')}). El precio no siempre llega al DOL, así que cerrar un poco antes te daría más rentabilidad a la larga. Plantéate asegurar antes del DOL.</div>`;
          return `<div class="insight" style="margin-top:12px">Tu R:R óptimo (1:${fmt(o.best.tp,1).replace('.0','')}) cae <b>más allá</b> de tu DOL medio (1:${fmt(o.avgDol,1).replace('.0','')}). Cuando el precio pasa del DOL suele seguir bastante — pero ojo, quizá son pocos casos. Míralo con cuidado.</div>`;
        })()}
        <div class="hint" style="margin-top:8px">Basado en ${o.n} trades con MFE. Asume tu SL fijo de -1R. Un TP solo cuenta como alcanzado si tu MFE llegó a ese nivel.</div>
        `;
      })()}
    </div>
    <div class="card" style="margin-bottom:14px">
      <h3>Análisis de cierres manuales ${helpIcon("manualclose")}</h3>
      ${(()=>{
        const manual=T.filter(t=>t.exitType==='manual');
        if(manual.length<2) return `<p class="hint">Llevas ${manual.length} cierre(s) manual(es). Con 2 o más te muestro el análisis. Marca el flag correspondiente (miedo, FOMO...) si el cierre no siguió tu plan, y registra el MFE.</p>`;

        const manualWins=manual.filter(t=>t.result==='win');
        const withMfe=manualWins.filter(t=>!isNaN(t.mfe)&&t.mfe!=null);

        // El FLAG manda: tú decides si el cierre fue limpio o un error.
        // clean = seguiste tu plan (decisión buena, la respetamos)
        // dirty = marcaste algún error (miedo, FOMO...) -> ahí sí analizamos el coste
        let cleanCount=0, cleanReachedTP=0;   // limpios (info neutra)
        let errCount=0, errCostR=0, errReachedTP=0;  // con error marcado
        withMfe.forEach(t=>{
          const hasError=(t.flags||[]).some(f=>f!=='clean');
          const reachedTP = t.mfe >= (t.plannedR||0);
          const leftR = Math.max(0,(t.plannedR||0)-(t.realizedR||0));
          if(hasError){
            errCount++;
            if(reachedTP){ errReachedTP++; errCostR+=leftR; }
          } else {
            cleanCount++;
            if(reachedTP) cleanReachedTP++;
          }
        });
        const risk=manual[0].riskUSD||200;

        return `
        <div class="grid g-3" style="gap:10px">
          <div class="calc-out" style="border-color:var(--green-dim)"><div class="label" style="font-size:10px;color:var(--green);font-weight:600">CIERRES LIMPIOS</div><div class="big pos">${cleanCount}</div><div class="hint" style="margin-top:4px">seguiste tu plan</div></div>
          <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">CON ERROR MARCADO</div><div class="big ${errCount?'neg':''}">${errCount}</div><div class="hint" style="margin-top:4px">miedo, FOMO...</div></div>
          <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">R PERDIDO (errores)</div><div class="big ${errCostR>0?'neg':''}">${errCostR>0?'-'+fmt(errCostR,1)+'R':'—'}</div><div class="hint" style="margin-top:4px">${errCostR>0?fmt$(errCostR*risk):'ninguno'}</div></div>
        </div>
        ${!withMfe.length?`<div class="insight" style="margin-top:14px">Registra el <b>MFE</b> en tus cierres manuales para el análisis completo.</div>`:`
          ${cleanCount?`<div class="insight" style="margin-top:14px"><b>${cleanCount} cierre(s) limpio(s).</b> Seguiste tu plan, así que fueron buenas decisiones — el resultado no cambia eso.${cleanReachedTP?` Como dato neutro: en ${cleanReachedTP} de ellos el precio siguió hasta tu TP. No es un error (decidiste bien), pero si ves un patrón, quizá tu plan de salida se pueda afinar.`:` En ninguno el precio siguió hasta tu TP: cerraste justo a tiempo.`}</div>`:''}
          ${errCount?`<div class="insight ${errReachedTP?'bad':'warn'}" style="margin-top:10px"><b>${errCount} cierre(s) con error marcado.</b> ${errReachedTP?`En ${errReachedTP} el precio llegó a tu TP: te costaron ${fmt(errCostR,1)}R (${fmt$(errCostR*risk)}) por no seguir el plan.`:`El precio no llegó al TP, pero tú marcaste que la decisión no fue limpia — trabájalo igual, el resultado fue suerte.`}</div>`:`<div class="insight" style="margin-top:10px">Ningún cierre manual marcado como error. Todos siguieron tu plan. 🎯</div>`}
        `}
        `;
      })()}
    </div>
    <div class="card" style="margin-bottom:14px">
      <h3>¿Está tu SL demasiado lejos? (MAE) ${helpIcon("maeanalysis")}</h3>
      ${(()=>{
        const withMae=T.filter(t=>!isNaN(t.mae)&&t.mae!=null);
        if(withMae.length<5) return `<p class="hint">Registra el MAE (R máximo en contra) en tus trades. Con 5+ te muestro si tu SL está demasiado lejos. Fiable de verdad a partir de 20-30 trades.</p>`;
        const wins=withMae.filter(t=>t.result==='win');
        const losses=withMae.filter(t=>t.result==='loss');
        const avg=arr=>arr.length?arr.reduce((s,t)=>s+t.mae,0)/arr.length:0;
        const max=arr=>arr.length?Math.max(...arr.map(t=>t.mae)):0;
        const avgWinMae=avg(wins), maxWinMae=max(wins);
        const avgLossMae=avg(losses);
        // percentil 90 del MAE de ganadores: el stop que respetaría el 90% de tus ganadores
        const winMaes=wins.map(t=>t.mae).sort((a,b)=>a-b);
        const p90=winMaes.length?winMaes[Math.min(winMaes.length-1,Math.floor(winMaes.length*0.9))]:0;
        return `
        <div class="grid g-3" style="gap:10px">
          <div class="calc-out" style="border-color:var(--green-dim)"><div class="label" style="font-size:10px;color:var(--green);font-weight:600">MAE MEDIO GANADORES</div><div class="big pos">${fmt(avgWinMae,2)}R</div><div class="hint" style="margin-top:4px">cuánto sufren antes de ganar</div></div>
          <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">PEOR MAE GANADOR</div><div class="big">${fmt(maxWinMae,2)}R</div><div class="hint" style="margin-top:4px">el que más aguantó</div></div>
          <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">MAE MEDIO PERDEDORES</div><div class="big neg">${fmt(avgLossMae,2)}R</div><div class="hint" style="margin-top:4px">${losses.length} SL</div></div>
        </div>
        <div class="insight ${p90<0.7?'warn':''}" style="margin-top:14px">
          El <b>90% de tus ganadores</b> no fue más allá de <b>${fmt(p90,2)}R en contra</b> antes de girarse.
          ${p90<0.7
            ? ` Tu SL a 1R está probablemente <b>demasiado lejos</b>: podrías ajustarlo a ~${fmt(Math.min(1,p90+0.15),1)}R y arriesgar menos sin perder casi ganadores. Eso mejoraría tu R:R en cada trade.`
            : ` Tu SL parece bien ajustado — tus ganadores usan buena parte del margen antes de girarse, así que recortarlo te sacaría de trades buenos.`}
        </div>
        <div class="insight" style="margin-top:10px"><b>Ojo con las manipulaciones:</b> ${maxWinMae>=0.85
          ? `tu peor ganador aguantó ${fmt(maxWinMae,2)}R en contra. Si ajustas el SL por debajo de eso, te comerías ese tipo de barridos de liquidez. No bajes del ${fmt(maxWinMae,1)}R sin pensarlo.`
          : `ninguno de tus ganadores necesitó más de ${fmt(maxWinMae,2)}R de margen, así que tienes espacio para ajustar sin comerte manipulaciones grandes.`}</div>
        <div class="hint" style="margin-top:8px">Basado en ${withMae.length} trades con MAE (${wins.length} ganadores, ${losses.length} perdedores). ${withMae.length<20?'⚠ Pocos datos: no saques conclusiones firmes hasta tener 20-30 trades.':''}</div>
        `;
      })()}
    </div>
    <div class="card" style="margin-bottom:14px">
      <h3>Análisis de break-even (BE) ${helpIcon("beanalysis")}</h3>
      ${(()=>{
        const be=T.filter(t=>t.exitType==='be_moved');
        if(!be.length) return `<p class="hint">Aún no tienes salidas marcadas como "Movió BE y saltó". Cuando las registres (con su MFE), te muestro si mueves el BE bien o por impulso, y cuántos habrían ido a TP.</p>`;
        // bien puesto = sin flags de impulso (siguió el plan: BE solo tras primer objetivo)
        // mal puesto = con moved_stop o early_close (lo movió por miedo/fuera de plan)
        const badFlags=t=>(t.flags||[]).some(f=>f==='moved_stop'||f==='early_close'||f==='fomo');
        const wellPlaced=be.filter(t=>!badFlags(t));
        const impulsive=be.filter(t=>badFlags(t));
        // de los BE, cuántos habrían ido a TP (MFE >= plannedR)
        const withMfe=be.filter(t=>!isNaN(t.mfe)&&t.mfe!=null);
        const wouldveTP=withMfe.filter(t=>t.mfe>=(t.plannedR||0));
        const lostR=wouldveTP.reduce((s,t)=>s+(t.plannedR||0),0);
        // cruce: de los que habrían ido a TP, cuántos por impulso vs por plan
        const tpByImpulse=wouldveTP.filter(t=>badFlags(t)).length;
        const tpByPlan=wouldveTP.filter(t=>!badFlags(t)).length;
        const risk=be[0].riskUSD||200;
        return `
        <div class="grid g-4" style="gap:10px">
          <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">TOTAL BE</div><div class="big">${be.length}</div></div>
          <div class="calc-out" style="border-color:var(--green-dim)"><div class="label" style="font-size:10px;color:var(--green);font-weight:600">BIEN PUESTOS</div><div class="big pos">${wellPlaced.length}</div><div class="hint" style="margin-top:4px">según plan</div></div>
          <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">POR IMPULSO</div><div class="big ${impulsive.length?'neg':''}">${impulsive.length}</div><div class="hint" style="margin-top:4px">miedo / fuera de plan</div></div>
          <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">HABRÍAN IDO A TP</div><div class="big ${wouldveTP.length?'neg':''}">${wouldveTP.length}</div><div class="hint" style="margin-top:4px">${withMfe.length?'de '+withMfe.length+' con MFE':'registra MFE'}</div></div>
        </div>
        ${impulsive.length?`<div class="insight warn" style="margin-top:14px"><b>${impulsive.length} de ${be.length} BE los moviste por impulso</b> (miedo o fuera de plan). Tu regla dice poner BE solo al llegar al primer objetivo — revisa si te estás adelantando.</div>`:`<div class="insight" style="margin-top:14px">Todos tus BE los pusiste siguiendo el plan. 🎯</div>`}
        ${wouldveTP.length?`<div class="insight bad" style="margin-top:10px"><b>${wouldveTP.length} BE que habrían ido a TP.</b> El precio te sacó en 0R y luego llegó a tu objetivo: dejaste de ganar ${fmt(lostR,1)}R (${fmt$(lostR*risk)}).</div>
        <div class="insight ${tpByImpulse>tpByPlan?'bad':'warn'}" style="margin-top:10px"><b>El cruce clave:</b> de esos ${wouldveTP.length} ganadores perdidos, <b>${tpByImpulse} fueron por impulso</b> (miedo) y <b>${tpByPlan} por plan</b>. ${tpByImpulse>tpByPlan
          ? 'La mayoría los perdiste por mover el BE con miedo, no por estrategia. Es un problema de DISCIPLINA: si aguantas tu plan, recuperas esos ganadores.'
          : tpByPlan>tpByImpulse
          ? 'La mayoría los perdiste siguiendo tu plan. No es miedo — es tu REGLA de BE la que es demasiado ajustada. Plantéate mover el BE más tarde o a un nivel con más margen.'
          : 'Están repartidos entre impulso y plan. Ataca las dos cosas: más disciplina para no adelantarte, y revisa si tu nivel de BE es muy ajustado.'}</div>`:withMfe.length?`<div class="insight" style="margin-top:10px">Ninguno de tus BE habría llegado a TP. Moviste bien: el precio no iba a seguir. 👍</div>`:''}
        `;
      })()}
    </div>
    <div class="card" style="margin-bottom:14px">
      <h3>¿Llega el precio a tu DOL final? ${helpIcon("dolreach")}</h3>
      ${(()=>{
        // Els SL s'exclouen: un stop mai arriba al DOL, comptar-los distorsiona el %
        const withDol=T.filter(t=>(t.dolReached==='yes'||t.dolReached==='no') && t.result!=='loss');
        const withMfe=T.filter(t=>!isNaN(t.mfe)&&t.mfe!=null);
        if(withDol.length<3 && withMfe.length<3) return `<p class="hint">Registra "¿Llegó al DOL final?" y el R máximo (MFE) en tus trades. Con 3+ te muestro si el precio suele llegar a tu DOL o se queda en objetivos intermedios.</p>`;
        const reached=withDol.filter(t=>t.dolReached==='yes').length;
        const dolPct=withDol.length?reached/withDol.length*100:0;
        const avgMfe=withMfe.length?withMfe.reduce((s,t)=>s+t.mfe,0)/withMfe.length:0;
        // MFE medio cuando NO llegó al DOL: ¿dónde se suele quedar?
        const noReach=withMfe.filter(t=>t.dolReached==='no');
        const avgMfeNoReach=noReach.length?noReach.reduce((s,t)=>s+t.mfe,0)/noReach.length:0;
        return `
        <div class="grid g-3" style="gap:10px">
          <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">LLEGA AL DOL FINAL</div><div class="big ${dolPct>=50?'pos':'neg'}">${fmt(dolPct,0)}%</div><div class="hint" style="margin-top:4px">${reached}/${withDol.length} trades</div></div>
          <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">MFE MEDIO</div><div class="big">${fmt(avgMfe,1)}R</div><div class="hint" style="margin-top:4px">hasta dónde llega el precio</div></div>
          <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">SE QUEDA EN (si no llega)</div><div class="big">${noReach.length?fmt(avgMfeNoReach,1)+'R':'—'}</div><div class="hint" style="margin-top:4px">objetivo intermedio típico</div></div>
        </div>
        <div class="insight ${dolPct>=50?'':'warn'}" style="margin-top:14px">${dolPct>=50
          ? `De los trades que no acabaron en stop, el precio llega a tu DOL final el <b>${fmt(dolPct,0)}%</b> de las veces. Aguantar hasta el DOL te compensa — tu paciencia tiene premio.`
          : `De los trades que no acabaron en stop, el precio solo llega al DOL final el <b>${fmt(dolPct,0)}%</b> de las veces. ${noReach.length?`Cuando no llega, suele quedarse sobre ${fmt(avgMfeNoReach,1)}R.`:''} Plantéate asegurar parte en objetivos intermedios (altos de 1h/2h) en vez de esperar siempre al DOL.`}</div>
        <div class="hint" style="margin-top:8px">Basado en ${withDol.length} trades no perdedores con DOL registrado y ${withMfe.length} con MFE. Los SL se excluyen del % (nunca llegan al DOL), pero su MFE sí cuenta.</div>
        `;
      })()}
    </div>
    <div class="card">
      <h3>Cuántos trades caen en cada rango de R ${helpIcon("distribution")}</h3>
      <div style="position:relative;height:200px"><canvas id="distChart"></canvas></div>
    </div>

    <div class="grid g-2" style="margin-top:14px">
      <div class="card">
        <h3>Rachas ${helpIcon("streaks")}</h3>
        ${(()=>{
          const s=streaks(T);
          const curLabel = s.curType==='win'?`${s.curCount} victoria${s.curCount>1?'s':''} 🔥`:s.curType==='loss'?`${s.curCount} derrota${s.curCount>1?'s':''}`:'—';
          return `<div class="grid g-3" style="gap:10px">
            <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">RACHA ACTUAL</div><div class="big ${s.curType==='win'?'pos':s.curType==='loss'?'neg':''}">${curLabel}</div></div>
            <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">RÉCORD VICTORIAS</div><div class="big pos">${s.maxWin}</div></div>
            <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">RÉCORD DERROTAS</div><div class="big neg">${s.maxLoss}</div></div>
          </div>
          ${s.maxLoss>0?`<div class="insight" style="margin-top:14px">Tu peor racha histórica fueron <b>${s.maxLoss} derrotas seguidas</b>. Tenerlo presente ayuda: cuando encadenes pérdidas, sabrás que ya lo has superado antes sin que te hundiera.</div>`:''}`;
        })()}
      </div>
      <div class="card">
        <h3>Día de la semana + disciplina ${helpIcon("daydisc")}</h3>
        ${(()=>{
          const rows=dayDisciplineBreakdown(T);
          if(!rows.length) return '<p class="hint">Sin datos suficientes.</p>';
          const best=[...rows].sort((a,b)=>b.exp-a.exp)[0];
          const worst=[...rows].sort((a,b)=>a.exp-b.exp)[0];
          return `<div class="table-wrap" style="border:none"><table style="min-width:auto">
            <thead><tr><th>Día</th><th>N</th><th>Exp</th><th>WR</th><th>% error</th></tr></thead>
            <tbody>${rows.map(r=>`<tr>
              <td style="font-family:var(--sans);font-weight:600">${r.key}</td>
              <td>${r.n}</td>
              <td class="${cls(r.exp)}">${fmtR(r.exp)}</td>
              <td>${fmt(r.wr,0)}%</td>
              <td class="${r.errRate>30?'neg':r.errRate>0?'':'pos'}">${fmt(r.errRate,0)}%</td>
            </tr>`).join('')}</tbody>
          </table></div>
          ${rows.length>=2?`<div class="insight" style="margin-top:12px">Mejor día: <b>${best.key}</b> (${fmtR(best.exp)}). Peor: <b>${worst.key}</b> (${fmtR(worst.exp)}${worst.errRate>30?`, con ${fmt(worst.errRate,0)}% de trades con error`:''}). ${worst.errRate>30?'Si el peor día coincide con más errores, quizá el problema eres tú ese día, no el mercado.':''}</div>`:''}`;
        })()}
      </div>
    </div>
    <div class="card" style="margin-bottom:14px">
      <h3>Rendimiento por mes ${helpIcon("bymonth")}</h3>
      ${(()=>{
        const rows=monthBreakdown(T);
        if(!rows.length) return '<p class="hint">Sin datos suficientes.</p>';
        const best=[...rows].sort((a,b)=>b.exp-a.exp)[0];
        const worst=[...rows].sort((a,b)=>a.exp-b.exp)[0];
        return `<div class="table-wrap" style="border:none"><table style="min-width:auto">
          <thead><tr><th>Mes</th><th>N</th><th>Exp</th><th>WR</th><th>R acum</th><th>% error</th></tr></thead>
          <tbody>${rows.map(r=>`<tr>
            <td style="font-family:var(--sans);font-weight:600">${r.key}</td>
            <td>${r.n}</td>
            <td class="${cls(r.exp)}">${fmtR(r.exp)}</td>
            <td>${fmt(r.wr,0)}%</td>
            <td class="${cls(r.r)}">${fmtR(r.r)}</td>
            <td class="${r.errRate>30?'neg':r.errRate>0?'':'pos'}">${fmt(r.errRate,0)}%</td>
          </tr>`).join('')}</tbody>
        </table></div>
        ${rows.length>=2?`<div class="insight" style="margin-top:12px">Mejor mes: <b>${best.key}</b> (${fmtR(best.exp)} de expectancy). Peor: <b>${worst.key}</b> (${fmtR(worst.exp)}). Te ayuda a ver tu evolución y si vas mejorando con el tiempo.</div>`:''}`;
      })()}
    </div>
    ${kellyCard(T)}
  `;
  drawDistribution('distChart', T);
  drawRRCurve('rrChart', T);
}

/* ============================================================
   CAPITAL & SIZING
   ============================================================ */
function planOptionsHTML(selId){
  // genera <option> "Firma|Plan|Fase". En sizing solo mostramos cuentas de 50K.
  let opts='';
  Object.keys(DB.firms||{}).forEach(firm=>{
    Object.keys(DB.firms[firm].plans).forEach(plan=>{
      const p=DB.firms[firm].plans[plan];
      if((p.size||0)!==50000) return;   // solo 50K
      ['Evaluación','Funded'].forEach(phase=>{
        const val=`${firm}|${plan}|${phase}`;
        opts+=`<option value="${val}">${firm} ${plan} · ${phase}</option>`;
      });
    });
  });
  if(!opts) opts=`<option value="">— sin cuentas de 50K —</option>`;
  return opts;
}
function selectedSpec(selId){
  const val=$('#'+selId)?.value||'';
  const [firm,plan,phase]=val.split('|');
  return planSpec(firm,plan,phase);
}

// Kelly como termómetro de edge — se muestra en Rendimiento
function kellyCard(T){
  const k = kellyFraction(T);
  const halfK = k/2, quarterK = k/4;
  return `
    <div class="card" style="margin-bottom:14px">
      <h3>Validación de edge (Kelly) ${helpIcon("kelly")}</h3>
      <div class="grid g-3">
        ${statCard('Kelly completo', T.length>=30?fmt(k*100,1)+'%':'n/a', T.length>=30?'no usar directo':'necesitas 30+ trades','neu')}
        ${statCard('½ Kelly', T.length>=30?fmt(halfK*100,1)+'%':'n/a','~75% crecimiento','pos')}
        ${statCard('¼ Kelly', T.length>=30?fmt(quarterK*100,1)+'%':'n/a','mínima varianza','neu')}
      </div>
      <div class="insight" style="margin-top:14px">Kelly aquí es solo un termómetro de tu edge, no tu sizing. ${k>0?`Tu edge es positivo (Kelly ${fmt(k*100,1)}%), lo que valida arriesgar fijo por trade.`:`Kelly ≤ 0 o sin datos: aún no hay edge demostrado para subir tamaño.`}</div>
    </div>`;
}
/* ============================================================
   ACCOUNTS & PAYOUTS
   ============================================================ */
// Detecta cuentas que han llegado al target (eval) o tocado el MLL, y avisa para cambiar de estado.
// Solo avanza estados, respeta los marcados manualmente ('payout', 'perdida' no se tocan).
let _autoAsked=new Set(); // en memoria: no repreguntar en la misma sesión si el usuario dijo que no
function checkAccountAutoStatus(){
  const T=DB.trades;
  let changed=false;
  (DB.accounts||[]).forEach(a=>{
    const st=a.status||'en_curso';
    // no tocar cuentas ya en un estado final marcado por el usuario
    if(st==='payout'||st==='perdida') return;
    const spec=planSpec(a.firm,a.plan,a.phase)||{};
    const allAcctTrades=T.filter(t=>t.account===a.name);
    // Para cuentas funded, solo cuentan los trades de fase funded
    const aTrades = a.phase==='Funded'
      ? allAcctTrades.filter(t=>tradePhase(t)==='funded')
      : allAcctTrades;
    const realized=totalPnl(aTrades);
    const balance=(a.startBalance||0)+realized;
    const dd=spec.drawdown||0;
    const trailLock=spec.trailLock||0, lockedFloor=spec.lockedFloor||0;
    // Suelo trailing: sube con el pico de balance alcanzado, nunca baja.
    // Reconstruimos el pico acumulando los trades en orden.
    const startBal=a.startBalance||0;
    let running=startBal, peak=startBal;
    aTrades.slice().sort((x,y)=> x.date<y.date?-1:1).forEach(t=>{ running+=(t.pnl||0); if(running>peak) peak=running; });
    let floor;
    if(trailLock && peak>=trailLock) floor=lockedFloor;
    else floor=peak-dd;
    // 1) ¿Tocó el MLL? (cualquier cuenta viva) — el balance actual cae por debajo del suelo trailing
    if(dd && balance<=floor && !_autoAsked.has(a.id+':lost')){
      _autoAsked.add(a.id+':lost');
      if(confirm(`La cuenta "${a.name}" ha tocado su límite de pérdida (balance ${fmt$(balance)} ≤ suelo ${fmt$(floor)}).\n\n¿Marcarla como PERDIDA?`)){
        a.status='perdida'; changed=true;
      }
      return;
    }
    // 2) ¿Eval que llegó al target?
    const target=spec.profitTarget||0;
    if(a.phase==='Evaluación' && target && realized>=target && !_autoAsked.has(a.id+':funded')){
      _autoAsked.add(a.id+':funded');
      if(confirm(`La cuenta "${a.name}" ha alcanzado su profit target (${fmt$(realized)} ≥ ${fmt$(target)}).\n\n¿Pasarla a FONDEADA? Se actualizarán sus reglas (nuevo drawdown, sin target) y el balance arrancará limpio en el tamaño base de la cuenta.`)){
        a.phase='Funded';
        a.status='fondeada';
        // La cuenta funded arranca LIMPIA en su tamaño base. Los trades de la eval
        // no cuentan (eran simulados para pasar). El nuevo spec funded da el tamaño.
        const fundedSpec=planSpec(a.firm,a.plan,'Funded')||{};
        a.startBalance = fundedSpec.size || a.size || a.startBalance;
        changed=true;
      }
    }
  });
  if(changed) save();
}

function renderROI(v, T){
  checkAccountAutoStatus();
  const accts = DB.accounts;
  const costs = DB.propCosts||[];
  const payouts = DB.payouts||[];
  // ROI global
  const totalSpent = costs.reduce((s,c)=>s+(c.amount||0),0);
  const totalCollected = payouts.reduce((s,p)=>s+(p.amount||0),0);
  const netProfit = totalCollected - totalSpent;
  const roiPct = totalSpent>0? (netProfit/totalSpent*100) : null;
  // Embudo por estado de cuenta
  const byStatus=s=>accts.filter(a=>(a.status||'en_curso')===s).length;
  const nEval = accts.length; // total cuentas registradas
  const nPassed = accts.filter(a=>['pasada','fondeada','payout'].includes(a.status)).length;
  const nFunded = accts.filter(a=>['fondeada','payout'].includes(a.status)).length;
  const nPayout = byStatus('payout');
  const nLost = byStatus('perdida');
  const nInProgress = byStatus('en_curso');
  const passRate = nEval>0? nPassed/nEval*100 : 0;
  const payoutConv = nFunded>0? nPayout/nFunded*100 : 0;
  const avgPayout = payouts.length? totalCollected/payouts.length : 0;

  v.innerHTML=`
    <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
      <span>ROI de props</span>
      <div style="display:flex;gap:8px">
        <button class="btn ghost sm" onclick="openCostModal()">+ Coste</button>
        <button class="btn ghost sm" onclick="openPayoutModal()">+ Payout</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3>ROI global ${helpIcon("roiglobal")}</h3>
      <div class="grid g-4" style="gap:10px">
        <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">GASTADO</div><div class="big neg">${fmt$(totalSpent)}</div><div class="hint" style="margin-top:4px">${costs.length} costes</div></div>
        <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">COBRADO</div><div class="big pos">${fmt$(totalCollected)}</div><div class="hint" style="margin-top:4px">${payouts.length} payouts</div></div>
        <div class="calc-out" style="border-color:${netProfit>=0?'var(--green-dim)':'var(--red-dim)'}"><div class="label" style="font-size:10px;color:var(--ink-faint)">NETO</div><div class="big ${cls(netProfit)}">${fmt$(netProfit)}</div></div>
        <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">ROI</div><div class="big ${roiPct==null?'':cls(roiPct)}">${roiPct==null?'—':fmt(roiPct,0)+'%'}</div></div>
      </div>
      ${roiPct!=null?`<div class="insight ${netProfit>=0?'':'warn'}" style="margin-top:14px">${netProfit>=0
        ? `Tu negocio de props es rentable: por cada $ invertido en cuentas, recuperas ${fmt(1+roiPct/100,2)}$. `
        : `De momento vas en negativo: has gastado ${fmt$(totalSpent)} y cobrado ${fmt$(totalCollected)}. Normal al principio si estás construyendo historial. `}</div>`:`<div class="hint" style="margin-top:12px">Añade tus costes de cuentas y tus payouts para ver el ROI.</div>`}
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3>Estadística de cuentas ${helpIcon("funnel")}</h3>
      <div class="grid g-4" style="gap:10px">
        <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">CUENTAS</div><div class="big">${nEval}</div><div class="hint" style="margin-top:4px">${nInProgress} en curso</div></div>
        <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">PASADAS</div><div class="big">${nPassed}</div><div class="hint" style="margin-top:4px">${fmt(passRate,0)}% aprobación</div></div>
        <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">CON PAYOUT</div><div class="big pos">${nPayout}</div><div class="hint" style="margin-top:4px">${fmt(payoutConv,0)}% de las fondeadas</div></div>
        <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">PERDIDAS</div><div class="big ${nLost?'neg':''}">${nLost}</div></div>
      </div>
      <div class="grid g-2" style="gap:10px;margin-top:10px">
        <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">PAYOUT MEDIO</div><div class="big">${fmt$(avgPayout)}</div></div>
        <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">PAYOUT TOTAL</div><div class="big pos">${fmt$(totalCollected)}</div></div>
      </div>
      <div class="hint" style="margin-top:12px">La estadística se calcula con el estado de cada cuenta (abajo). Marca el estado de cada una para que salgan bien las tasas de aprobación y conversión.</div>
    </div>

    ${costs.length||payouts.length?`
    <div class="card" style="margin-bottom:14px">
      <h3>Movimientos</h3>
      <div class="table-wrap" style="border:none"><table>
        <thead><tr><th>Fecha</th><th>Tipo</th><th>Concepto</th><th>Importe</th><th></th></tr></thead>
        <tbody>
        ${[...costs.map(c=>({...c,kind:'coste'})),...payouts.map(p=>({...p,kind:'payout'}))]
          .sort((a,b)=> a.date<b.date?1:-1)
          .map(m=>`<tr>
            <td>${m.date}</td>
            <td><span class="tag ${m.kind==='payout'?'ok':'bad'}">${m.kind==='payout'?'Payout':'Coste'}</span></td>
            <td style="font-family:var(--sans)">${m.concept||m.firm||'—'}</td>
            <td class="${m.kind==='payout'?'pos':'neg'}">${m.kind==='payout'?'+':'−'}${fmt$(m.amount)}</td>
            <td style="text-align:right"><button class="btn ghost sm icon" onclick="${m.kind==='payout'?`editPayout('${m.id}')`:`editCost('${m.id}')`}" title="Editar">✎</button></td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    </div>`:''}

    <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;margin-top:20px">
      <span>Cuentas</span>
      <div style="display:flex;gap:8px">
        <button class="btn ghost sm" onclick="openFirmEditor()">⚙ Editar reglas</button>
        <button class="btn primary sm" onclick="openAccountModal()">+ Cuenta</button>
      </div>
    </div>
    ${!accts.length?`<div class="empty"><div class="ico">▤</div><p class="hint">Sin cuentas. Añade una de tus firmas (LucidFlex, Topstep, MyFundedFutures, FundedNext...) y las reglas se cargan solas.</p><button class="btn primary" style="margin-top:14px" onclick="openAccountModal()">+ Añadir cuenta</button></div>`:
    accts.map(a=>{
      const spec = planSpec(a.firm, a.plan, a.phase) || {};
      // Trades de esta cuenta. Si la cuenta es funded, solo cuentan los trades
      // hechos en fase funded (los de la eval no suman al balance real).
      const allAcctTrades = T.filter(t=>t.account===a.name);
      const aTrades = a.phase==='Funded'
        ? allAcctTrades.filter(t=>tradePhase(t)==='funded')
        : allAcctTrades;
      const realized = totalPnl(aTrades);
      const balance = (a.startBalance||0)+realized;
      const dd = spec.drawdown||0;
      const trailLock = spec.trailLock||0;
      const lockedFloor = spec.lockedFloor||0;
      // Suelo trailing EOD: sube con el PICO de balance alcanzado, nunca baja con las pérdidas.
      // Reconstruimos el pico acumulando los trades en orden cronológico.
      const startBal0 = a.startBalance||0;
      let running0 = startBal0, peak0 = startBal0;
      aTrades.slice().sort((x,y)=> x.date<y.date?-1:1).forEach(t=>{ running0+=(t.pnl||0); if(running0>peak0) peak0=running0; });
      let floor;
      if(trailLock && peak0>=trailLock) floor = lockedFloor;
      else floor = peak0 - dd;
      const locked = trailLock && peak0>=trailLock;
      // margen real que te queda: desde el balance ACTUAL hasta el suelo
      const ddRoom = balance - floor;
      const ddPct = dd? Math.max(0,Math.min(100, ddRoom/dd*100)) : 0;

      const target = spec.profitTarget||0;
      const targetRoom = a.phase==='Evaluación'&&target? (a.startBalance+target) - balance : 0;
      const targetPct = a.phase==='Evaluación'&&target? Math.max(0,Math.min(100, realized/target*100)) : 0;

      // payout tracking (funded): días con profit >= minDailyProfit
      const profitByDay={};
      aTrades.forEach(t=>{ profitByDay[t.date]=(profitByDay[t.date]||0)+(t.pnl||0); });
      const minDP=spec.minDailyProfit||0;
      const qualDays = Object.values(profitByDay).filter(p=>minDP?p>=minDP:p>0).length;
      const daysReq = spec.minDays||5;
      const payoutReady = qualDays>=daysReq && realized>0;

      // consistency (si aplica): mayor día / profit total
      const dayProfits=Object.values(profitByDay).filter(p=>p>0);
      const maxDay=dayProfits.length?Math.max(...dayProfits):0;
      const consistency = realized>0? maxDay/realized*100 : 0;
      const consLimit = spec.consistency||0;
      const consistencyOK = !consLimit || consistency<=consLimit;

      // daily loss limit: peor día
      const worstDay = Math.min(0, ...Object.values(profitByDay));
      const dll = spec.dailyLoss||0;

      const firmObj=DB.firms[a.firm]||{};
      const trailLabel = (firmObj.trailing||'eod')==='eod'?'EOD trailing':(firmObj.trailing==='intraday'?'trailing intradía':'estático');
      const STATUS_LABELS={en_curso:'En curso',pasada:'Pasada',fondeada:'Fondeada',payout:'Con payout',perdida:'Perdida'};
      const st=a.status||'en_curso';
      const isEval = a.phase==='Evaluación';
      const dead = st==='perdida';

      // consejo según situación
      let advice='';
      if(dead){
        advice='Cuenta quemada. Si quieres, elimínala o déjala como registro histórico.';
      } else if(isEval && target){
        if(targetPct>=100) advice='¡Objetivo alcanzado! Ya puedes pasarla a fondeada.';
        else if(ddPct<25) advice='Cuidado: estás cerca del drawdown. Baja el riesgo hasta alejarte del suelo.';
        else if(targetPct>=60) advice='Vas bien encaminado al target. No fuerces: mantén tu riesgo y deja que llegue.';
        else advice='Aún lejos del target. Prioriza no quemarla: sobrevivir es más importante que correr.';
      } else {
        // funded
        if(ddPct<25) advice='Estás cerca del suelo. Protege la cuenta: reduce tamaño hasta recuperar margen.';
        else if(ddPct>60) advice='Buen colchón sobre el drawdown. Opera tranquilo y ve pensando en tu próximo payout.';
        else advice='Margen razonable. Mantén disciplina y construye hacia el payout sin arriesgar el suelo.';
      }

      return `<div class="card" style="margin-bottom:12px;${dead?'opacity:.6':''}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
          <div>
            <div style="font-size:15px;font-weight:700">${a.name} <span class="phase-tag ${st==='fondeada'||st==='payout'?'funded':st==='perdida'?'mixed':'eval'}" style="position:static;margin-left:6px">${STATUS_LABELS[st]}</span></div>
            <div class="acct-meta">${a.firm} ${a.plan} · ${trailLabel} · ${aTrades.length} trades${a.phase==='Funded'?' funded':''}</div>
          </div>
          <div style="display:flex;gap:6px">
            ${(st==='fondeada'||st==='payout')?`<button class="btn ghost sm icon" onclick="adjustBalance('${a.id}')" title="Reajustar balance (tras payout)">💰</button>`:''}
            <button class="btn ghost sm icon" onclick="editAccount('${a.id}')" title="Editar">✎</button>
          </div>
        </div>

        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:14px">
          <div><div class="label" style="font-size:10px;color:var(--ink-faint)">BALANCE</div><div style="font-family:var(--mono);font-size:22px;font-weight:700">${fmt$(balance)}</div></div>
          <div><div class="label" style="font-size:10px;color:var(--ink-faint)">P&L ${a.phase==='Funded'?'funded':''}</div><div style="font-family:var(--mono);font-size:16px;font-weight:700" class="${cls(realized)}">${fmt$(realized)}</div></div>
        </div>

        ${isEval&&target?`
        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink-dim);margin-bottom:3px"><span>📈 Progreso al objetivo</span><span style="font-family:var(--mono)">${fmt(targetPct,0)}% · faltan ${fmt$(Math.max(0,targetRoom))}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${targetPct}%;background:var(--blue)"></div></div>
        </div>`:''}

        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink-dim);margin-bottom:3px"><span>🛡️ Margen hasta quemarla ${locked?'🔒':''}</span><span style="font-family:var(--mono)">${fmt$(ddRoom)} (suelo ${fmt$(floor)})</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${ddPct}%;background:${ddPct>40?'var(--green)':ddPct>20?'var(--amber)':'var(--red)'}"></div></div>
        </div>

        ${consLimit?`<div class="insight ${consistencyOK?'':'warn'}" style="margin:0 0 10px">Consistency: tu mayor día es <b>${fmt(consistency,0)}%</b> del profit (límite ${consLimit}%). ${consistencyOK?'Dentro ✓':'⚠ Reparte más el profit entre días.'}</div>`:''}
        ${dll&&worstDay<=-dll?`<div class="insight bad" style="margin:0 0 10px">⚠ Tu peor día (${fmt$(worstDay)}) superó el daily loss limit de ${fmt$(dll)}.</div>`:''}

        <div class="insight ${dead?'bad':ddPct<25?'warn':''}" style="margin-top:4px">💡 ${advice}</div>
      </div>`;
    }).join('')}
    ${accts.length?`<div class="insight" style="margin-top:6px">Todas tus firmas usan <b>trailing EOD</b>: el suelo sube con tu balance de cierre y, si el plan tiene trail lock, se bloquea al superarlo (🔒). Revisa las reglas exactas de cada firma con ⚙ Editar reglas.</div>`:''}
  `;
}

/* ============================================================
   CALENDAR
   ============================================================ */
let CAL_MONTH = new Date().getMonth();
let CAL_YEAR = new Date().getFullYear();

function calShift(delta){
  CAL_MONTH += delta;
  if(CAL_MONTH<0){ CAL_MONTH=11; CAL_YEAR--; }
  if(CAL_MONTH>11){ CAL_MONTH=0; CAL_YEAR++; }
  render();
}

function renderCalendar(v, T){
  const monthName = new Date(CAL_YEAR,CAL_MONTH,1).toLocaleDateString('es-ES',{month:'long',year:'numeric'});
  const first = new Date(CAL_YEAR,CAL_MONTH,1);
  const startDow = (first.getDay()+6)%7; // lunes=0
  const daysInMonth = new Date(CAL_YEAR,CAL_MONTH+1,0).getDate();
  const todayStr = todayISO();

  // agrupar trades por día del mes visible (parseo local explícito, sin desfase TZ)
  const byDay={};
  T.forEach(t=>{
    const [yy,mm,dd]=t.date.split('-').map(Number);
    if(yy===CAL_YEAR && (mm-1)===CAL_MONTH){
      const day=dd;
      byDay[day]=byDay[day]||{pnl:0,n:0,dirty:false,r:0,phases:new Set()};
      byDay[day].pnl+=(t.pnl||0);
      byDay[day].r+=(t.realizedR||0);
      byDay[day].n++;
      if((t.flags||[]).some(f=>f!=='clean')) byDay[day].dirty=true;
      const ph=tradePhase(t); if(ph) byDay[day].phases.add(ph);
    }
  });

  // stats del mes
  const monthDays=Object.values(byDay);
  const monthPnl=monthDays.reduce((s,d)=>s+d.pnl,0);
  const greenDays=monthDays.filter(d=>d.pnl>0).length;
  const redDays=monthDays.filter(d=>d.pnl<0).length;

  const dows=['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
  let cells='';
  for(let i=0;i<startDow;i++) cells+=`<div class="cal-cell empty"></div>`;
  const ntByDate={};
  (DB.noTradeDays||[]).forEach(n=>{ (ntByDate[n.date]=ntByDate[n.date]||[]).push(n); });
  for(let day=1;day<=daysInMonth;day++){
    const d=byDay[day];
    const dateStr=`${CAL_YEAR}-${String(CAL_MONTH+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const isToday=dateStr===todayStr;
    const ntList=ntByDate[dateStr]||[];
    const noday=ntList.find(n=>(n.type||'noday')==='noday');
    const unfilledCount=ntList.filter(n=>n.type==='unfilled').length;
    if(d){
      const klass=d.pnl>0?'win':d.pnl<0?'loss':'';
      const phases=[...d.phases];
      const phaseLabel = phases.length>1 ? 'EVAL·FUND' : phases.length===1 ? (phases[0]==='funded'?'FUNDED':'EVAL') : '';
      const phaseCls = phases.length>1 ? 'mixed' : phases.length===1 ? phases[0] : '';
      const chips = `<div class="cal-chips">
        ${phaseLabel?`<span class="cal-chip ${phaseCls}">${phaseLabel}</span>`:''}
        ${d.dirty?'<span class="cal-chip err">REGLA SALTADA</span>':''}
        ${unfilledCount?`<span class="cal-chip ne" title="entrada(s) no ejecutada(s)">NO EJEC${unfilledCount>1?' ×'+unfilledCount:''}</span>`:''}
      </div>`;
      cells+=`<div class="cal-cell clickable ${klass} ${isToday?'today':''}" onclick="calDayDetail('${dateStr}')">
        <div class="daynum">${day}</div>
        ${chips}
        <div class="pnl ${cls(d.pnl)}">${fmt$(d.pnl)}</div>
        <div class="meta">${d.n} trade${d.n>1?'s':''} · ${fmtR(d.r)}</div>
      </div>`;
    } else if(noday){
      cells+=`<div class="cal-cell notrade clickable ${isToday?'today':''}" onclick="editNoTrade('${noday.id}')" title="${NOTRADE_REASONS[noday.reason]||''}">
        <div class="daynum">${day}</div>
        <div class="cal-chips"><span class="cal-chip rest">SIN OPERAR</span>${unfilledCount?`<span class="cal-chip ne">NO EJEC${unfilledCount>1?' ×'+unfilledCount:''}</span>`:''}</div>
        <div class="meta nt-reason">${NOTRADE_REASONS[noday.reason]||''}</div>
      </div>`;
    } else if(unfilledCount){
      cells+=`<div class="cal-cell notrade clickable ${isToday?'today':''}" onclick="editNoTrade('${ntList.find(n=>n.type==='unfilled').id}')" title="entrada no ejecutada">
        <div class="daynum">${day}</div>
        <div class="cal-chips"><span class="cal-chip ne">NO EJECUTADA${unfilledCount>1?' ×'+unfilledCount:''}</span></div>
      </div>`;
    } else {
      cells+=`<div class="cal-cell ${isToday?'today':''}"><div class="daynum">${day}</div></div>`;
    }
  }

  v.innerHTML=`
    <div class="cal-head">
      <button class="btn ghost sm icon" onclick="calShift(-1)">←</button>
      <div class="month">${monthName}</div>
      <button class="btn ghost sm icon" onclick="calShift(1)">→</button>
    </div>
    <div class="cal-grid">
      ${dows.map(d=>`<div class="cal-dow">${d}</div>`).join('')}
      ${cells}
    </div>
    <div class="cal-month-stats">
      <div class="s"><span class="k">P&L del mes</span><span class="v ${cls(monthPnl)}">${fmt$(monthPnl)}</span></div>
      <div class="s"><span class="k">Días verdes</span><span class="v pos">${greenDays}</span></div>
      <div class="s"><span class="k">Días rojos</span><span class="v neg">${redDays}</span></div>
      <div class="s"><span class="k">Días operados</span><span class="v">${monthDays.length}</span></div>
      ${(()=>{
        const ntMonth=(DB.noTradeDays||[]).filter(n=>{
          const [yy,mm]=n.date.split('-').map(Number);
          return yy===CAL_YEAR && (mm-1)===CAL_MONTH;
        });
        if(!ntMonth.length) return '';
        const days=ntMonth.filter(n=>(n.type||'noday')==='noday');
        const unfilled=ntMonth.filter(n=>n.type==='unfilled');
        const noSetup=days.filter(n=>n.reason==='no_setup').length;
        let out='';
        if(days.length) out+=`<div class="s"><span class="k">Días sin operar</span><span class="v" style="color:var(--ink-dim)">${days.length}${noSetup?` <span style="font-size:11px;color:var(--ink-faint)">(${noSetup} sin setup)</span>`:''}</span></div>`;
        if(unfilled.length) out+=`<div class="s"><span class="k">Entradas no ejecutadas</span><span class="v" style="color:var(--amber)">${unfilled.length}</span></div>`;
        return out;
      })()}
    </div>
    <div class="hint" style="margin-top:14px">Toca un día para ver el detalle. 🚫 = día sin trade (toca para editarlo). El punto rojo marca días con algún error de ejecución.</div>
  `;
}

function calDayDetail(dateStr){
  const dayTrades=DB.trades.filter(t=>t.date===dateStr).sort((a,b)=>a.id<b.id?-1:1);
  const dPnl=totalPnl(dayTrades), dR=totalR(dayTrades);
  const human=new Date(dateStr).toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'});
  $('#modalBg').innerHTML=`<div class="modal">
    <h2 style="text-transform:capitalize">${human} <button class="btn ghost sm icon" onclick="closeModal()">✕</button></h2>
    <div class="grid g-3" style="gap:10px;margin-bottom:16px">
      <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">P&L</div><div class="big ${cls(dPnl)}">${fmt$(dPnl)}</div></div>
      <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">R TOTAL</div><div class="big ${cls(dR)}">${fmtR(dR)}</div></div>
      <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">TRADES</div><div class="big">${dayTrades.length}</div></div>
    </div>
    ${dayTrades.map(t=>{
      const errs=(t.flags||[]).filter(f=>f!=='clean');
      return `<div class="card" style="padding:12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div><b>${t.symbol}</b> <span class="hint">${t.setup} · ${t.session}</span></div>
          <div style="font-family:var(--mono);font-weight:700" class="${cls(t.realizedR)}">${fmtR(t.realizedR)} · ${fmt$(t.pnl)}</div>
        </div>
        ${errs.length?`<div style="margin-top:6px">${errs.map(f=>`<span class="tag bad" style="margin:1px">${FLAG_LABELS[f]||f}</span>`).join('')}</div>`:''}
        ${t.note?`<div class="hint" style="margin-top:6px">${t.note}</div>`:''}
        ${(t.images&&t.images.length)?`<div class="thumb-row">${t.images.map(img=>`<img class="thumb" src="${img}" onclick="lightbox('${img}')">`).join('')}</div>`:''}
      </div>`;
    }).join('')||'<p class="hint">Sin trades este día.</p>'}
    <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cerrar</button></div>
  </div>`;
  $('#modalBg').classList.add('show');
}

function lightbox(src){
  let lb=$('#lightbox');
  if(!lb){ lb=document.createElement('div'); lb.id='lightbox'; lb.className='lightbox'; lb.onclick=()=>lb.classList.remove('show'); document.body.appendChild(lb); }
  lb.innerHTML=`<img src="${src}">`;
  lb.classList.add('show');
}

/* ============================================================
   JOURNAL
   ============================================================ */
let JOURNAL_FILTER = 'all';
function renderJournal(v, T){
  const filtered = JOURNAL_FILTER==='errors' ? T.filter(t=>(t.flags||[]).some(f=>f!=='clean')) :
                   JOURNAL_FILTER==='clean' ? T.filter(t=>!(t.flags||[]).some(f=>f!=='clean')) : T;
  v.innerHTML=`
    <div class="section-title">Journal</div>
    <div class="pill-row">
      <button class="chip ${JOURNAL_FILTER==='all'?'on good':''}" onclick="setJournalFilter('all')">Todos (${T.length})</button>
      <button class="chip ${JOURNAL_FILTER==='clean'?'on good':''}" onclick="setJournalFilter('clean')">Limpios</button>
      <button class="chip ${JOURNAL_FILTER==='errors'?'on':''}" onclick="setJournalFilter('errors')">Con error</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Fecha</th><th>Símbolo</th><th>Setup</th><th>Sesión</th><th>Plan R</th><th>Real R</th><th>P&L</th><th>Estado</th><th>Flags</th><th></th></tr></thead>
      <tbody>${filtered.map(t=>{
        const errs=(t.flags||[]).filter(f=>f!=='clean');
        return `<tr>
          <td>${t.date}</td>
          <td>${t.symbol||'—'}${(t.images&&t.images.length)?` <span title="${t.images.length} imagen(es)" style="opacity:.6">📎</span>`:''}</td>
          <td style="font-family:var(--sans)">${t.setup||'—'}</td>
          <td>${t.session||'—'}</td>
          <td>${fmt(t.plannedR,1)}</td>
          <td class="${cls(t.realizedR)}">${fmtR(t.realizedR)}</td>
          <td class="${cls(t.pnl)}">${fmt$(t.pnl)}</td>
          <td><span class="tag ${t.result==='win'?'ok':t.result==='loss'?'bad':'neutral'}">${t.result==='win'?'Gan':t.result==='loss'?'Perd':'BE'}</span>${t.exitType==='manual'?' <span class="tag warn" title="cierre manual">✋</span>':''}</td>
          <td>${errs.length?errs.map(f=>`<span class="tag bad" style="margin:1px">${FLAG_LABELS[f]||f}</span>`).join(''):'<span class="tag ok">limpio</span>'}</td>
          <td><button class="btn ghost sm icon" onclick="editTrade('${t.id}')">✎</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
  `;
}
function setJournalFilter(f){ JOURNAL_FILTER=f; render(); }

/* ============================================================
   CHARTS
   ============================================================ */
function chartBase(){
  return {responsive:true,maintainAspectRatio:false,
    plugins:{legend:{display:false},tooltip:{backgroundColor:'#161c27',borderColor:'#1f2733',borderWidth:1,titleColor:'#e8edf4',bodyColor:'#8a97a8',padding:10}},
    scales:{x:{grid:{color:'#1f2733'},ticks:{color:'#5a6573',font:{size:10}}},y:{grid:{color:'#1f2733'},ticks:{color:'#5a6573',font:{size:10}}}}};
}
function drawEquity(id, T){
  const el=$('#'+id); if(!el) return;
  const curve=equityCurve(T);
  const final=curve.length?curve[curve.length-1].cum:0;
  const color=final>=0?'#3ddc84':'#ff5d5d';
  const grad=el.getContext('2d').createLinearGradient(0,0,0,200);
  grad.addColorStop(0, final>=0?'rgba(61,220,132,.25)':'rgba(255,93,93,.25)');
  grad.addColorStop(1,'rgba(0,0,0,0)');
  charts.eq=new Chart(el,{type:'line',data:{labels:curve.map((p,i)=>i+1),
    datasets:[{data:curve.map(p=>p.cum),borderColor:color,backgroundColor:grad,fill:true,tension:.25,pointRadius:0,borderWidth:2}]},
    options:chartBase()});
}
function drawCumulative(id, T){
  const el=$('#'+id); if(!el) return;
  const ch=[...T].sort((a,b)=> a.date<b.date?-1: a.date>b.date?1:0);
  let cumR=0, wins=0, counted=0;
  const wrPts=[], expPts=[];
  ch.forEach((t,i)=>{
    cumR+=(t.realizedR||0);
    if(t.result!=='be'){ counted++; if(t.result==='win')wins++; }
    wrPts.push(counted? wins/counted*100 : 0);
    expPts.push(cumR/(i+1));
  });
  charts.cum=new Chart(el,{type:'line',
    data:{labels:ch.map((p,i)=>i+1),datasets:[
      {label:'Winrate %',data:wrPts,borderColor:'#4d9fff',backgroundColor:'transparent',tension:.25,pointRadius:0,borderWidth:2,yAxisID:'y'},
      {label:'Expectancy R',data:expPts,borderColor:'#3ddc84',backgroundColor:'transparent',tension:.25,pointRadius:0,borderWidth:2,yAxisID:'y1'}
    ]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{backgroundColor:'#161c27',borderColor:'#1f2733',borderWidth:1,titleColor:'#e8edf4',bodyColor:'#8a97a8',padding:10}},
      scales:{
        x:{grid:{color:'#1f2733'},ticks:{color:'#5a6573',font:{size:10}}},
        y:{position:'left',grid:{color:'#1f2733'},ticks:{color:'#4d9fff',font:{size:10},stepSize:20,callback:v=>Math.round(v)+'%'},min:0,max:100},
        y1:{position:'right',grid:{drawOnChartArea:false},ticks:{color:'#3ddc84',font:{size:10},maxTicksLimit:6,callback:v=>Number(v).toFixed(2)+'R'}}
      }}});
}
function drawRRCurve(id, T){
  const el=$('#'+id); if(!el) return;
  const o=optimalRR(T);
  if(!o.enough) return;
  const labels=o.curve.map(c=>'1:'+String(c.tp).replace('.0',''));
  const data=o.curve.map(c=>c.exp);
  const colors=o.curve.map(c=> c.tp===o.best.tp ? '#3ddc84' : 'rgba(61,220,132,.35)');
  const levels=o.curve.map(c=>c.tp);

  // Plugin que dibuja la línea del DOL medio en cada render (robusto, no se borra)
  const dolLinePlugin={
    id:'dolLine',
    afterDraw(chart){
      if(o.avgDol==null) return;
      const xScale=chart.scales.x, yScale=chart.scales.y;
      // interpolar la posición X del DOL entre los niveles del eje
      let xPos=null;
      for(let i=0;i<levels.length-1;i++){
        if(o.avgDol>=levels[i] && o.avgDol<=levels[i+1]){
          const frac=(o.avgDol-levels[i])/(levels[i+1]-levels[i]);
          const x0=xScale.getPixelForValue(i), x1=xScale.getPixelForValue(i+1);
          xPos=x0+(x1-x0)*frac;
          break;
        }
      }
      // si el DOL cae más allá del último nivel, lo clavamos al borde derecho
      if(xPos==null && o.avgDol>levels[levels.length-1]) xPos=xScale.getPixelForValue(levels.length-1);
      if(xPos==null) return;
      const ctx=chart.ctx;
      ctx.save();
      ctx.strokeStyle='#4d9fff'; ctx.lineWidth=2; ctx.setLineDash([5,4]);
      ctx.beginPath(); ctx.moveTo(xPos,yScale.top); ctx.lineTo(xPos,yScale.bottom); ctx.stroke();
      // etiqueta "DOL"
      ctx.setLineDash([]);
      ctx.fillStyle='#4d9fff';
      ctx.font='700 10px Inter, sans-serif';
      ctx.textAlign='center';
      const label='DOL '+fmt(o.avgDol,1).replace('.0','')+'R';
      const tw=ctx.measureText(label).width;
      let lx=xPos; if(lx+tw/2>chart.width-4) lx=chart.width-tw/2-4; if(lx-tw/2<4) lx=tw/2+4;
      ctx.fillRect(lx-tw/2-4,yScale.top-16,tw+8,14);
      ctx.fillStyle='#0b0e14';
      ctx.fillText(label,lx,yScale.top-5);
      ctx.restore();
    }
  };

  charts.rr=new Chart(el,{type:'bar',
    data:{labels,datasets:[{data,backgroundColor:colors,borderRadius:5}]},
    options:{responsive:true,maintainAspectRatio:false,
      layout:{padding:{top:18}},
      plugins:{legend:{display:false},tooltip:{backgroundColor:'#161c27',borderColor:'#1f2733',borderWidth:1,titleColor:'#e8edf4',bodyColor:'#8a97a8',padding:10,
        callbacks:{label:ctx=>`Exp: ${ctx.parsed.y>=0?'+':''}${ctx.parsed.y.toFixed(2)}R`}}},
      scales:{
        x:{grid:{color:'#1f2733'},ticks:{color:'#5a6573',font:{size:10}}},
        y:{grid:{color:'#1f2733'},ticks:{color:'#5a6573',font:{size:10},callback:v=>Number(v).toFixed(1)+'R'}}
      }},
    plugins:[dolLinePlugin]});
}
function drawDistribution(id, T){
  const el=$('#'+id); if(!el) return;
  // buckets internos + etiquetas legibles
  const defs=[
    {key:'peor', label:'Peor de -2R', test:r=>r<-2, color:'#ff5d5d'},
    {key:'m2m1', label:'-2R a -1R', test:r=>r>=-2&&r<-1, color:'#ff5d5d'},
    {key:'m1a0', label:'-1R a 0', test:r=>r>=-1&&r<0, color:'#ff5d5d'},
    {key:'0a1',  label:'0 a 1R', test:r=>r>=0&&r<1, color:'#3ddc84'},
    {key:'1a2',  label:'1R a 2R', test:r=>r>=1&&r<2, color:'#3ddc84'},
    {key:'mas2', label:'Más de 2R', test:r=>r>=2, color:'#3ddc84'}
  ];
  const counts=defs.map(d=>0);
  T.forEach(t=>{
    const r=t.realizedR||0;
    const i=defs.findIndex(d=>d.test(r));
    if(i>=0) counts[i]++;
  });
  const base=chartBase();
  base.scales.y.title={display:true,text:'Nº de trades',color:'#8a97a8',font:{size:11,weight:'600'}};
  base.scales.y.ticks.precision=0;
  base.scales.y.ticks.stepSize=1;
  base.plugins.tooltip.callbacks={label:ctx=>`${ctx.parsed.y} trade${ctx.parsed.y===1?'':'s'}`};
  charts.dist=new Chart(el,{type:'bar',data:{labels:defs.map(d=>d.label),
    datasets:[{data:counts,backgroundColor:defs.map(d=>d.color),borderRadius:5}]},
    options:base});
}

/* ============================================================
   MODAL — TRADE
   ============================================================ */
const FLAG_LABELS={
  clean:'Limpio',
  early_close:'Cierre temprano (miedo)',
  fomo:'Entrada FOMO',
  against_bias:'Contra bias',
  over_max_stops:'Superé máx. stops',
  moved_stop:'Moví el stop',
  revenge:'Revenge trade',
  no_setup:'Sin setup válido',
  oversized:'Sobre-dimensioné',
  bad_analysis:'Error de análisis'
};
// Plan de trading — checklist que aparece al registrar
const PLAN_CHECKLIST=[
  'Tener el DOL claro e ir solo a favor del DOL (Innegociable)',
  'SL donde se invalide el trade',
  'Vela de 12h ha cerrado dentro',
  'No tener rango contrario importante cerca',
  'Tendencia a favor',
  'Poner BE solo al llegar al 3r cuadrante (nunca antes)'
];
const SETUPS=['Setup A','Setup B','Setup C','Pares','Otro'];
const SYMBOLS=['MNQ','MES','MYM','M2K','MGC','MCL','M6E','NQ','ES','YM','GC','CL','EURAUD','Otro'];
const SESSIONS=['Londres (9-12)','London Lunch (12-15)','NY (15:30+)','Otra'];
// Origen del movimiento (estructura CRT en NY)
const MOVE_TYPES={
  open930:'Impulso apertura NY (9:30-10h)',
  po3_4h:'PO3 vela 4h de las 10h (manipula y va al DOL)',
  other:'Otro momento'
};

function openTradeModal(){ tradeModal(); }

/* ---------- Dia sense trade ---------- */
function openNoTradeModal(existing){
  const e=existing||{};
  const type=e.type||'noday';
  $('#modalBg').innerHTML=`<div class="modal">
    <h2>${existing?'Editar registro':'Sin trade'} <button class="btn ghost sm icon" onclick="closeModal()">✕</button></h2>
    <div class="field"><label>Tipo de registro</label>
      <select id="nt_type" onchange="ntTypeChange()">
        <option value="noday" ${type==='noday'?'selected':''}>Día sin operar (no entré en todo el día)</option>
        <option value="unfilled" ${type==='unfilled'?'selected':''}>Entrada no ejecutada (limit no filleada, cancelada...)</option>
      </select>
    </div>
    <div class="field-row">
      <div class="field"><label>Fecha</label><input type="date" id="nt_date" value="${e.date||todayISO()}"></div>
      <div class="field" id="nt_reasonWrap"><label>Motivo</label>
        <select id="nt_reason">
          ${Object.entries(NOTRADE_REASONS).map(([k,l])=>`<option value="${k}" ${e.reason===k?'selected':''}>${l}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="field"><label id="nt_noteLabel">¿Por qué no entré? <span class="hint">explícalo bien, es tan valioso como un trade</span></label>
      <textarea id="nt_note" rows="4" placeholder="Qué viste en el gráfico, qué faltaba para tu setup, por qué decidiste esperar...">${e.note||''}</textarea>
    </div>
    <div class="field"><label>Capturas (gráfico, contexto...)</label>
      <div class="img-drop" id="nt_imgdrop" onclick="document.getElementById('nt_imgInput').click()">📎 Toca para adjuntar imágenes (se comprimen solas)</div>
      <input type="file" id="nt_imgInput" accept="image/*" multiple style="display:none" onchange="handleNoTradeImages(event)">
      <div class="thumb-row" id="nt_thumbs"></div>
    </div>
    <div class="insight" id="nt_insight" style="margin-top:4px"></div>
    <div class="modal-actions">
      ${existing?`<button class="btn danger" onclick="deleteNoTrade('${existing.id}')">Eliminar</button>`:''}
      <button class="btn ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="saveNoTrade('${existing?existing.id:''}')">Guardar</button>
    </div>
  </div>`;
  $('#modalBg').classList.add('show');
  $('#modalBg')._ntImages=[...(e.images||[])];
  renderNoTradeThumbs();
  ntTypeChange();
}
// Adapta el modal según el tipo (día sin operar vs entrada no ejecutada)
function ntTypeChange(){
  const type=$('#nt_type')?.value||'noday';
  const reasonWrap=$('#nt_reasonWrap');
  const noteLabel=$('#nt_noteLabel');
  const insight=$('#nt_insight');
  const note=$('#nt_note');
  if(type==='unfilled'){
    if(reasonWrap) reasonWrap.style.display='none';   // sin motivos predefinidos, lo explica en la nota
    if(noteLabel) noteLabel.innerHTML=`¿Qué pasó con la entrada? <span class="hint">explica cómo la gestionaste</span>`;
    if(note && !note.value) note.placeholder='Ej: sell limit no filleada por 1 punto, el precio fue a TP sin mí. Buena lectura, límite demasiado ajustado.';
    if(insight) insight.innerHTML='Esto NO cuenta en tu winrate ni expectancy (no hubo operación real). Se registra solo para que veas cómo gestionas estas situaciones con el tiempo.';
  } else {
    if(reasonWrap) reasonWrap.style.display='';
    if(noteLabel) noteLabel.innerHTML=`¿Por qué no entré? <span class="hint">explícalo bien, es tan valioso como un trade</span>`;
    if(note && !note.value) note.placeholder='Qué viste en el gráfico, qué faltaba para tu setup, por qué decidiste esperar...';
    if(insight) insight.innerHTML='Registrar los días que no operas también es disciplina. Si el motivo es "no había setup", es paciencia bien hecha.';
  }
}
async function handleNoTradeImages(ev){
  const files=[...ev.target.files];
  for(const f of files){
    if(!f.type.startsWith('image/')) continue;
    const compressed=await compressImage(f);
    $('#modalBg')._ntImages.push(compressed);
  }
  renderNoTradeThumbs();
  ev.target.value='';
}
function renderNoTradeThumbs(){
  const imgs=$('#modalBg')._ntImages||[];
  const c=$('#nt_thumbs');
  if(!c) return;
  c.innerHTML=imgs.map((src,i)=>`<div style="position:relative">
    <img class="thumb" src="${src}">
    <button onclick="removeNoTradeImage(${i})" style="position:absolute;top:-6px;right:-6px;background:var(--red);color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;line-height:1">×</button>
  </div>`).join('');
  $$('#nt_thumbs .thumb').forEach((el,i)=>{ el.onclick=()=>lightbox(imgs[i]); });
}
function removeNoTradeImage(i){
  $('#modalBg')._ntImages.splice(i,1);
  renderNoTradeThumbs();
}
function saveNoTrade(id){
  const date=$('#nt_date').value;
  if(!date){ toast('Pon una fecha'); return; }
  const type=$('#nt_type').value;
  // Solo un "día sin operar" por fecha. Las entradas no ejecutadas pueden repetirse.
  if(type==='noday'){
    const dup=(DB.noTradeDays||[]).find(d=>d.date===date && (d.type||'noday')==='noday' && d.id!==id);
    if(dup){ toast('Ya tienes un día sin operar para esta fecha'); return; }
  }
  const nt={ id:id||uid(), date, type, reason:type==='noday'?$('#nt_reason').value:'', note:$('#nt_note').value.trim(), images:[...($('#modalBg')._ntImages||[])] };
  DB.noTradeDays=DB.noTradeDays||[];
  if(id){ const i=DB.noTradeDays.findIndex(d=>d.id===id); DB.noTradeDays[i]=nt; }
  else DB.noTradeDays.push(nt);
  try{ save(); }
  catch(err){ toast('⚠ Almacenamiento lleno. Quita alguna imagen.'); if(!id) DB.noTradeDays.pop(); return; }
  closeModal(); render();
  if(id){ toast('Actualizado'); }
  else if(type==='unfilled'){ toast('Entrada no ejecutada registrada'); }
  else { showMantra(processMantra(null)); }
}
function deleteNoTrade(id){
  if(!confirm('¿Eliminar este registro?'))return;
  DB.noTradeDays=(DB.noTradeDays||[]).filter(d=>d.id!==id);
  save(); closeModal(); render(); toast('Eliminat');
}
function editNoTrade(id){
  const nt=(DB.noTradeDays||[]).find(d=>d.id===id);
  if(nt) openNoTradeModal(nt);
}
function editTrade(id){ tradeModal(DB.trades.find(t=>t.id===id)); }

function tradeModal(t){
  const e=t||{};
  const flags=e.flags||['clean'];
  const planChecked=e.planChecked||[];
  $('#modalBg').innerHTML=`<div class="modal">
    <h2>${t?'Editar trade':'Nuevo trade'} <button class="btn ghost sm icon" onclick="closeModal()">✕</button></h2>
    <div class="plan-box">
      <div class="plan-title">📋 Plan de trading — checklist antes de entrar</div>
      <div id="f_plan">
        ${PLAN_CHECKLIST.map((rule,i)=>`<label class="plan-item">
          <input type="checkbox" data-plan="${i}" ${planChecked.includes(i)?'checked':''}>
          <span>${rule}</span>
        </label>`).join('')}
      </div>
      <div class="plan-count" id="f_planCount"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Fecha inicio <span class="hint">apertura del trade</span></label><input type="date" id="f_dateStart" value="${e.dateStart||e.date||todayISO()}"></div>
      <div class="field"><label>Fecha fin <span class="hint">cierre del trade</span></label><input type="date" id="f_dateEnd" value="${e.dateEnd||''}"></div>
    </div>
    <div class="field"><label>Símbolo <span class="hint">par de divisas</span></label>
      <input type="text" id="f_symbol" value="${e.symbol||''}" placeholder="ex. EURUSD, GBPJPY..." style="text-transform:uppercase">
    </div>
    <div class="field-row">
      <div class="field"><label>Cuenta</label><select id="f_account" onchange="onAccountChange()"><option value="">— sin asignar —</option>${DB.accounts.map(a=>{
        const tag = a.phase==='Funded'?' (fondeada)':' (eval)';
        return `<option value="${a.name.replace(/"/g,'&quot;')}" ${e.account===a.name?'selected':''}>${a.name}${tag}</option>`;
      }).join('')}</select></div>
      <div class="field"><label>Fase del trade <span class="hint">en qué fase se hizo</span></label>
        <select id="f_phase">
          <option value="" ${!e.phase?'selected':''}>— auto (según cuenta) —</option>
          <option value="eval" ${e.phase==='eval'?'selected':''}>Evaluación</option>
          <option value="funded" ${e.phase==='funded'?'selected':''}>Funded</option>
        </select>
      </div>
    </div>
    <div class="field-row-3">
      <div class="field"><label>R planificado <span class="hint">tu objetivo</span></label><input type="number" id="f_plannedR" step="0.1" value="${e.plannedR??1.5}"></div>
      <div class="field"><label>R realizado <span class="hint">lo que sacaste</span></label><input type="number" id="f_realizedR" step="0.1" value="${e.realizedR??''}" oninput="onRealizedRChange()" placeholder="-1 / 0 / 1.5"></div>
      <div class="field"><label>Riesgo ($)</label><input type="number" id="f_riskUSD" value="${e.riskUSD??200}" oninput="onRealizedRChange()"></div>
    </div>
    <div class="calc-out" id="f_resultPreview" style="margin-bottom:14px;padding:12px 14px"></div>
    <div class="hint" style="margin:-8px 0 14px">El <b>R planificado</b> es tu objetivo al entrar. Sirve para medir cuánto dejas sobre la mesa cuando cierras antes o te saltas el plan — es la base del "coste de la indisciplina".</div>
    <div class="field"><label>P&L real ($) <span class="hint">se calcula solo, edítalo si el broker dio otra cifra</span></label>
      <input type="number" id="f_pnl" value="${e.pnl??''}" placeholder="auto">
    </div>
    <div class="field"><label>¿Cómo saliste?</label>
      <select id="f_exitType">
        <option value="target" ${(e.exitType||'target')==='target'?'selected':''}>TP completo (llegué a mi objetivo)</option>
        <option value="manual" ${e.exitType==='manual'?'selected':''}>Cierre manual (cerré antes del objetivo)</option>
        <option value="be_moved" ${e.exitType==='be_moved'?'selected':''}>Movió BE y saltó (salí en ~0R)</option>
        <option value="stop" ${e.exitType==='stop'?'selected':''}>SL (saltó el stop)</option>
      </select>
      <div class="hint" style="margin-top:5px">Lo que de verdad cuenta para tus métricas es el <b>R realizado</b> de arriba. Esto solo clasifica cómo cerraste.</div>
    </div>
    <div class="field-row">
      <div class="field" id="f_dolWrap"><label>¿Llegó al DOL final?</label>
        <select id="f_dolReached">
          <option value="" ${!e.dolReached?'selected':''}>— no registrado —</option>
          <option value="yes" ${e.dolReached==='yes'?'selected':''}>Sí, llegó al DOL final</option>
          <option value="no" ${e.dolReached==='no'?'selected':''}>No, se quedó corto</option>
        </select>
      </div>
      <div class="field"><label>DOL en R <span class="hint">a cuántos R estaba tu DOL</span></label>
        <input type="number" id="f_dolR" step="0.1" min="0" value="${e.dolR??''}" placeholder="ex. 2.0">
      </div>
    </div>
    <div class="hint" style="margin:-6px 0 12px">DOL en R = la distancia de tu DOL final respecto a tu entrada, en R. Lo sabes al entrar (dónde está el DOL / dónde tu stop). Es el dato real de dónde está tu objetivo, no dónde llegó el precio.</div>
    <div class="field"><label>R máximo alcanzado (MFE) <span class="hint">a favor</span></label>
      <input type="number" id="f_mfe" step="0.1" value="${e.mfe??''}" placeholder="ex. 2.3">
    </div>
    <div class="hint" style="margin:-6px 0 12px">MFE = hasta qué R se movió el precio a tu favor, aunque no lo cobraras. <b>En un SL también importa</b>: te dice si acertaste dirección pero te sacaron, o si la entrada estaba mal.</div>
    <div class="field"><label>R máximo en contra (MAE) <span class="hint">cuánto sufrió antes de resolverse</span></label>
      <input type="number" id="f_mae" step="0.1" min="0" value="${e.mae??''}" placeholder="ex. 0.4">
      <div class="hint" style="margin-top:5px">Cuánto se movió el precio EN CONTRA (en R positivos) antes de irse a favor o al stop. Sirve para saber si tu SL está demasiado lejos. Ej: si pusiste SL a 1R pero el precio solo fue 0,4R en contra antes de ganar, pon 0,4.</div>
    </div>
    <div class="field"><label>Flags de ejecución (marca lo que pasó)</label>
      <div class="chips" id="f_flags">
        ${Object.entries(FLAG_LABELS).map(([k,l])=>`<button type="button" class="chip ${flags.includes(k)?(k==='clean'?'on good':'on'):''}" data-flag="${k}" onclick="toggleFlag('${k}')">${l}</button>`).join('')}
      </div>
    </div>
    <div class="field"><label>Nota</label><textarea id="f_note" rows="2" placeholder="Contexto, qué viste, qué harías distinto...">${e.note||''}</textarea></div>
    <div class="field"><label>Capturas (gráficos, entradas...)</label>
      <div class="img-drop" id="f_imgdrop" onclick="document.getElementById('f_imgInput').click()">📎 Toca para adjuntar imágenes (se comprimen solas)</div>
      <input type="file" id="f_imgInput" accept="image/*" multiple style="display:none" onchange="handleTradeImages(event)">
      <div class="thumb-row" id="f_thumbs"></div>
    </div>
    <div class="modal-actions">
      ${t?`<button class="btn danger" onclick="deleteTrade('${t.id}')">Eliminar</button>`:''}
      <button class="btn ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="saveTrade('${t?t.id:''}')">Guardar</button>
    </div>
  </div>`;
  $('#modalBg').classList.add('show');
  $('#modalBg')._flags=[...flags];
  $('#modalBg')._images=[...(e.images||[])];
  renderTradeThumbs();
  // contador de checklist del plan
  const updatePlanCount=()=>{
    const checked=$$('#f_plan input[type=checkbox]').filter(c=>c.checked).length;
    const total=PLAN_CHECKLIST.length;
    const el=$('#f_planCount');
    if(el) el.innerHTML=`<span class="${checked===total?'pos':checked>=total-1?'':'neg'}">${checked}/${total} reglas cumplidas</span>${checked<total?' — revisa antes de entrar':' ✓ setup A+'}`;
  };
  $$('#f_plan input[type=checkbox]').forEach(c=>c.addEventListener('change',updatePlanCount));
  updatePlanCount();
  onRealizedRChange();
}

// Deduce el resultado a partir del R realizado (single source of truth)
// Mantra de procés: reforça centrar-se en el procés, no en el resultat.
// t = trade guardat (o null si és un no-trade)
function processMantra(t){
  if(!t){
    // no-trade
    return "Avui no ha sigut necessari operar. Està súper bé. 🧘";
  }
  const hasError=(t.flags||[]).some(f=>f!=='clean');
  const isLoss=t.result==='loss';
  if(!hasError){
    if(isLoss) return "Has operat i ha sigut stop, però has seguit el pla. Està súper bé. 💪";
    return "Has operat i has seguit el pla de puta mare. 🔥";
  } else {
    return "Avui no ha estat del tot bé, però es millorarà. El procés per damunt del resultat. 🌱";
  }
}
function showMantra(msg){
  const m=$('#mantra');
  if(!m) return;
  m.innerHTML=`<div class="m-text">${msg}</div><div class="m-sub">toca para cerrar</div>`;
  m.classList.add('show');
  m.style.pointerEvents='auto';
  const close=()=>{ m.classList.remove('show'); m.style.pointerEvents='none'; m.onclick=null; clearTimeout(m._t); };
  m.onclick=close;
  clearTimeout(m._t); m._t=setTimeout(close,4000);
}
function resultFromR(r){
  if(r==null||isNaN(r)) return null;
  if(r>0) return 'win';
  if(r<0) return 'loss';
  return 'be';
}

// Muestra el campo de texto libre solo si el origen del movimiento es "otro"
function toggleMoveOther(){
  const sel=$('#f_moveType');
  const inp=$('#f_moveOther');
  if(!sel||!inp) return;
  inp.style.display = sel.value==='other' ? '' : 'none';
}
// Mostra els detalls de l'SMT només si hi ha hagut entrada
function toggleSmt(){
  const sel=$('#f_smt');
  const box=$('#f_smtDetails');
  if(!sel||!box) return;
  box.style.display = sel.value==='yes' ? '' : 'none';
}
// Al cambiar de cuenta, autoseleccionar su fase actual (si el usuario no ha forzado una)
function onAccountChange(){
  const acc=DB.accounts.find(a=>a.name===$('#f_account')?.value);
  const ph=$('#f_phase');
  if(acc && ph && !ph.value){ ph.value = acc.phase==='Funded'?'funded':'eval'; }
}
function onRealizedRChange(){
  const r=parseFloat($('#f_realizedR')?.value);
  const risk=parseFloat($('#f_riskUSD')?.value)||0;
  const res=resultFromR(r);
  // preview del resultado deducido
  const prev=$('#f_resultPreview');
  if(prev){
    if(res===null){
      prev.innerHTML=`<span class="hint">Introduce el R realizado. <b>-1</b> = SL completo · <b>0</b> = break-even · <b>+1.5</b> = TP a 1:1,5</span>`;
    } else {
      const label=res==='win'?'GANADOR':res==='loss'?'PERDEDOR':'BREAK-EVEN';
      const color=res==='win'?'var(--green)':res==='loss'?'var(--red)':'var(--ink-dim)';
      const pnlCalc=r*risk;
      prev.innerHTML=`<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <span style="font-weight:700;color:${color};font-size:13px;letter-spacing:.03em">${label}</span>
        <span class="hint">${fmtR(r)} × ${fmt$(risk)} = <b style="color:${color}">${fmt$(pnlCalc)}</b></span>
      </div>`;
    }
  }
  // autorellenar P&L si está vacío o si coincidía con el cálculo anterior
  const pnlEl=$('#f_pnl');
  if(pnlEl && res!==null){
    if(pnlEl.value==='' || pnlEl.dataset.auto==='1'){
      pnlEl.value=(r*risk).toFixed(2);
      pnlEl.dataset.auto='1';
    }
  }
  toggleDolField();
}

// Amaga el camp del DOL quan el trade és perdedor (un SL mai arriba al DOL,
// així que registrar-ho embrutaria l'estadística sense aportar res)
function toggleDolField(){
  const r=parseFloat($('#f_realizedR')?.value);
  const res=resultFromR(r);
  const wrap=$('#f_dolWrap');
  if(!wrap) return;
  if(res==='loss'){
    wrap.style.display='none';
    const sel=$('#f_dolReached'); if(sel) sel.value='';
  } else {
    wrap.style.display='';
  }
}

// Comprime una imagen a max 1000px lado mayor, JPEG 0.7 (~100-200KB)
function compressImage(file){
  return new Promise((resolve)=>{
    const reader=new FileReader();
    reader.onload=e=>{
      const img=new Image();
      img.onload=()=>{
        const max=1000;
        let {width,height}=img;
        if(width>max||height>max){
          if(width>height){ height=height*max/width; width=max; }
          else { width=width*max/height; height=max; }
        }
        const canvas=document.createElement('canvas');
        canvas.width=width; canvas.height=height;
        canvas.getContext('2d').drawImage(img,0,0,width,height);
        resolve(canvas.toDataURL('image/jpeg',0.7));
      };
      img.src=e.target.result;
    };
    reader.readAsDataURL(file);
  });
}
async function handleTradeImages(ev){
  const files=[...ev.target.files];
  for(const f of files){
    if(!f.type.startsWith('image/')) continue;
    const compressed=await compressImage(f);
    $('#modalBg')._images.push(compressed);
  }
  renderTradeThumbs();
  ev.target.value='';
}
function renderTradeThumbs(){
  const imgs=$('#modalBg')._images||[];
  const c=$('#f_thumbs');
  if(!c) return;
  c.innerHTML=imgs.map((src,i)=>`<div style="position:relative">
    <img class="thumb" src="${src}" onclick="lightbox('${'IMG'+i}')">
    <button onclick="removeTradeImage(${i})" style="position:absolute;top:-6px;right:-6px;background:var(--red);color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;line-height:1">×</button>
  </div>`).join('');
  // lightbox por índice (evita meter base64 gigante en onclick)
  $$('#f_thumbs .thumb').forEach((el,i)=>{ el.onclick=()=>lightbox(imgs[i]); });
}
function removeTradeImage(i){
  $('#modalBg')._images.splice(i,1);
  renderTradeThumbs();
}
function _modalImagesEnd(){}
function toggleFlag(k){
  const fl=$('#modalBg')._flags;
  if(k==='clean'){ $('#modalBg')._flags=['clean']; }
  else {
    const i=fl.indexOf(k);
    if(i>=0) fl.splice(i,1); else { fl.push(k); const ci=fl.indexOf('clean'); if(ci>=0)fl.splice(ci,1); }
    if(!fl.length) fl.push('clean');
  }
  // refresh chips
  $$('#f_flags .chip').forEach(c=>{
    const fk=c.dataset.flag, on=$('#modalBg')._flags.includes(fk);
    c.className='chip'+(on?(fk==='clean'?' on good':' on'):'');
  });
}
function saveTrade(id){
  const flags=$('#modalBg')._flags;
  const realizedR=parseFloat($('#f_realizedR').value);
  const existing=id?DB.trades.find(x=>x.id===id):null;
  const t={
    id:id||uid(),
    dateStart:$('#f_dateStart').value,
    dateEnd:$('#f_dateEnd').value,
    date:$('#f_dateStart').value, // compat: 'date' = fecha inicio (usada por calendario/orden)
    symbol:$('#f_symbol').value.trim().toUpperCase(),
    account:$('#f_account').value,
    phase: $('#f_phase').value || (()=>{ const acc=DB.accounts.find(a=>a.name===$('#f_account').value); return acc? (acc.phase==='Funded'?'funded':'eval') : ''; })(),
    plannedR:parseFloat($('#f_plannedR').value)||0,
    realizedR:isNaN(realizedR)?0:realizedR,
    riskUSD:parseFloat($('#f_riskUSD').value)||0,
    pnl:parseFloat($('#f_pnl').value)|| ((isNaN(realizedR)?0:realizedR)*(parseFloat($('#f_riskUSD').value)||0)),
    result:resultFromR(realizedR)||'be',
    exitType:$('#f_exitType').value,
    result11:existing?.result11||'',
    dolReached:$('#f_dolReached').value,
    dolR:parseFloat($('#f_dolR').value),
    mfe:parseFloat($('#f_mfe').value),
    mae:parseFloat($('#f_mae').value),
    flags:[...flags],
    note:$('#f_note').value.trim(),
    images:[...($('#modalBg')._images||[])],
    planChecked:$$('#f_plan input[type=checkbox]').filter(c=>c.checked).map(c=>+c.dataset.plan)
  };
  if(id){ const i=DB.trades.findIndex(x=>x.id===id); DB.trades[i]=t; }
  else DB.trades.push(t);
  try{
    save();
  }catch(err){
    // localStorage lleno (probablemente por imágenes)
    toast('⚠ Almacenamiento lleno. Quita alguna imagen o exporta y limpia datos antiguos.');
    if(!id) DB.trades.pop();
    return;
  }
  closeModal(); render();
  if(id){ toast('Trade actualizado'); }
  else { showMantra(processMantra(t)); }
}
function deleteTrade(id){
  if(!confirm('¿Eliminar este trade?'))return;
  DB.trades=DB.trades.filter(t=>t.id!==id); save(); closeModal(); render(); toast('Trade eliminado');
}

/* ============================================================
   MODAL — ACCOUNT
   ============================================================ */
function openAccountModal(){ accountModal(); }
function editAccount(id){ accountModal(DB.accounts.find(a=>a.id===id)); }
function accountModal(a){
  const e=a||{};
  const firms=Object.keys(DB.firms||{});
  const curFirm=e.firm||firms[0]||'LucidFlex';
  const plans=DB.firms[curFirm]?Object.keys(DB.firms[curFirm].plans):[];
  const curPlan=e.plan||plans[0]||'';
  $('#modalBg').innerHTML=`<div class="modal">
    <h2>${a?'Editar cuenta':'Nueva cuenta'} <button class="btn ghost sm icon" onclick="closeModal()">✕</button></h2>
    <div class="field"><label>Nombre/alias</label><input id="a_name" value="${e.name||''}" placeholder="${curFirm} ${curPlan} #1"></div>
    <div class="field-row-3">
      <div class="field"><label>Firma</label><select id="a_firm" onchange="acctFirmChange()">
        ${firms.map(f=>`<option ${curFirm===f?'selected':''}>${f}</option>`).join('')}
      </select></div>
      <div class="field"><label>Plan</label><select id="a_plan" onchange="acctPreview()">
        ${plans.map(p=>`<option ${curPlan===p?'selected':''}>${p}</option>`).join('')}
      </select></div>
      <div class="field"><label>Fase</label><select id="a_phase" onchange="acctPreview()">
        ${['Evaluación','Funded'].map(p=>`<option ${e.phase===p?'selected':''}>${p}</option>`).join('')}
      </select></div>
    </div>
    <div class="field"><label>Estado <span class="hint">para la estadística de cuentas</span></label>
      <select id="a_status">
        ${[['en_curso','En curso'],['pasada','Pasada'],['fondeada','Fondeada'],['payout','Con payout'],['perdida','Perdida']].map(([v,l])=>`<option value="${v}" ${(e.status||'en_curso')===v?'selected':''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="calc-out" id="a_preview" style="margin-bottom:14px"></div>
    <div class="hint">¿Falta tu firma o un plan? Ve a <b>Cuentas → Editar reglas</b> para añadirlo. El balance se calcula con tus trades asignados.</div>
    <div class="modal-actions">
      ${a?`<button class="btn danger" onclick="deleteAccount('${a.id}')">Eliminar</button>`:''}
      <button class="btn ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="saveAccount('${a?a.id:''}')">Guardar</button>
    </div>
  </div>`;
  $('#modalBg').classList.add('show');
  acctPreview();
}
function acctFirmChange(){
  const firm=$('#a_firm').value;
  const plans=DB.firms[firm]?Object.keys(DB.firms[firm].plans):[];
  $('#a_plan').innerHTML=plans.map(p=>`<option>${p}</option>`).join('');
  acctPreview();
}
function acctPreview(){
  const firm=$('#a_firm').value, plan=$('#a_plan').value, phase=$('#a_phase').value;
  const s=planSpec(firm,plan,phase);
  if(!s){ $('#a_preview').innerHTML='<p class="hint">Plan sin reglas definidas.</p>'; return; }
  $('#a_preview').innerHTML=`<div class="grid g-2" style="gap:8px">
    <div class="hint">Balance: <b style="color:var(--ink)">${fmt$(s.size)}</b></div>
    <div class="hint">Drawdown (trailing EOD): <b style="color:var(--ink)">${fmt$(s.drawdown)}</b></div>
    ${s.profitTarget?`<div class="hint">Profit target: <b style="color:var(--ink)">${fmt$(s.profitTarget)}</b></div>`:'<div class="hint">Sin profit target (funded)</div>'}
    ${s.dailyLoss?`<div class="hint">Daily loss limit: <b style="color:var(--red)">${fmt$(s.dailyLoss)}</b></div>`:'<div class="hint">Sin daily loss limit</div>'}
    <div class="hint">Máx contratos: <b style="color:var(--ink)">${s.maxMicro} micros / ${s.maxMini} minis</b></div>
    ${s.consistency?`<div class="hint">Consistency: <b style="color:var(--ink)">${s.consistency}%</b></div>`:'<div class="hint">Sin consistency</div>'}
    ${s.minDays?`<div class="hint">Mín. días: <b style="color:var(--ink)">${s.minDays}</b></div>`:''}
  </div>`;
}
function saveAccount(id){
  const firm=$('#a_firm').value, plan=$('#a_plan').value, phase=$('#a_phase').value;
  const s=planSpec(firm,plan,phase);
  if(!s){ toast('Ese plan no tiene reglas definidas'); return; }
  const a={
    id:id||uid(),
    name:$('#a_name').value.trim()||`${firm} ${plan}`,
    firm, plan, phase,
    status:$('#a_status').value,
    size:s.size,
    startBalance:s.size
  };
  if(id){const i=DB.accounts.findIndex(x=>x.id===id);DB.accounts[i]=a;}
  else DB.accounts.push(a);
  save(); closeModal(); render(); toast(id?'Cuenta actualizada':'Cuenta añadida');
}
function deleteAccount(id){
  if(!confirm('¿Eliminar esta cuenta?'))return;
  DB.accounts=DB.accounts.filter(a=>a.id!==id); save(); closeModal(); render(); toast('Cuenta eliminada');
}
// Reajustar el balance de una cuenta a mano (p.ej. tras un payout, el dinero sale de la cuenta)
function adjustBalance(id){
  const a=DB.accounts.find(x=>x.id===id); if(!a) return;
  const allAcctTrades=DB.trades.filter(t=>t.account===a.name);
  const aTrades = a.phase==='Funded'
    ? allAcctTrades.filter(t=>tradePhase(t)==='funded')
    : allAcctTrades;
  const realized=totalPnl(aTrades);
  const currentBalance=(a.startBalance||0)+realized;
  const input=prompt(`Balance actual de "${a.name}": ${fmt$(currentBalance)}\n\nEscribe el NUEVO balance tras el payout (el dinero retirado sale de la cuenta):`, Math.round(currentBalance));
  if(input===null) return;
  const nb=parseFloat(input);
  if(isNaN(nb)||nb<0){ toast('Balance no válido'); return; }
  // ajustamos startBalance para que startBalance + realized = nuevo balance
  a.startBalance = nb - realized;
  save(); render(); toast('Balance reajustado');
}

// ---- Costes y payouts ----
function openCostModal(){ costModal(); }
function editCost(id){ costModal((DB.propCosts||[]).find(c=>c.id===id)); }
function costModal(c){
  const e=c||{};
  const firms=Object.keys(DB.firms||{});
  $('#modalBg').innerHTML=`<div class="modal">
    <h2>${c?'Editar coste':'Nuevo coste'} <button class="btn ghost sm icon" onclick="closeModal()">✕</button></h2>
    <div class="field-row">
      <div class="field"><label>Fecha</label><input type="date" id="c_date" value="${e.date||todayISO()}"></div>
      <div class="field"><label>Importe ($)</label><input type="number" id="c_amount" step="0.01" value="${e.amount??''}" placeholder="ex. 165"></div>
    </div>
    <div class="field"><label>Concepto</label><input id="c_concept" value="${e.concept||''}" placeholder="ex. Eval 50K LucidFlex, reset, activación..."></div>
    <div class="field"><label>Firma <span class="hint">(opcional)</span></label>
      <select id="c_firm"><option value="">—</option>${firms.map(f=>`<option ${e.firm===f?'selected':''}>${f}</option>`).join('')}</select>
    </div>
    <div class="modal-actions">
      ${c?`<button class="btn danger" onclick="deleteCost('${c.id}')">Eliminar</button>`:''}
      <button class="btn ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="saveCost('${c?c.id:''}')">Guardar</button>
    </div>
  </div>`;
  $('#modalBg').classList.add('show');
}
function saveCost(id){
  const amount=parseFloat($('#c_amount').value);
  if(isNaN(amount)||amount<=0){ toast('Pon un importe válido'); return; }
  const c={ id:id||uid(), date:$('#c_date').value||todayISO(), amount, concept:$('#c_concept').value.trim(), firm:$('#c_firm').value };
  DB.propCosts=DB.propCosts||[];
  if(id){const i=DB.propCosts.findIndex(x=>x.id===id);DB.propCosts[i]=c;}
  else DB.propCosts.push(c);
  save(); closeModal(); render(); toast(id?'Coste actualizado':'Coste añadido');
}
function deleteCost(id){
  if(!confirm('¿Eliminar este coste?'))return;
  DB.propCosts=(DB.propCosts||[]).filter(c=>c.id!==id); save(); closeModal(); render(); toast('Coste eliminado');
}
function openPayoutModal(){ payoutModal(); }
function editPayout(id){ payoutModal((DB.payouts||[]).find(p=>p.id===id)); }
function payoutModal(p){
  const e=p||{};
  const firms=Object.keys(DB.firms||{});
  $('#modalBg').innerHTML=`<div class="modal">
    <h2>${p?'Editar payout':'Nuevo payout'} <button class="btn ghost sm icon" onclick="closeModal()">✕</button></h2>
    <div class="field-row">
      <div class="field"><label>Fecha</label><input type="date" id="p_date" value="${e.date||todayISO()}"></div>
      <div class="field"><label>Importe ($)</label><input type="number" id="p_amount" step="0.01" value="${e.amount??''}" placeholder="ex. 1500"></div>
    </div>
    <div class="field"><label>Concepto <span class="hint">(opcional)</span></label><input id="p_concept" value="${e.concept||''}" placeholder="ex. 1er payout Lucid Funded"></div>
    <div class="field"><label>Firma <span class="hint">(opcional)</span></label>
      <select id="p_firm"><option value="">—</option>${firms.map(f=>`<option ${e.firm===f?'selected':''}>${f}</option>`).join('')}</select>
    </div>
    <div class="modal-actions">
      ${p?`<button class="btn danger" onclick="deletePayout('${p.id}')">Eliminar</button>`:''}
      <button class="btn ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="savePayout('${p?p.id:''}')">Guardar</button>
    </div>
  </div>`;
  $('#modalBg').classList.add('show');
}
function savePayout(id){
  const amount=parseFloat($('#p_amount').value);
  if(isNaN(amount)||amount<=0){ toast('Pon un importe válido'); return; }
  const p={ id:id||uid(), date:$('#p_date').value||todayISO(), amount, concept:$('#p_concept').value.trim(), firm:$('#p_firm').value };
  DB.payouts=DB.payouts||[];
  if(id){const i=DB.payouts.findIndex(x=>x.id===id);DB.payouts[i]=p;}
  else DB.payouts.push(p);
  save(); closeModal(); render(); toast(id?'Payout actualizado':'Payout añadido');
}
function deletePayout(id){
  if(!confirm('¿Eliminar este payout?'))return;
  DB.payouts=(DB.payouts||[]).filter(p=>p.id!==id); save(); closeModal(); render(); toast('Payout eliminado');
}

function closeModal(){ $('#modalBg').classList.remove('show'); $('#modalBg').innerHTML=''; }

/* ============================================================
   EDITOR DE REGLAS DE FIRMAS
   ============================================================ */
let FE_FIRM=null, FE_PLAN=null;
function openFirmEditor(){
  const firms=Object.keys(DB.firms||{});
  FE_FIRM=FE_FIRM&&DB.firms[FE_FIRM]?FE_FIRM:firms[0];
  const plans=FE_FIRM?Object.keys(DB.firms[FE_FIRM].plans):[];
  FE_PLAN=FE_PLAN&&plans.includes(FE_PLAN)?FE_PLAN:plans[0];
  $('#modalBg').innerHTML=`<div class="modal" style="max-width:640px">
    <h2>⚙ Editar reglas de firmas <button class="btn ghost sm icon" onclick="closeModal()">✕</button></h2>
    <div class="field-row">
      <div class="field"><label>Firma</label><select id="fe_firm" onchange="feSelectFirm(this.value)">
        ${firms.map(f=>`<option ${FE_FIRM===f?'selected':''}>${f}</option>`).join('')}
      </select></div>
      <div class="field" style="display:flex;align-items:flex-end;gap:8px">
        <button class="btn ghost sm" onclick="feAddFirm()">+ Firma</button>
        ${firms.length>1?`<button class="btn danger sm" onclick="feDeleteFirm()">Borrar firma</button>`:''}
      </div>
    </div>
    ${FE_FIRM?`
    <div class="field-row">
      <div class="field"><label>Plan</label><select id="fe_plan" onchange="feSelectPlan(this.value)">
        ${plans.map(p=>`<option ${FE_PLAN===p?'selected':''}>${p}</option>`).join('')}
      </select></div>
      <div class="field" style="display:flex;align-items:flex-end;gap:8px">
        <button class="btn ghost sm" onclick="feAddPlan()">+ Plan</button>
        ${plans.length>1?`<button class="btn danger sm" onclick="feDeletePlan()">Borrar plan</button>`:''}
      </div>
    </div>
    <div id="fe_planForm">${FE_PLAN?fePlanForm():''}</div>
    `:'<p class="hint">Añade una firma para empezar.</p>'}
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeModal()">Cerrar</button>
      ${FE_PLAN?`<button class="btn primary" onclick="feSavePlan()">Guardar plan</button>`:''}
    </div>
  </div>`;
  $('#modalBg').classList.add('show');
}
function fePlanForm(){
  const p=DB.firms[FE_FIRM].plans[FE_PLAN];
  const trailing=DB.firms[FE_FIRM].trailing||'eod';
  const f=(phase,field,def=0)=> (p[phase]&&p[phase][field]!=null)?p[phase][field]:def;
  const phaseFields=(phase,label)=>`
    <div class="plan-box" style="margin-bottom:12px">
      <div class="plan-title">${label}</div>
      <div class="field-row-3">
        <div class="field"><label>Profit target ($)</label><input type="number" id="fe_${phase}_profitTarget" value="${f(phase,'profitTarget')}"></div>
        <div class="field"><label>Drawdown ($)</label><input type="number" id="fe_${phase}_drawdown" value="${f(phase,'drawdown')}"></div>
        <div class="field"><label>Daily loss ($, 0=no)</label><input type="number" id="fe_${phase}_dailyLoss" value="${f(phase,'dailyLoss')}"></div>
      </div>
      <div class="field-row-3">
        <div class="field"><label>Trail lock ($, 0=no)</label><input type="number" id="fe_${phase}_trailLock" value="${f(phase,'trailLock')}"></div>
        <div class="field"><label>Suelo bloqueado ($)</label><input type="number" id="fe_${phase}_lockedFloor" value="${f(phase,'lockedFloor')}"></div>
        <div class="field"><label>Consistency (%, 0=no)</label><input type="number" id="fe_${phase}_consistency" value="${f(phase,'consistency')}"></div>
      </div>
      <div class="field-row-3">
        <div class="field"><label>Máx micros</label><input type="number" id="fe_${phase}_maxMicro" value="${f(phase,'maxMicro')}"></div>
        <div class="field"><label>Máx minis</label><input type="number" id="fe_${phase}_maxMini" value="${f(phase,'maxMini')}"></div>
        <div class="field"><label>Mín. días</label><input type="number" id="fe_${phase}_minDays" value="${f(phase,'minDays',1)}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Mín. profit/día ($)</label><input type="number" id="fe_${phase}_minDailyProfit" value="${f(phase,'minDailyProfit')}"></div>
        <div class="field"><label>Cap payout ($, 0=no)</label><input type="number" id="fe_${phase}_payoutCap" value="${f(phase,'payoutCap')}"></div>
      </div>
    </div>`;
  return `
    <div class="field"><label>Balance del plan ($)</label><input type="number" id="fe_size" value="${p.size||0}"></div>
    ${phaseFields('eval','FASE EVALUACIÓN')}
    ${phaseFields('funded','FASE FUNDED')}
    <div class="hint">Todas trailing EOD. Deja en 0 lo que no aplique (p.ej. sin daily loss, sin consistency, sin trail lock).</div>
  `;
}
function feSelectFirm(name){ FE_FIRM=name; FE_PLAN=null; openFirmEditor(); }
function feSelectPlan(name){ FE_PLAN=name; openFirmEditor(); }
function feAddFirm(){
  const name=prompt('Nombre de la firma nueva:');
  if(!name) return;
  if(DB.firms[name]){ toast('Ya existe'); return; }
  DB.firms[name]={trailing:'eod',plans:{}};
  FE_FIRM=name; FE_PLAN=null; save(); openFirmEditor();
}
function feDeleteFirm(){
  if(!confirm(`¿Borrar la firma ${FE_FIRM} y todos sus planes?`))return;
  delete DB.firms[FE_FIRM]; FE_FIRM=null; FE_PLAN=null; save(); openFirmEditor();
}
function feAddPlan(){
  const name=prompt('Nombre del plan (ej. 50K, Starter 50K...):');
  if(!name) return;
  if(DB.firms[FE_FIRM].plans[name]){ toast('Ya existe'); return; }
  const blank={profitTarget:0,drawdown:0,trailLock:0,lockedFloor:0,dailyLoss:0,maxMicro:0,maxMini:0,minDays:1,consistency:0,minDailyProfit:0,payoutCap:0};
  DB.firms[FE_FIRM].plans[name]={size:0,eval:structuredClone(blank),funded:structuredClone(blank)};
  FE_PLAN=name; save(); openFirmEditor();
}
function feDeletePlan(){
  if(!confirm(`¿Borrar el plan ${FE_PLAN}?`))return;
  delete DB.firms[FE_FIRM].plans[FE_PLAN]; FE_PLAN=null; save(); openFirmEditor();
}
function feSavePlan(){
  const p=DB.firms[FE_FIRM].plans[FE_PLAN];
  p.size=+$('#fe_size').value||0;
  ['eval','funded'].forEach(phase=>{
    p[phase]=p[phase]||{};
    ['profitTarget','drawdown','dailyLoss','trailLock','lockedFloor','consistency','maxMicro','maxMini','minDays','minDailyProfit','payoutCap'].forEach(field=>{
      p[phase][field]=+$(`#fe_${phase}_${field}`).value||0;
    });
  });
  save(); toast('Plan guardado'); render();
}

/* ============================================================
   IMPORT / EXPORT
   ============================================================ */
function exportData(){
  const blob=new Blob([JSON.stringify(DB,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=`swingdesk-${todayISO()}.json`; a.click();
  URL.revokeObjectURL(url); toast('Datos exportados');
}
function importData(file){
  const r=new FileReader();
  r.onload=()=>{
    try{ const d=JSON.parse(r.result);
      if(d.trades) DB=Object.assign(structuredClone(DEFAULTS),d);
      save(); render(); toast('Datos importados');
    }catch(e){ toast('Archivo inválido'); }
  };
  r.readAsText(file);
}

// Genera un informe de texto limpio (sin imágenes) para pegar en un chat de IA
function buildAIReport(){
  const T=[...DB.trades].sort((a,b)=> a.date<b.date?-1:1);
  const L=[];
  const pct=v=>fmt(v,1)+'%';
  L.push('=== INFORME CRT DESK ===');
  L.push('Fecha de exportación: '+todayISO());
  L.push('Trader: opera futuros intradía con metodología CRT (Candle Range Theory) en prop firms.');
  L.push('');
  // Resumen global
  L.push('--- MÉTRICAS GLOBALES ---');
  L.push(`Total de trades: ${T.length}`);
  L.push(`Expectancy: ${fmtR(expectancy(T))} por trade`);
  L.push(`Win rate: ${pct(winrate(T))}`);
  L.push(`Profit factor: ${profitFactor(T)===Infinity?'∞':fmt(profitFactor(T),2)}`);
  L.push(`R acumulado: ${fmtR(T.reduce((s,t)=>s+(t.realizedR||0),0))}`);
  L.push(`P&L total: ${fmt$(totalPnl(T))}`);
  const st=streaks(T);
  L.push(`Racha actual: ${st.curCount} ${st.curType==='win'?'victorias':st.curType==='loss'?'derrotas':'-'} | Récord victorias: ${st.maxWin} | Récord derrotas: ${st.maxLoss}`);
  L.push('');
  // Métricas separadas por fase (eval vs funded)
  const evalT=T.filter(t=>tradePhase(t)==='eval');
  const fundedT=T.filter(t=>tradePhase(t)==='funded');
  const phaseBlock=(label,arr)=>{
    if(!arr.length) return;
    L.push(`--- MÉTRICAS ${label} (${arr.length} trades) ---`);
    L.push(`Expectancy: ${fmtR(expectancy(arr))} | Win rate: ${pct(winrate(arr))} | Profit factor: ${profitFactor(arr)===Infinity?'∞':fmt(profitFactor(arr),2)}`);
    L.push(`R acumulado: ${fmtR(arr.reduce((s,t)=>s+(t.realizedR||0),0))} | P&L: ${fmt$(totalPnl(arr))}`);
    const c=arr.filter(t=>!(t.flags||[]).some(f=>f!=='clean'));
    L.push(`Disciplina: ${pct(arr.length?c.length/arr.length*100:0)} limpios`);
    L.push('');
  };
  phaseBlock('EVALUACIÓN', evalT);
  phaseBlock('FUNDED', fundedT);
  // Disciplina
  const clean=T.filter(t=>!(t.flags||[]).some(f=>f!=='clean'));
  const dirty=T.filter(t=>(t.flags||[]).some(f=>f!=='clean'));
  L.push('--- DISCIPLINA ---');
  L.push(`Tasa de disciplina: ${pct(T.length?clean.length/T.length*100:0)} (${clean.length} limpios / ${dirty.length} con error)`);
  L.push(`Expectancy trades limpios: ${fmtR(expectancy(clean))} | con error: ${fmtR(expectancy(dirty))}`);
  // errores por tipo
  const flagCount={};
  T.forEach(t=>(t.flags||[]).forEach(f=>{ if(f!=='clean') flagCount[f]=(flagCount[f]||0)+1; }));
  if(Object.keys(flagCount).length){
    L.push('Errores por tipo: '+Object.entries(flagCount).map(([k,n])=>`${FLAG_LABELS[k]||k}: ${n}`).join(', '));
  }
  L.push('');
  // Desgloses
  const bd=(key,label)=>{
    const rows=breakdown(T,key);
    if(!rows.length) return;
    L.push(`Por ${label}:`);
    rows.forEach(r=>L.push(`  - ${r.key}: ${r.n} trades, exp ${fmtR(r.exp)}, WR ${pct(r.wr)}, R acum ${fmtR(r.r)}`));
  };
  L.push('--- RENDIMIENTO POR CATEGORÍA ---');
  bd('session','sesión'); bd('symbol','símbolo'); bd('setup','setup'); bd('weekday','día de la semana');
  L.push('');
  // Origen del movimiento
  const withMove=T.filter(t=>t.moveType);
  if(withMove.length){
    L.push('Origen del movimiento (CRT):');
    const g={}; withMove.forEach(t=>(g[t.moveType]=g[t.moveType]||[]).push(t));
    Object.keys(g).forEach(k=>L.push(`  - ${MOVE_TYPES[k]||k}: ${g[k].length} trades, exp ${fmtR(expectancy(g[k]))}`));
    L.push('');
  }
  // SMT / RS Scalp
  const smt=T.filter(t=>t.smt==='yes'&&t.smtResult);
  if(smt.length){
    const tp=smt.filter(t=>t.smtResult==='tp').length;
    L.push(`RS Scalp (SMT): ${smt.length} señales, ${pct(tp/smt.length*100)} a TP`);
    L.push('');
  }
  // MFE/DOL
  const withDol=T.filter(t=>(t.dolReached==='yes'||t.dolReached==='no')&&t.result!=='loss');
  if(withDol.length){
    const reached=withDol.filter(t=>t.dolReached==='yes').length;
    L.push(`DOL: de ${withDol.length} trades no perdedores, el precio llegó al DOL final el ${pct(reached/withDol.length*100)}`);
    L.push('');
  }
  // Lista de trades
  L.push('--- LISTA DE TRADES ---');
  T.forEach((t,i)=>{
    const parts=[`#${i+1}`, t.date, t.symbol||'', t.session||'', t.setup||''];
    parts.push(`R plan ${t.plannedR??'?'} / R real ${t.realizedR??'?'}`);
    if(!isNaN(t.riskUSD)&&t.riskUSD) parts.push('riesgo $'+t.riskUSD);
    parts.push(t.result==='win'?'GANADOR':t.result==='loss'?'PERDEDOR':'BE');
    if(t.exitType) parts.push('salida:'+t.exitType);
    if(t.account) parts.push('cuenta:'+t.account);
    const ph=tradePhase(t); if(ph) parts.push('fase:'+(ph==='funded'?'FUNDED':'EVAL'));
    if(!isNaN(t.mfe)&&t.mfe!=null) parts.push('MFE '+t.mfe+'R');
    if(!isNaN(t.mae)&&t.mae!=null) parts.push('MAE '+t.mae+'R');
    if(t.dolReached) parts.push('DOL:'+t.dolReached);
    if(!isNaN(t.dolR)&&t.dolR!=null) parts.push('DOL@'+t.dolR+'R');
    if(t.moveType) parts.push('mov:'+(MOVE_TYPES[t.moveType]||t.moveType)+(t.moveOther?' ('+t.moveOther+')':''));
    if(t.smt==='yes') parts.push('SMT:'+t.smtResult+'/'+t.smtTiming);
    const errs=(t.flags||[]).filter(f=>f!=='clean').map(f=>FLAG_LABELS[f]||f);
    if(errs.length) parts.push('FLAGS: '+errs.join('/'));
    else parts.push('limpio');
    L.push(parts.filter(Boolean).join(' | '));
    if(t.note) L.push('   Nota: '+t.note);
  });
  L.push('');
  // No-trades y entradas no ejecutadas
  const nts=DB.noTradeDays||[];
  if(nts.length){
    L.push('--- DÍAS SIN TRADE / ENTRADAS NO EJECUTADAS ---');
    nts.forEach(n=>{
      const tipo=n.type==='unfilled'?'Entrada no ejecutada':'Día sin operar';
      L.push(`${n.date} | ${tipo}${n.reason?' ('+(NOTRADE_REASONS[n.reason]||n.reason)+')':''}${n.note?' — '+n.note:''}`);
    });
    L.push('');
  }
  // ROI de props
  const costs=DB.propCosts||[], payouts=DB.payouts||[];
  if(costs.length||payouts.length||(DB.accounts||[]).length){
    const spent=costs.reduce((s,c)=>s+(c.amount||0),0);
    const collected=payouts.reduce((s,p)=>s+(p.amount||0),0);
    const accts=DB.accounts||[];
    const nPassed=accts.filter(a=>['pasada','fondeada','payout'].includes(a.status)).length;
    const nFunded=accts.filter(a=>['fondeada','payout'].includes(a.status)).length;
    const nPayout=accts.filter(a=>a.status==='payout').length;
    L.push('--- ROI DE PROPS ---');
    L.push(`Gastado en cuentas: ${fmt$(spent)} (${costs.length} costes) | Cobrado en payouts: ${fmt$(collected)} (${payouts.length} payouts)`);
    L.push(`Neto: ${fmt$(collected-spent)}${spent>0?' | ROI: '+fmt((collected-spent)/spent*100,0)+'%':''}`);
    L.push(`Estadística de cuentas: ${accts.length} cuentas | ${nPassed} pasadas${accts.length?' ('+pct(nPassed/accts.length*100)+')':''} | ${nFunded} fondeadas | ${nPayout} con payout`);
    if(payouts.length) L.push(`Payout medio: ${fmt$(collected/payouts.length)}`);
    L.push('');
  }
  return L.join('\n');
}
function exportAIReport(){
  const report=buildAIReport();
  const blob=new Blob([report],{type:'text/plain'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=`swingdesk-informe-${todayISO()}.txt`; a.click();
  URL.revokeObjectURL(url);
  toast('Informe para IA exportado');
}

/* ============================================================
   INIT
   ============================================================ */
function init(){
  $('#tabs').addEventListener('click',e=>{
    const tab=e.target.closest('.tab'); if(!tab)return;
    $$('.tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    CURRENT_TAB=tab.dataset.tab; render();
  });
  $('#addTradeBtn').onclick=openTradeModal;
  $('#noTradeBtn').onclick=()=>openNoTradeModal();
  $('#fab').onclick=openTradeModal;
  $('#exportBtn').onclick=exportData;
  $('#aiReportBtn').onclick=exportAIReport;
  $('#importBtn').onclick=()=>$('#fileInput').click();
  $('#fileInput').onchange=e=>{ if(e.target.files[0]) importData(e.target.files[0]); };
  // Cerrar solo si el clic empieza Y termina en el fondo (no al arrastrar desde un input)
  let _downOnBg=false;
  $('#modalBg').addEventListener('mousedown',e=>{ _downOnBg = (e.target.id==='modalBg'); });
  $('#modalBg').addEventListener('mouseup',e=>{ if(_downOnBg && e.target.id==='modalBg') closeModal(); _downOnBg=false; });
  render();
  // consolidar migraciones (sesiones, cuentas) guardando una vez al arrancar
  try{ save(); }catch(e){}
}
init();
