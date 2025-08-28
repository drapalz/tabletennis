import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = '223543-zHPMwtDqu7Sduj'; // Tvůj API token
const SPORT_ID = 92;
const LEAGUE_ID = 22307;

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(express.static('public'));

// fetch s retry
async function fetchJSON(url, retries = 5, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`API error ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`⚠️ Fetch selhal (${err.message}), pokus ${attempt}/${retries}, čekám ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay * attempt));
    }
  }
}

// spočítat datum, čas a počet setů
function processMatchData(m) {
  const datum = m.time ? new Date(m.time * 1000).toISOString().split('T')[0] : null;
  const cas = m.time ? new Date(m.time * 1000).toISOString() : null;
  let pocet_setu = null;
  if (m.ss) {
    if (['0-3','1-3','2-3','3-2','3-1','3-0'].includes(m.ss)) {
      pocet_setu = Number(m.ss[0]) + Number(m.ss[2]);
    } else if (m.ss === '2-2') {
      pocet_setu = 5;
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
      .upsert(rows, { onConflict: ['id'] });
    if (error) {
      console.error('❌ Chyba při vkládání zápasů:', error.message);
    } 
  } catch (err) {
    console.error('❌ Neošetřená chyba při vkládání zápasů:', err);
  }
}
// Funkce pro smazání všech záznamů z tabulky upcoming
async function clearUpcomingTable() {
  try {
    const { error } = await supabase
      .from('upcoming')
      .delete()
     .neq('id', 0);  // předpokládá, že žádný záznam nemá id=0, takže smaže všechny
      if (error) {
      console.error('❌ Chyba při mazání tabulky upcoming:', error.message);
    } else {
      console.log('🧹 Tabulka upcoming vyprázdněna');
    }
  } catch (err) {
    console.error('❌ Neošetřená chyba při mazání tabulky upcoming:', err);
  }
}

// upravená funkce pro uložení do tabulky upcoming s přičtením 2 hodin
async function upsertMatchesToUpcomingDb(matches) {
  const rows = matches.map(m => {
    const { datum, cas } = processMatchData(m);
    // Přičíst 2 hodiny k času (jednotky v cas jsou ISO string)
    let casWithOffset = null;
    if (cas) {
      const dateObj = new Date(cas);
      dateObj.setHours(dateObj.getHours() + 2);
      casWithOffset = dateObj.toISOString();
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
  try {
    const { error } = await supabase
      .from('upcoming')
      .upsert(rows, { onConflict: ['id'] });
    if (error) {
      console.error('❌ Chyba při vkládání upcoming zápasů:', error.message);
    }
  } catch (err) {
    console.error('❌ Neošetřená chyba při vkládání upcoming zápasů:', err);
  }
}

// upravit fetchUpcomingMatches tak, aby při startu vymazal tabulku upcoming
async function fetchUpcomingMatches(maxPages = 3) {
  await clearUpcomingTable();

  let allMatches = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.b365api.com/v3/events/upcoming?sport_id=${SPORT_ID}&token=${TOKEN}&league_id=${LEAGUE_ID}&per_page=100&page=${page}`;
    const apiData = await fetchJSON(url);
    const matches = apiData.results || [];
    if (matches.length === 0) {
      console.log(`📭 Stránka ${page} prázdná, ukončuji fetch upcoming.`);
      break;
    }
    allMatches = allMatches.concat(matches);
    await upsertMatchesToUpcomingDb(matches);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`✅ Celkem načteno ${allMatches.length} upcoming zápasů`);
  return allMatches;
}



// fetch více stránek pro ended
async function fetchAllMatches(maxPages = 10) {
  let allMatches = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.b365api.com/v3/events/ended?sport_id=${SPORT_ID}&token=${TOKEN}&league_id=${LEAGUE_ID}&per_page=100&page=${page}`;
    const apiData = await fetchJSON(url);
    const matches = apiData.results || [];
    if (matches.length === 0) {
      console.log(`📭 Stránka ${page} prázdná, ukončuji fetch.`);
      break;
    }
    allMatches = allMatches.concat(matches);
    await upsertMatchesToDb(matches);
    await new Promise(r => setTimeout(r, 1000));
  }
  // Po načtení dat spustit aktualizaci statistik
  const { error } = await supabase.rpc('update_upcoming_stats');
  if (error) {
    console.error('❌ Chyba při aktualizaci upcoming statistik:', error.message);
  } else {
    console.log('✅ Upcoming statistiky aktualizovány');
  }
  console.log(`✅ Celkem načteno ${allMatches.length} upcoming zápasů`);
  return allMatches;
}

// endpoint na ruční spuštění fetch ended
app.get('/matches', async (req, res) => {
  try {
    const matches = await fetchAllMatches(10);
    res.json({ total: matches.length });
  } catch (err) {
    console.error('❌ Chyba API nebo DB:', err);
    res.status(500).json({ error: 'Chyba při načítání dat nebo ukládání' });
  }
});

// endpoint na ruční spuštění fetch upcoming
app.get('/upcoming', async (req, res) => {
  try {
    const matches = await fetchUpcomingMatches(3);
    res.json({ total: matches.length });
  } catch (err) {
    console.error('❌ Chyba API nebo DB:', err);
    res.status(500).json({ error: 'Chyba při načítání dat nebo ukládání' });
  }
});

// při startu
(async () => {
  try {
    console.log("🚀 Server startuje, stahuju zápasy ended i upcoming...");
    await fetchAllMatches(10);
    await fetchUpcomingMatches(3);
  } catch (err) {
    console.error("❌ Chyba při start fetch:", err);
  }
})();

// start serveru
app.listen(PORT, () => {
  console.log(`✅ Server běží na portu ${PORT}`);
});
