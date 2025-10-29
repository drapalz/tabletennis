import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = '223543-zHPMwtDqu7Sduj';
const SPORT_ID = 92;
const LEAGUE_ID = 29128;
const LEAGUE_IDS = [22307, 29128];

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(express.static('public'));

async function fetchJSON(url, retries = 5, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`API error ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`⚠️ Fetch selhal (${err.message}), pokus ${attempt}/${retries}, čekám ${delay*attempt}ms...`);
      await new Promise(r => setTimeout(r, delay * attempt));
    }
  }
}

function processMatchData(m) {
  const datum = m.time ? new Date(m.time * 1000).toISOString().split('T')[0] : null;
  const cas = m.time ? new Date(m.time * 1000).toISOString() : null;
  let pocet_setu = null;
  if (m.ss) {
    if (['0-3', '1-3', '2-3', '3-2', '3-1', '3-0'].includes(m.ss)) {
      pocet_setu = Number(m.ss[0]) + Number(m.ss[2]);
    }
  }
  return { datum, cas, pocet_setu };
}

// uložit zápasy do Supabase (tabulka ended)
async function upsertMatchesToDb(matches) {
  const rows = matches.map(m => {
    const { datum, cas, pocet_setu } = processMatchData(m);
    return {
      id: m.id,
      sport_id: m.sport_id ? Number(m.sport_id) : null,
      time: m.time ? Number(m.time) : null,
      league_id: m.league?.id || null,
      league_name: m.league?.name || null,
      home_id: m.home?.id || null,
      home_name: m.home?.name || null,
      away_id: m.away?.id || null,
      away_name: m.away?.name || null,
      ss: m.ss || null,
      pocet_setu,
      datum,
      cas,
      score1_away: m.scores?.[1]?.away || null,
      score1_home: m.scores?.[1]?.home || null,
      score2_away: m.scores?.[2]?.away || null,
      score2_home: m.scores?.[2]?.home || null,
      score3_away: m.scores?.[3]?.away || null,
      score3_home: m.scores?.[3]?.home || null,
      score4_away: m.scores?.[4]?.away || null,
      score4_home: m.scores?.[4]?.home || null,
      score5_away: m.scores?.[5]?.away || null,
      score5_home: m.scores?.[5]?.home || null,
    };
  });
  try {
    const { error } = await supabase
      .from('ended')
      .upsert(rows, { onConflict: ['id'], ignoreDuplicates: true });
    if (error) {
      console.error('❌ Chyba při vkládání zápasů:', error.message);
    } 
  } catch (err) {
    console.error('❌ Neošetřená chyba při vkládání zápasů:', err);
  }
}


async function clearUpcomingTable() {
  const { error } = await supabase.from('upcoming').delete().neq('id', 0);
  if (error) console.error('❌ Chyba při mazání upcoming:', error.message);
  else console.log('🧹 upcoming vyprázdněna');
}

async function upsertMatchesToUpcomingDb(matches) {
  const rows = matches.map(m => {
    const { datum, cas } = processMatchData(m);
    let casWithOffset = null;
    if (cas) {
      const d = new Date(cas);
      d.setHours(d.getHours() + 1);
      casWithOffset = d.toISOString();
    }
    return {
      id: m.id,
      sport_id: m.sport_id ? Number(m.sport_id) : null,
      time: m.time ? Number(m.time) : null,
      league_id: m.league?.id || null,
      league_name: m.league?.name || null,
      home_id: m.home?.id || null,
      home_name: m.home?.name || null,
      away_id: m.away?.id || null,
      away_name: m.away?.name || null,
      datum,
      cas: casWithOffset,
    };
  });
  const { error } = await supabase.from('upcoming').upsert(rows, { onConflict: ['id'] });
  if (error) console.error('❌ Chyba při vkládání upcoming:', error.message);
}

async function fetchMinOddsForEvent(event_id) {
  const url = `https://api.b365api.com/v2/event/odds/summary?token=${TOKEN}&event_id=${event_id}`;
  try {
    const data = await fetchJSON(url);
    if (data.success && data.results?.Bet365?.odds?.end?.["92_1"]) {
      const endOdds = data.results.Bet365.odds.end["92_1"];
      const minHome = endOdds.home_od ? parseFloat(endOdds.home_od) : null;
      const minAway = endOdds.away_od ? parseFloat(endOdds.away_od) : null;
      return { minHome, minAway };
    }
    return { minHome: null, minAway: null };
  } catch (err) {
    console.warn(`Fetch odds failed for ${event_id}:`, err.message);
    return { minHome: null, minAway: null };
  }
}

async function updateOddsForUpcomingMatches(matches) {
  for (const match of matches) {
    const { minHome, minAway } = await fetchMinOddsForEvent(match.id);
    let minValue = null;
    if (minHome !== null && minAway !== null) minValue = Math.min(minHome, minAway);
    else if (minHome !== null) minValue = minHome;
    else if (minAway !== null) minValue = minAway;
    minValue = minValue ?? 99;
    if (minValue !== null) {
      const { error } = await supabase.from('upcoming').update({ kurz: minValue }).eq('id', match.id);
      if (error) console.error(`Chyba při aktualizaci kurzu pro ${match.id}:`, error.message);
    }
  }
}

async function fetchUpcomingMatches(maxPages = 1) {
  await clearUpcomingTable();
  let allMatches = [];

  for (const leagueId of LEAGUE_IDS) {
    for (let page = 1; page <= maxPages; page++) {
      const url = `https://api.b365api.com/v3/events/upcoming?sport_id=${SPORT_ID}&token=${TOKEN}&league_id=${leagueId}&per_page=100&page=${page}`;
      const apiData = await fetchJSON(url);
      const matches = apiData.results || [];
      if (matches.length === 0) break;
      allMatches = allMatches.concat(matches);
      await upsertMatchesToUpcomingDb(matches);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

 const functionsToRun = ['update_upcoming_h2h', 'update_upcoming_30'];
const results = [];

for (const fnName of functionsToRun) {
  try {
    const rpcResult = await supabase.rpc(fnName);
    console.log(`Výsledek volání ${fnName}:`, rpcResult);
    if (rpcResult.error || rpcResult.status >= 400) {
      console.error(`❌ Chyba při spuštění funkce ${fnName}:`, rpcResult.error?.message || 'Neznámá chyba');
      results.push(`❌ Chyba při spuštění funkce ${fnName}: ${rpcResult.error?.message || 'Neznámá chyba'}`);
    } else {
      results.push(`✅ Funkce ${fnName} byla spuštěna úspěšně.`);
    }
  } catch (err) {
    console.error(`❌ Výjimka při volání funkce ${fnName}:`, err.message);
    results.push(`❌ Výjimka při volání funkce ${fnName}: ${err.message}`);
  }
}



  console.log(`✅ Načteno ${allMatches.length} upcoming zápasů`);
  return allMatches;
}

async function fetchAllMatches(maxPages = 8, startPage = 1, leagueId) {
  let allMatches = [];
  for (let page = startPage; page <= maxPages; page++) {
    const url = `https://api.b365api.com/v3/events/ended?sport_id=${SPORT_ID}&token=${TOKEN}&league_id=${leagueId}&per_page=100&page=${page}`;
    const apiData = await fetchJSON(url);
    const matches = apiData.results || [];
    if (matches.length === 0) break;
    allMatches = allMatches.concat(matches);
    await upsertMatchesToDb(matches);
    await new Promise(r => setTimeout(r, 1000));
  }
  return allMatches;
}


// Endpoints

app.get('/matches', async (req, res) => {
  try {
    let totalMatches = 0;
    for (const leagueId of LEAGUE_IDS) {
      console.log(`Fetching matches for league ${leagueId}...`);
      const matches = await fetchAllMatches(8, 1, leagueId);
      totalMatches += matches.length;
    }
    console.log(`Načteno celkem ${totalMatches} zápasů pro všechny ligy.`);
    res.json({ total: totalMatches });
  } catch (err) {
    console.error('Error in /matches:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/upcoming', async (req, res) => {
  try {
    const matches = await fetchUpcomingMatches(1);

    const functionsToRun = ['update_upcoming_h2h', 'update_upcoming_30'];
    const results = [];

    for (const fnName of functionsToRun) {
      const rpcResult = await supabase.rpc(fnName);
      if (rpcResult.error || rpcResult.status >= 400) {
        results.push(`❌ Chyba při spuštění funkce ${fnName}: ${rpcResult.error?.message}`);
      } else {
        results.push(`✅ Funkce ${fnName} byla spuštěna úspěšně.`);
      }
    }

    res.json({ total: matches.length, messages: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



app.get('/update-odds', async (req, res) => {
  try {
    const { data, error } = await supabase.from('upcoming').select('*');
    if (error) throw error;
    await updateOddsForUpcomingMatches(data);
    res.json({ message: 'Kurzy aktualizovány', updatedCount: data.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/max-ended-time', async (req, res) => {
  try {
    const { data, error } = await supabase.from('ended').select('time').order('time', { ascending: false }).limit(1);
    if (error) return res.status(500).json({ error: error.message });
    if (!data.length) return res.json({ maxTimeISO: null });
    const maxTimeISO = new Date(data[0].time * 1000).toISOString();
    res.json({ maxTimeISO });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/filter-upcoming', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('upcoming')
      .select('home_name, away_name, cas, h2h_100, "35_100", "45_100", h2h_300, "35_300", "45_300", chyba_poctu, kurz')
      .order('cas', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/filter-3-0', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('upcoming')
      .select('home_name, away_name, league_name, cas, h2h_30,h2h_100, h2h_300, home_30, home_100, home_300, away_30, away_100, away_300, chyba_poctu, kurz, kurz_min_30')
      .order('cas', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    // Nenastavovat a nespouštět žádné backendové funkce zde
    res.json({ matches: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Server běží na portu ${PORT}`);
});

// Middleware pro zpracování 404 - nenalezená cesta
app.use((req, res, next) => {
  res.status(404).json({ error: 'Not Found' });
});

// Middleware pro zpracování ostatních chyb
app.use((err, req, res, next) => {
  console.error('Chyba:', err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});
