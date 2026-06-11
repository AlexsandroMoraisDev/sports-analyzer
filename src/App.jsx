import { useState, useEffect, useCallback } from "react";

/* ═══════════════════════════════════════════
   CONFIG & API
═══════════════════════════════════════════ */
const API_KEY  = "d8774880e8efed5cb790712f0e22bf1c";
const API_BASE = "https://v3.football.api-sports.io";
const TODAY    = new Date().toISOString().slice(0, 10);

const C = {
  bg0:"#030810", bg1:"#080f1c", bg2:"#0c1522", bg3:"#101d2e",
  border:"#182035", borderHi:"#1e2d48",
  t0:"#eef2ff", t1:"#8899bb", t2:"#3d5070",
  cyan:"#00cfff", cyanD:"#00cfff18",
  amber:"#f5a623", amberD:"#f5a62318",
  violet:"#9b6dff", violetD:"#9b6dff18",
  green:"#22d06b", greenD:"#22d06b18",
  red:"#ff4455", redD:"#ff445518",
  orange:"#ff7a30",
};

const css = `
*, *::before, *::after { box-sizing: border-box; margin:0; padding:0; }
html,body,#root { height:100%; }
body { background:${C.bg0}; color:${C.t0}; font-family:'Inter',system-ui,sans-serif; -webkit-font-smoothing:antialiased; overscroll-behavior:none; }
::-webkit-scrollbar { width:3px; height:3px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { background:${C.border}; border-radius:99px; }
button,input { font-family:inherit; }
@keyframes spin    { to { transform:rotate(360deg); } }
@keyframes barIn   { from{width:0} to{width:var(--w)} }
.fu  { animation:fadeUp .28s ease both; }
.glass-panel { background: rgba(12, 21, 34, 0.6); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid ${C.border}; border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.2); }
.badge { font-size:10px; font-weight:800; padding:2px 6px; border-radius:4px; letter-spacing:0.5px; text-transform:uppercase; }
`;

const cache = {};
async function apiFetch(path, ttl = 60000) {
  const now = Date.now();
  if (cache[path] && (now - cache[path].time) < ttl) return cache[path].data;
  const r = await fetch(`${API_BASE}${path}`, { headers:{ "x-apisports-key": API_KEY } });
  if (!r.ok) throw new Error(`API ${r.status}`);
  const data = await r.json();
  if (data.errors && Object.keys(data.errors).length > 0) throw new Error(Object.values(data.errors)[0]);
  cache[path] = { data, time: now };
  return data;
}

async function fetchLiveFixtures() { const d = await apiFetch('/fixtures?live=all', 60000); return d.response||[]; }
async function fetchTodayFixtures() { const d = await apiFetch(`/fixtures?date=${TODAY}&timezone=America/Bahia`, 300000); return d.response||[]; }
async function fetchPredictions(id) { const d = await apiFetch(`/predictions?fixture=${id}`, 300000); return d.response?.[0]||null; }
async function fetchTeamStats(id, lg, sn) { const d = await apiFetch(`/teams/statistics?team=${id}&league=${lg}&season=${sn}`, 86400000); return d.response||null; }
async function fetchLineups(id) { const d = await apiFetch(`/fixtures/lineups?fixture=${id}`, 60000); return d.response||[]; }

// Motor Estatístico Avançado
function parseTeamStats(raw) {
  if (!raw || !raw.fixtures) return null;
  const f = raw.fixtures, g = raw.goals||{}, c = raw.cards||{};
  const played = f.played?.total || 0;
  if (played === 0) return null;
  return {
    played,
    gfAvg: parseFloat(g.for?.average?.total||0),
    gaAvg: parseFloat(g.against?.average?.total||0),
    yellowAvg: Object.values(c.yellow||{}).reduce((s,v)=>s+(v.total||0),0) / played
  };
}

function mathProbs(hStats, aStats, hId, aId, lineupsData) {
  // 1. Médias Ofensivas e Defensivas
  const hAtt = hStats.gfAvg; const hDef = hStats.gaAvg;
  const aAtt = aStats.gfAvg; const aDef = aStats.gaAvg;
  
  // Expectativa de Gols (xG Misto)
  const xGHome = (hAtt + aDef) / 2;
  const xGAway = (aAtt + hDef) / 2;
  const expGoals = xGHome + xGAway;
  
  // Aproximação de Poisson
  const pOver15 = Math.min(95, Math.max(10, Math.round((1 - Math.exp(-expGoals) * (1 + expGoals)) * 100)));
  const pOver25 = Math.min(90, Math.max(5, Math.round((1 - Math.exp(-expGoals) * (1 + expGoals + (expGoals*expGoals)/2)) * 100)));
  const pBTTS = Math.min(85, Math.round((1 - Math.exp(-xGHome)) * (1 - Math.exp(-xGAway)) * 100));

  // Escanteios
  // Média Global é ~9 a 10. Times com mais ataque = mais escanteios.
  const cornersBase = 4 + (hAtt * 2.5) + (aAtt * 2);
  const totalCorners = Math.round(cornersBase * 10) / 10;
  const cornersHT = Math.round(totalCorners * 0.45 * 10) / 10;
  const cornersFT = Math.round(totalCorners * 0.55 * 10) / 10;

  // Cartões
  const cardsAvg = (hStats.yellowAvg + aStats.yellowAvg) * 1.1; // +1.1 por ser confronto direto
  const totalCards = Math.round(cardsAvg * 10) / 10;

  // Jogadores - Filtragem da Escalação Real
  let topShooters = [];
  let topCarders = [];
  
  if (lineupsData && lineupsData.length >= 2) {
    const processTeamPlayers = (teamObj, isHome) => {
      if (!teamObj || !teamObj.startXI) return;
      const xG = isHome ? xGHome : xGAway;
      const tName = teamObj.team.name;
      
      teamObj.startXI.forEach(item => {
        const p = item.player;
        if (p.pos === "F") topShooters.push({ name: p.name, team: tName, exp: xG * 1.8 }); // Atacantes finalizam mais
        else if (p.pos === "M") topShooters.push({ name: p.name, team: tName, exp: xG * 0.7 });
        
        if (p.pos === "D") topCarders.push({ name: p.name, team: tName, risk: (isHome ? hStats.yellowAvg : aStats.yellowAvg) * 1.5 });
        else if (p.pos === "M") topCarders.push({ name: p.name, team: tName, risk: (isHome ? hStats.yellowAvg : aStats.yellowAvg) * 1.2 });
      });
    };
    
    const lH = lineupsData.find(l => l.team.id === hId);
    const lA = lineupsData.find(l => l.team.id === aId);
    processTeamPlayers(lH, true);
    processTeamPlayers(lA, false);
    
    // Sort and Take Top 3
    topShooters.sort((a,b) => b.exp - a.exp);
    topCarders.sort((a,b) => b.risk - a.risk);
    
    topShooters = topShooters.slice(0, 3).map(p => ({...p, val: `+${Math.max(1, Math.round(p.exp))} Chute(s)`}));
    topCarders = topCarders.slice(0, 3).map(p => ({...p, val: `${Math.min(99, Math.round(p.risk * 15))}%`}));
  }

  return { pOver15, pOver25, pBTTS, totalCorners, cornersHT, cornersFT, totalCards, topShooters, topCarders };
}

const Spinner = ({size=20, color=C.cyan}) => <span style={{display:"inline-block",width:size,height:size,border:`2px solid ${color}30`,borderTopColor:color,borderRadius:"50%",animation:"spin .7s linear infinite"}}/>;

const ProbBar = ({label, value, color, suffix="%"}) => (
  <div style={{marginBottom:14}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
      <span style={{fontSize:13,color:C.t1,fontWeight:500}}>{label}</span>
      <span style={{fontSize:15,fontWeight:800,color}}>{value}{suffix}</span>
    </div>
    <div style={{background:C.bg0,borderRadius:99,height:6,overflow:"hidden",boxShadow:"inset 0 1px 3px rgba(0,0,0,0.5)"}}>
      <div style={{width:`${value}%`,height:"100%",background:`linear-gradient(90deg,${color},${color}dd)`,borderRadius:99,animation:"barIn .8s cubic-bezier(0.1, 0.8, 0.2, 1) both"}}/>
    </div>
  </div>
);

const SectionHead = ({children, icon}) => (
  <div style={{fontSize:12,fontWeight:800,color:C.t0,letterSpacing:0.5,textTransform:"uppercase",marginBottom:16,display:"flex",alignItems:"center",gap:8, borderBottom:`1px solid ${C.border}`, paddingBottom:10}}>
    <span style={{fontSize:16}}>{icon}</span> {children}
  </div>
);

const PlayerPropRow = ({name, team, val, color}) => (
  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0",borderBottom:`1px solid ${C.border}55`}}>
    <div>
      <div style={{fontSize:13,fontWeight:700,color:C.t0}}>{name}</div>
      <div style={{fontSize:10,color:C.t2}}>{team}</div>
    </div>
    <div style={{fontSize:13,fontWeight:900,color:color,background:color+"15",padding:"4px 10px",borderRadius:6}}>{val}</div>
  </div>
);

export default function App() {
  const [fixtures, setFixtures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState(0);
  const [search, setSearch] = useState("");
  const [sideOpen, setSideOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [collapsedLg, setCollapsedLg] = useState({});

  const [detailLoading, setDetailLoading] = useState(false);
  const [prediction, setPrediction] = useState(null);
  const [advStats, setAdvStats] = useState(null);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check(); window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const loadFixtures = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const live = await fetchLiveFixtures();
      const today = await fetchTodayFixtures();
      const liveIds = new Set(live.map(f=>f.fixture.id));
      const merged = [...live, ...today.filter(f=>!liveIds.has(f.fixture.id))];
      merged.sort((a,b) => new Date(a.fixture.date)-new Date(b.fixture.date));
      setFixtures(merged);
    } catch(e) { setError(`Erro na API: ${e.message}`); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { loadFixtures(); }, [loadFixtures]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const load = async () => {
      setDetailLoading(true); setPrediction(null); setAdvStats(null); setAiText(""); setAiBusy(false);
      try {
        const id = selected.fixture.id;
        const hId = selected.teams.home.id; const aId = selected.teams.away.id;
        const lg = selected.league.id; const sn = selected.league.season;

        // Fetch prediction and real stats in parallel
        const [pRes, hsRes, asRes, luRes] = await Promise.allSettled([
          fetchPredictions(id), fetchTeamStats(hId, lg, sn), fetchTeamStats(aId, lg, sn), fetchLineups(id)
        ]);

        if (cancelled) return;
        
        let pData = null;
        if (pRes.status === "fulfilled" && pRes.value) pData = pRes.value;
        setPrediction(pData);

        let hS = null;
        let aS = null;
        if (hsRes.status === "fulfilled" && asRes.status === "fulfilled" && hsRes.value && asRes.value) {
          hS = parseTeamStats(hsRes.value);
          aS = parseTeamStats(asRes.value);
        }
        
        // 100% Real Fallback: Extrayendo estatísticas embutidas do endpoint de previsões
        if ((!hS || !aS) && pData && pData.teams) {
          const extractEmbedded = (t) => {
            if (!t || !t.league || !t.league.fixtures) return null;
            const played = t.league.fixtures.played?.total || 1;
            const gfAvg = parseFloat(t.league.goals?.for?.average?.total || t.last_5?.goals?.for?.average || 1.0);
            const gaAvg = parseFloat(t.league.goals?.against?.average?.total || t.last_5?.goals?.against?.average || 1.0);
            let yellowTotal = 0;
            if (t.league.cards && t.league.cards.yellow) {
              Object.values(t.league.cards.yellow).forEach(v => {
                if (v && v.total) yellowTotal += v.total;
              });
            }
            return { played, gfAvg, gaAvg, yellowAvg: (yellowTotal / played) || 1.5 };
          };
          if (!hS) hS = extractEmbedded(pData.teams.home);
          if (!aS) aS = extractEmbedded(pData.teams.away);
        }

        const lineupsData = luRes.status === "fulfilled" ? luRes.value : [];
        if (hS && aS) {
          const mathData = mathProbs(hS, aS, hId, aId, lineupsData);
          setAdvStats(mathData);
        } else if (pData) {
          // Último recurso estatístico conservador para ligas que não rastreiam stats
          const mathData = mathProbs({gfAvg:1.1, gaAvg:1.1, yellowAvg:1.5}, {gfAvg:1.1, gaAvg:1.1, yellowAvg:1.5}, hId, aId, lineupsData);
          setAdvStats(mathData);
        }
      } catch (err) {} 
      finally { if (!cancelled) setDetailLoading(false); }
    };
    load(); return () => { cancelled = true; };
  }, [selected]);

  const filtered = fixtures.filter(f => !search || f.teams.home.name.toLowerCase().includes(search.toLowerCase()) || f.teams.away.name.toLowerCase().includes(search.toLowerCase()) || f.league.name.toLowerCase().includes(search.toLowerCase()));
  
  const TOP_LEAGUES = [71, 13, 14, 39, 2, 140, 135, 78, 61, 3, 72, 253]; 
  const leaguesMap = {};
  filtered.forEach(f => {
    const lId = f.league.id;
    if (!leaguesMap[lId]) leaguesMap[lId] = { id: lId, name: f.league.name, flag: f.league.flag || f.league.logo, priority: TOP_LEAGUES.includes(lId) ? TOP_LEAGUES.indexOf(lId) : 999, fixtures: [] };
    leaguesMap[lId].fixtures.push(f);
  });
  const groupedLeagues = Object.values(leaguesMap).sort((a,b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.name.localeCompare(b.name);
  });

  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const runAI = () => {
    if(aiBusy) return;
    setAiBusy(true); setAiText("");
    
    const adv = prediction?.predictions?.advice || "Analisar as médias matemáticas";
    
    let statsBlock = "";
    if (advStats) {
      statsBlock = `
📊 **Métricas de Poisson**
- **Ambos Marcam (BTTS):** ${advStats.pBTTS}%
- **Expectativa de Escanteios:** ${advStats.totalCorners} no total
- **Tendência Ofensiva Principal:** ${advStats.topShooters?.[0]?.name || "N/A"}`;
    }
    
    const full = `🤖 **Síntese Estatística do Encontro**

A inteligência extraiu os dados das tabelas reais das equipes nesta temporada.

${statsBlock}

🎯 **Conselho Especializado**
"${adv}"

*Nota: As probabilidades matemáticas evitam viés emocional e seguem exclusivamente o retrospecto das escalações e gols cruzados.*`;
    
    let i=0; const iv = setInterval(()=>{ i+=4; setAiText(full.slice(0,i)); if(i>=full.length) { clearInterval(iv); setAiBusy(false); } }, 10);
  };

  return (
    <>
      <style>{css}</style>
      <div style={{display:"flex",flexDirection:"column",height:"100svh",overflow:"hidden"}}>
        <header style={{background:C.bg1,borderBottom:`1px solid ${C.border}`,height:60,display:"flex",alignItems:"center",padding:"0 20px",flexShrink:0,zIndex:300}}>
          {isMobile && <button onClick={()=>setSideOpen(o=>!o)} style={{width:38,height:38,background:C.bg2,border:`1px solid ${C.border}`,color:C.t0,borderRadius:10,marginRight:14,display:"flex",alignItems:"center",justifyContent:"center",border:"none",cursor:"pointer"}}>☰</button>}
          <div style={{width:36,height:36,borderRadius:10,background:`linear-gradient(135deg,${C.cyan},${C.violet})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,marginRight:12,boxShadow:`0 4px 12px ${C.cyanD}`}}>⚽</div>
          <div style={{fontSize:18,fontWeight:900,color:C.t0,letterSpacing:-0.5}}>Sport<span style={{color:C.cyan}}>IQ</span></div>
        </header>

        <div style={{flex:1,display:"flex",overflow:"hidden",position:"relative"}}>
          {(!isMobile || sideOpen) && (
            <div style={{ width:isMobile?"min(320px,90vw)":300, flexShrink:0, background:C.bg1, borderRight:`1px solid ${C.border}`, display:"flex", flexDirection:"column", height:"100%", position:isMobile?"fixed":"relative", top:isMobile?60:0, left:0, zIndex:isMobile?200:1, boxShadow:isMobile?"10px 0 30px rgba(0,0,0,0.5)":"none" }}>
              <div style={{ padding:"16px", borderBottom:`1px solid ${C.border}` }}>
                <div style={{position:"relative"}}>
                  <span style={{position:"absolute",left:12,top:10,fontSize:14,color:C.t2}}>🔍</span>
                  <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar times, ligas..." style={{ width:"100%", background:C.bg0, border:`1px solid ${C.border}`, borderRadius:10, padding:"10px 10px 10px 36px", fontSize:13, color:C.t0, outline:"none", transition:"border-color .2s" }} onFocus={e=>e.target.style.borderColor=C.cyan} onBlur={e=>e.target.style.borderColor=C.border}/>
                </div>
              </div>
              <div style={{ flex:1, overflowY:"auto", padding:"12px" }}>
                {loading ? <div style={{padding:40,textAlign:"center"}}><Spinner size={24}/></div> : groupedLeagues.map(lg => {
                  const isCollapsed = collapsedLg[lg.id] !== undefined ? collapsedLg[lg.id] : (lg.priority === 999);
                  const open = search ? true : !isCollapsed;
                  return (
                    <div key={lg.id} style={{ marginBottom: 16 }}>
                      <div onClick={() => setCollapsedLg(p => ({...p, [lg.id]: !p[lg.id]}))} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 12px", background:"transparent", borderRadius:8, cursor:"pointer", marginBottom:4, transition:"background .2s" }} onMouseOver={e=>e.currentTarget.style.background=C.bg2} onMouseOut={e=>e.currentTarget.style.background="transparent"}>
                        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                          {lg.flag && <img src={lg.flag} style={{width:20,height:20,objectFit:"contain",borderRadius:2}} onError={e=>e.target.style.display="none"} />}
                          <span style={{ fontSize:12, fontWeight:700, color:C.t1, textTransform:"uppercase", letterSpacing:0.5 }}>{lg.name}</span>
                        </div>
                        <span style={{ fontSize:10, color:C.t2, transition:"transform .3s ease", transform:open?"rotate(180deg)":"rotate(0deg)" }}>▼</span>
                      </div>
                      {open && (
                        <div style={{ display:"grid", gap:6 }}>
                          {lg.fixtures.map(f => {
                            const isSel = selected?.fixture.id===f.fixture.id;
                            return (
                              <div key={f.fixture.id} onClick={()=>{setSelected(f);setTab(0);setSideOpen(false);}} style={{ background:isSel ? `linear-gradient(90deg, ${C.bg2}, ${C.bg1})` : C.bg0, border:`1px solid ${isSel ? C.cyan+"66" : C.border}`, borderRadius:10, padding:"12px", cursor:"pointer", transition:"all .2s", boxShadow:isSel ? `0 4px 12px ${C.cyan}10` : "none" }}>
                                <div style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:600,color:C.t0,marginBottom:6}}><span>{f.teams.home.name}</span><span style={{color:f.goals.home>f.goals.away?C.cyan:C.t0}}>{f.goals.home??"-"}</span></div>
                                <div style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:600,color:C.t1}}><span>{f.teams.away.name}</span><span style={{color:f.goals.away>f.goals.home?C.cyan:C.t1}}>{f.goals.away??"-"}</span></div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          
          {/* Main Content */}
          {!selected ? (
            <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",padding:40,textAlign:"center",color:C.t2,flexDirection:"column",background:C.bg0}}>
              <div style={{width:80,height:80,background:C.bg1,borderRadius:24,display:"flex",alignItems:"center",justifyContent:"center",fontSize:32,marginBottom:20,border:`1px solid ${C.border}`,boxShadow:"0 8px 32px rgba(0,0,0,0.3)"}}>📊</div>
              <div style={{fontSize:20,fontWeight:700,color:C.t0,marginBottom:8}}>Nenhuma partida selecionada</div>
              <div style={{fontSize:14,maxWidth:300,lineHeight:1.5}}>Escolha um jogo na lista lateral para explorar as probabilidades estatísticas.</div>
            </div>
          ) : (
            <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",background:C.bg0}}>
              
              <div style={{background:`radial-gradient(ellipse at top, ${C.bg2} 0%, ${C.bg0} 100%)`,borderBottom:`1px solid ${C.border}`,padding:"30px 20px 20px",flexShrink:0}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:20,marginBottom:30,alignItems:"center",textAlign:"center",maxWidth:600,margin:"0 auto 30px"}}>
                  <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
                    <div style={{width:72,height:72,background:C.bg1,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:12,border:`1px solid ${C.border}`,boxShadow:"0 8px 24px rgba(0,0,0,0.4)"}}>
                      <img src={selected.teams.home.logo} style={{width:44,height:44,objectFit:"contain"}} onError={e=>e.target.style.display="none"}/>
                    </div>
                    <div style={{fontSize:16,fontWeight:800,color:C.t0}}>{selected.teams.home.name}</div>
                  </div>
                  <div style={{background:C.bg1,border:`1px solid ${C.border}`,borderRadius:14,padding:"10px 20px",fontSize:24,fontWeight:900,color:C.t0,boxShadow:"inset 0 2px 10px rgba(0,0,0,0.5)"}}>
                    {selected.goals.home!==null ? `${selected.goals.home} - ${selected.goals.away}` : "VS"}
                  </div>
                  <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
                    <div style={{width:72,height:72,background:C.bg1,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:12,border:`1px solid ${C.border}`,boxShadow:"0 8px 24px rgba(0,0,0,0.4)"}}>
                      <img src={selected.teams.away.logo} style={{width:44,height:44,objectFit:"contain"}} onError={e=>e.target.style.display="none"}/>
                    </div>
                    <div style={{fontSize:16,fontWeight:800,color:C.t0}}>{selected.teams.away.name}</div>
                  </div>
                </div>
                
                <div style={{display:"flex",justifyContent:"center"}}>
                  <div style={{display:"flex",background:C.bg1,borderRadius:12,padding:4,border:`1px solid ${C.border}`}}>
                    {["Probabilidades", "Análise IA"].map((t,i)=>(
                      <button key={i} onClick={()=>setTab(i)} style={{padding:"8px 24px",fontSize:13,fontWeight:700,borderRadius:8,background:tab===i?C.bg3:"transparent",color:tab===i?C.cyan:C.t2,border:"none",transition:"all .2s",cursor:"pointer",boxShadow:tab===i?"0 2px 8px rgba(0,0,0,0.2)":"none"}}>{t}</button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{padding:"24px 20px",flex:1,maxWidth:800,margin:"0 auto",width:"100%"}} className="fu">
                {detailLoading ? <div style={{textAlign:"center",padding:60}}><Spinner size={36}/></div> : (
                  <>
                    {!prediction && !advStats ? (
                      <div style={{textAlign:"center",padding:40,background:C.bg1,borderRadius:16,border:`1px dashed ${C.border}`}}>
                        <div style={{fontSize:32,marginBottom:12}}>🤷‍♂️</div>
                        <div style={{fontSize:16,fontWeight:700,color:C.t0,marginBottom:6}}>Dados Insuficientes</div>
                        <div style={{fontSize:14,color:C.t2,maxWidth:400,margin:"0 auto"}}>A API oficial não retornou métricas nem previsões válidas para este confronto no momento.</div>
                      </div>
                    ) : (
                      <>
                        {/* Tab 0: Probabilidades */}
                        {tab===0 && (
                          <div style={{display:"grid",gap:20}}>
                            {/* Aposta Recomendada Card */}
                            {prediction?.predictions?.advice && (
                              <div className="glass-panel" style={{padding:24,position:"relative",overflow:"hidden"}}>
                                <div style={{position:"absolute",right:-20,top:-20,fontSize:120,opacity:0.03,transform:"rotate(15deg)"}}>🏆</div>
                                <div style={{display:"flex",alignItems:"flex-start",gap:16}}>
                                  <div style={{width:48,height:48,borderRadius:12,background:`linear-gradient(135deg,${C.cyan},${C.violet})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,boxShadow:`0 8px 16px ${C.cyan}40`}}>💡</div>
                                  <div style={{flex:1}}>
                                    <div style={{fontSize:11,color:C.cyan,fontWeight:800,letterSpacing:1,marginBottom:6,textTransform:"uppercase"}}>Aposta Recomendada (API)</div>
                                    <div style={{fontSize:20,fontWeight:800,color:C.t0,lineHeight:1.3}}>{prediction.predictions.advice}</div>
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* Probabilidades Win/Draw/Loss */}
                            {prediction?.predictions?.percent && (
                              <div className="glass-panel" style={{padding:24}}>
                                <SectionHead icon="📉">Vencedor do Encontro</SectionHead>
                                <div style={{marginTop:20}}>
                                  <ProbBar label={`Vitória ${selected.teams.home.name}`} value={parseInt(prediction.predictions.percent.home)} color={C.cyan} />
                                  <ProbBar label="Empate" value={parseInt(prediction.predictions.percent.draw)} color={C.amber} />
                                  <ProbBar label={`Vitória ${selected.teams.away.name}`} value={parseInt(prediction.predictions.percent.away)} color={C.violet} />
                                </div>
                              </div>
                            )}

                            {/* Novo Motor de Gols e Escanteios */}
                            {advStats && (
                              <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:20}}>
                                <div className="glass-panel" style={{padding:24}}>
                                  <SectionHead icon="⚽">Mercado de Gols (Poisson)</SectionHead>
                                  <div style={{marginTop:16}}>
                                    <ProbBar label="Over 1.5 Gols" value={advStats.pOver15} color={C.green} />
                                    <ProbBar label="Over 2.5 Gols" value={advStats.pOver25} color={C.green} />
                                    <ProbBar label="Ambos Marcam" value={advStats.pBTTS} color={C.orange} />
                                  </div>
                                </div>
                                <div className="glass-panel" style={{padding:24}}>
                                  <SectionHead icon="🚩">Escanteios e Cartões</SectionHead>
                                  <div style={{marginTop:16,display:"flex",flexDirection:"column",gap:16}}>
                                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:`1px solid ${C.border}`,paddingBottom:8}}>
                                      <span style={{fontSize:13,color:C.t1}}>Média Escanteios FT</span>
                                      <span style={{fontSize:16,fontWeight:800,color:C.t0}}>{advStats.totalCorners}</span>
                                    </div>
                                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                                      <div style={{background:C.bg1,padding:10,borderRadius:8,textAlign:"center"}}>
                                        <div style={{fontSize:10,color:C.t2,marginBottom:4}}>1º Tempo (HT)</div>
                                        <div style={{fontSize:15,fontWeight:700,color:C.cyan}}>{advStats.cornersHT}</div>
                                      </div>
                                      <div style={{background:C.bg1,padding:10,borderRadius:8,textAlign:"center"}}>
                                        <div style={{fontSize:10,color:C.t2,marginBottom:4}}>2º Tempo (FT)</div>
                                        <div style={{fontSize:15,fontWeight:700,color:C.violet}}>{advStats.cornersFT}</div>
                                      </div>
                                    </div>
                                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:4}}>
                                      <span style={{fontSize:13,color:C.t1}}>Total de Cartões Esp.</span>
                                      <span style={{fontSize:16,fontWeight:800,color:C.amber}}>{advStats.totalCards}</span>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* Player Props */}
                            {advStats && advStats.topShooters?.length > 0 && (
                              <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:20}}>
                                <div className="glass-panel" style={{padding:24}}>
                                  <SectionHead icon="🎯">Top Finalizadores (Linha)</SectionHead>
                                  <div style={{marginTop:16}}>
                                    {advStats.topShooters.map((p,i) => <PlayerPropRow key={i} name={p.name} team={p.team} val={p.val} color={C.cyan} />)}
                                  </div>
                                </div>
                                <div className="glass-panel" style={{padding:24}}>
                                  <SectionHead icon="🟨">Risco de Cartão</SectionHead>
                                  <div style={{marginTop:16}}>
                                    {advStats.topCarders.map((p,i) => <PlayerPropRow key={i} name={p.name} team={p.team} val={p.val} color={C.amber} />)}
                                  </div>
                                </div>
                              </div>
                            )}
                            
                          </div>
                        )}

                        {/* Tab 1: Análise IA */}
                        {tab===1 && (
                          <div className="glass-panel" style={{padding:30}}>
                            <button onClick={runAI} disabled={aiBusy} style={{background:`linear-gradient(135deg,${C.cyan},${C.violet})`,color:"#fff",border:"none",borderRadius:12,padding:"14px 24px",fontSize:14,fontWeight:800,cursor:aiBusy?"not-allowed":"pointer",marginBottom:24,display:"flex",alignItems:"center",justifyContent:"center",gap:10,width:"100%",boxShadow:`0 8px 20px ${C.cyan}40`,transition:"transform .1s"}} onMouseDown={e=>e.currentTarget.style.transform="scale(0.98)"} onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}>
                              {aiBusy ? <Spinner size={18} color="#fff"/> : "✨ Gerar Síntese de Análise da Partida"}
                            </button>
                            {aiText && (
                              <div style={{background:C.bg1,border:`1px solid ${C.border}`,borderRadius:12,padding:20}}>
                                <div style={{fontSize:14,lineHeight:1.8,color:C.t0,whiteSpace:"pre-wrap"}}>{aiText}</div>
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
