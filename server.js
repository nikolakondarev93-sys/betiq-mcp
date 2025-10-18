import express from "express";
import { fetch } from "undici";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { startHttpServer } from "@modelcontextprotocol/sdk/server/http.js";
import { z } from "zod";

// === ENV ===
const ODDS_API_KEY = process.env.ODDS_API_KEY || "06046913ffe0a112914a992f9d28f4f4";

// === helpers ===
function removeOverround(h, d, a) {
  const ih = 1/h, id = 1/d, ia = 1/a;
  const s = ih + id + ia;
  return { p_home: ih/s, p_draw: id/s, p_away: ia/s, overround: s - 1 };
}
function extractH2H(book, home, away) {
  const m = (book.markets || []).find(m => m.key === "h2h");
  if (!m) return null;
  const names = Object.fromEntries(m.outcomes.map(o => [o.name, o.price]));
  if (!(home in names) || !("Draw" in names) || !(away in names)) return null;
  return { home: names[home], draw: names["Draw"], away: names[away] };
}

// === MCP server ===
const mcp = new Server({ name: "betiq-mcp", version: "1.0.0" }, {});

// Tool 1: get_odds
mcp.tool(
  {
    name: "get_odds",
    description: "Fetch H2H odds from The Odds API",
    inputSchema: z.object({
      sport: z.string().default("soccer_epl"),
      regions: z.string().default("eu"),
      markets: z.string().default("h2h"),
    })
  },
  async ({ sport = "soccer_epl", regions = "eu", markets = "h2h" }) => {
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=${regions}&markets=${markets}&oddsFormat=decimal&apiKey=${ODDS_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) return { error: await r.text(), status: r.status };
    return { fixtures: await r.json() };
  }
);

// Tool 2: value_analyze
mcp.tool(
  {
    name: "value_analyze",
    description: "Compute baseline (Pinnacle/consensus) + edge/EV for betano/bet365/winbet/inbet",
    inputSchema: z.object({
      event: z.any(),
      books: z.array(z.string()).default(["betano","bet365","winbet","inbet"])
    })
  },
  async ({ event, books = ["betano","bet365","winbet","inbet"] }) => {
    const home = event.home_team, away = event.away_team, bms = event.bookmakers || [];
    // baseline: Pinnacle → consensus
    let base = null;
    const pin = bms.find(b => b.key === "pinnacle");
    if (pin) { const o = extractH2H(pin, home, away); if (o) base = removeOverround(o.home, o.draw, o.away); }
    if (!base) {
      const hs=[], ds=[], as=[];
      for (const b of bms) {
        const o = extractH2H(b, home, away);
        if (o) { hs.push(o.home); ds.push(o.draw); as.push(o.away); }
      }
      if (hs.length && ds.length && as.length) {
        const avg = a => a.reduce((s,x)=>s+x,0)/a.length;
        base = removeOverround(avg(hs), avg(ds), avg(as));
      }
    }
    if (!base) return { baseline:{overround:1}, results:[], bestOverall:null };

    const edge = (p,o)=> p - 1/o, ev = (p,o)=> p*o - 1;
    const results = [];
    for (const b of bms) {
      if (!books.includes(b.key)) continue;
      const o = extractH2H(b, home, away); if (!o) continue;
      const c = [
        { selection:"HOME", prob: base.p_home, odds:o.home },
        { selection:"DRAW", prob: base.p_draw, odds:o.draw },
        { selection:"AWAY", prob: base.p_away, odds:o.away }
      ].map(x => ({ ...x,
        prob:+x.prob.toFixed(4), edge:+(edge(x.prob,x.odds)).toFixed(4), ev:+(ev(x.prob,x.odds)).toFixed(4)
      }));
      c.sort((a,b)=> b.edge - a.edge);
      results.push({ book: b.key, best: c[0], all: c });
    }
    const bestOverall = results.slice().sort((a,b)=> b.best.edge - a.best.edge)[0] || null;
    return {
      baseline: base,
      results,
      bestOverall,
      event_id: event.id,
      match: `${home} vs ${away}`,
      kickoff_utc: event.commence_time
    };
  }
);

// HTTP transport + health
const app = express();
app.get("/health", (_req,res)=>res.json({ ok:true, service:"betiq-mcp" }));

const server = app.listen(process.env.PORT || 3000, async ()=>{
  const { port } = server.address();
  await startHttpServer(mcp, { server, path: "/mcp" });
  console.log(`BetIQ MCP ready on ${port} | /health | /mcp`);
});
