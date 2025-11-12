// server.ts
// Full game server for Hokm (Deno). Compatible with local run and Deno Deploy.
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPA_URL = Deno.env.get("SUPABASE_URL");
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPA_URL || !SUPA_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var");
  // If running as module (imported), do not exit; if run as script, exit to avoid silent failure.
  if (import.meta.main) Deno.exit(1);
}

const supabase = createClient(SUPA_URL ?? "", SUPA_KEY ?? "", { auth: { persistSession: false } });

/* ---------------- Utilities ---------------- */
function shuffle<T>(arr: T[]) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function buildDeck(): string[] {
  const suits = ["c","d","h","s"]; // clubs, diamonds, hearts, spades
  const ranks = ["2","3","4","5","6","7","8","9","10","j","q","k","a"];
  const deck: string[] = [];
  for (const r of ranks) for (const s of suits) deck.push(`${r}_${s}`);
  return deck;
}

function rankValue(rank: string) {
  if (rank === "j") return 11;
  if (rank === "q") return 12;
  if (rank === "k") return 13;
  if (rank === "a") return 14;
  const n = parseInt(rank);
  return isNaN(n) ? 0 : n;
}

/* ---------------- Handlers (logic) ---------------- */

// create_room
async function createRoomHandler(body: any) {
  const roomId = body.id || crypto.randomUUID();
  const roomName = body.room_name || "";
  const targetTricks = Number(body.target_tricks || 7); // 3,5,7
  const trumpMode = body.trump_mode || "STANDARD";

  const { error: e1 } = await supabase.from("rooms").insert([{
    id: roomId,
    room_name: roomName,
    target_tricks: targetTricks,
    trump_mode: trumpMode,
    phase: 'waiting',
    team_scores: { teamA: 0, teamB: 0 },
    last_trick_winner: null
  }]);
  if (e1) throw e1;

  const slots = [0,1,2,3].map(i => ({
    room_id: roomId,
    slot: i,
    user_id: null,
    display_name: null,
    type: 'empty',
    connected: false
  }));
  const { error: e2 } = await supabase.from("room_players").insert(slots);
  if (e2) throw e2;

  await supabase.from("current_trick").upsert({ room_id: roomId, plays: [] });

  return { ok: true, roomId };
}

// join_room
async function joinRoomHandler(body: any) {
  const roomId = body.roomId;
  const userId = body.userId;
  const displayName = body.displayName || userId;
  if (!roomId || !userId) throw new Error("bad_request");

  const { data: slots } = await supabase.from("room_players").select("*").eq("room_id", roomId).order("slot", { ascending: true }).limit(4);
  if (!slots) throw new Error("room_not_found");
  let chosen: any = null;
  for (const s of slots) {
    if (s.type === 'empty' || !s.user_id) { chosen = s; break; }
  }
  if (!chosen) {
    for (const s of slots) {
      if (!s.connected && s.type === 'human') { chosen = s; break; }
    }
  }
  if (!chosen) throw new Error("room_full");

  const { error } = await supabase.from("room_players").update({
    user_id: userId,
    display_name: displayName,
    type: 'human',
    connected: true
  }).match({ room_id: roomId, slot: chosen.slot });
  if (error) throw error;

  return { ok: true, slot: chosen.slot, roomId };
}

// start_deal
async function startDealHandler(body: any) {
  const roomId = body.roomId;
  if (!roomId) throw new Error("bad_request");

  const { data: players } = await supabase.from("room_players").select("*").eq("room_id", roomId).order("slot", { ascending: true });
  if (!players) throw new Error("players_missing");

  for (const p of players) {
    if (!p) continue;
    if (p.type === 'empty' || !p.user_id) {
      await supabase.from("room_players").update({
        user_id: `bot_${p.slot}`,
        display_name: `BOT_${p.slot}`,
        type: 'bot',
        connected: true
      }).match({ room_id: roomId, slot: p.slot });
    }
  }

  const { data: players2 } = await supabase.from("room_players").select("*").eq("room_id", roomId).order("slot", { ascending: true });
  const deck = buildDeck();
  shuffle(deck);

  // build pending (8 each)
  const pending: Record<string, string[]> = {};
  for (let k=0;k<8;k++) for (let i=0;i<4;i++) {
    if (!pending[String(i)]) pending[String(i)] = [];
    pending[String(i)].push(deck.shift()!);
  }

  // deal 5 cards each
  const initialHands: Record<number, string[]> = {0:[],1:[],2:[],3:[]};
  for (let r=0;r<5;r++) for (let i=0;i<4;i++) initialHands[i].push(deck.shift()!);

  for (let i=0;i<4;i++) {
    const p = players2[i];
    const owner = p.user_id || `bot_${i}`;
    await supabase.from("hands").upsert({ room_id: roomId, owner, cards: initialHands[i] });
  }

  const hakim_index = Math.floor(Math.random()*4);
  const { error } = await supabase.from("rooms").update({
    deck,
    pending,
    phase: 'choosing_hakim',
    hakim_index,
    current_turn_index: hakim_index,
    trump: null,
    last_trick_winner: null,
    team_scores: { teamA: 0, teamB: 0 }
  }).match({ id: roomId });
  if (error) throw error;

  return { ok: true, hakim_index };
}

// kick_player
async function kickPlayerHandler(body: any) {
  const { roomId, slot } = body;
  if (!roomId || slot === undefined) throw new Error("bad_request");

  const { error } = await supabase.from("room_players").update({
    user_id: `bot_${slot}`,
    display_name: `BOT_${slot}`,
    type: 'bot',
    connected: true
  }).match({ room_id: roomId, slot });
  if (error) throw error;

  await supabase.from("hands").upsert({ room_id: roomId, owner: `bot_${slot}`, cards: [] });

  return { ok: true };
}

// get_room_state
async function getRoomStateHandler(url: URL) {
  const rid = url.searchParams.get("roomId");
  if (!rid) throw new Error("missing_roomId");
  const { data: room } = await supabase.from("rooms").select("*").eq("id", rid).limit(1).single();
  const { data: players } = await supabase.from("room_players").select("*").eq("room_id", rid).order("slot", { ascending: true });
  const { data: hands } = await supabase.from("hands").select("*").eq("room_id", rid);
  const { data: trick } = await supabase.from("current_trick").select("*").eq("room_id", rid).limit(1).single();
  return { room, players, hands, trick };
}

/* Trick evaluation helpers */
function evaluateTrickWinner(plays: any[], trump: string | null) {
  if (!plays || plays.length === 0) return null;
  const firstCard = plays[0].card;
  const leadSuit = firstCard.split("_")[1];
  let winnerSlot = plays[0].slot;
  let bestCard = plays[0].card;

  for (const p of plays) {
    const c = p.card;
    const s = c.split("_")[1];
    // trump considerations
    if (trump && s === trump) {
      if (bestCard.split("_")[1] !== trump) { winnerSlot = p.slot; bestCard = c; continue; }
      if (rankValue(c.split("_")[0]) > rankValue(bestCard.split("_")[0])) { winnerSlot = p.slot; bestCard = c; continue; }
      continue;
    }
    if (bestCard.split("_")[1] === trump && s !== trump) continue;
    if (s === bestCard.split("_")[1]) {
      if (rankValue(c.split("_")[0]) > rankValue(bestCard.split("_")[0])) { winnerSlot = p.slot; bestCard = c; continue; }
    }
    if (s === leadSuit && bestCard.split("_")[1] !== leadSuit) {
      winnerSlot = p.slot; bestCard = c; continue;
    }
  }
  return winnerSlot;
}

async function applyTrickResultAndCheckEnd(roomId: string, winnerSlot: number) {
  const { data: room } = await supabase.from("rooms").select("*").eq("id", roomId).limit(1).single();
  if (!room) throw new Error("room_not_found");
  const target = room.target_tricks || 7;
  const scores = (room.team_scores && typeof room.team_scores === 'object') ? { ...(room.team_scores) } : { teamA: 0, teamB: 0 };

  if (winnerSlot === 0 || winnerSlot === 1) scores.teamA = (scores.teamA || 0) + 1;
  else scores.teamB = (scores.teamB || 0) + 1;

  let updates: any = { team_scores: scores, last_trick_winner: winnerSlot };

  if ((scores.teamA >= target) || (scores.teamB >= target)) {
    updates.phase = 'finished';
    updates.winner_team = scores.teamA >= target ? 'teamA' : 'teamB';
    updates.winner_time = new Date().toISOString();
  }

  await supabase.from("rooms").update(updates).match({ id: roomId });

  return { scores, finished: updates.phase === 'finished', winner_team: updates.winner_team || null };
}

// play_card
async function playCardHandler(body: any) {
  const { roomId, slot, card } = body;
  if (!roomId || slot === undefined || !card) throw new Error("bad_request");

  const { data: playerRow } = await supabase.from("room_players").select("*").eq("room_id", roomId).eq("slot", slot).limit(1).single();
  if (!playerRow) throw new Error("slot_not_found");
  const owner = playerRow.user_id || `bot_${slot}`;

  const { data: handRow } = await supabase.from("hands").select("*").eq("room_id", roomId).eq("owner", owner).limit(1).single();
  if (!handRow) throw new Error("hand_not_found");
  const cards: string[] = handRow.cards || [];
  const idx = cards.indexOf(card);
  if (idx === -1) throw new Error("card_not_in_hand");

  cards.splice(idx, 1);
  await supabase.from("hands").update({ cards }).match({ room_id: roomId, owner });

  const { data: ct } = await supabase.from("current_trick").select("*").eq("room_id", roomId).limit(1).single();
  const plays = ct && ct.plays ? (Array.isArray(ct.plays) ? ct.plays.slice() : []) : [];
  plays.push({ slot, card, at: new Date().toISOString() });
  await supabase.from("current_trick").upsert({ room_id: roomId, plays });

  const { data: room } = await supabase.from("rooms").select("*").eq("id", roomId).limit(1).single();
  if (!room) throw new Error("room_not_found");
  let nextIndex = ((room.current_turn_index ?? 0) + 1) % 4;
  await supabase.from("rooms").update({ current_turn_index: nextIndex }).match({ id: roomId });

  if (plays.length >= 4) {
    const trump = room.trump || room.trump_mode || null;
    const winnerSlot = evaluateTrickWinner(plays, trump);
    await supabase.from("current_trick").upsert({ room_id: roomId, plays: [] });
    const res = await applyTrickResultAndCheckEnd(roomId, winnerSlot);
    await supabase.from("rooms").update({ current_turn_index: winnerSlot }).match({ id: roomId });
    return { ok: true, winnerSlot, team_scores: res.scores, finished: res.finished, winner_team: res.winner_team };
  }

  return { ok: true };
}

// set_trump
async function setTrumpHandler(body: any) {
  const { roomId, trump } = body;
  if (!roomId || trump === undefined || trump === null) throw new Error("bad_request");
  const allowed = ["c","d","h","s","STANDARD","SERS","NERS"];
  if (!allowed.includes(trump)) throw new Error("invalid_trump");

  const { error } = await supabase.from("rooms").update({
    trump,
    phase: 'playing'
  }).match({ id: roomId });
  if (error) throw error;

  const { data: room } = await supabase.from("rooms").select("*").eq("id", roomId).limit(1).single();
  if (!room) throw new Error("room_not_found");
  const pending = room.pending || {};

  for (let i=0;i<4;i++) {
    const pRes = await supabase.from("room_players").select("user_id").eq("room_id", roomId).eq("slot", i).limit(1).single();
    const owner = pRes.data && pRes.data.user_id ? pRes.data.user_id : `bot_${i}`;
    const { data: handRow } = await supabase.from("hands").select("*").eq("room_id", roomId).eq("owner", owner).limit(1).single();
    let existing = (handRow && handRow.cards) ? handRow.cards : [];
    const add = pending[String(i)] || [];
    const newcards = existing.concat(add);
    await supabase.from("hands").upsert({ room_id: roomId, owner, cards: newcards });
  }

  await supabase.from("rooms").update({ pending: {} }).match({ id: roomId });

  return { ok: true };
}

// bot_play
async function botPlayHandler(body: any) {
  const { roomId, bot_slot } = body;
  if (!roomId || bot_slot === undefined) throw new Error("bad_request");

  const botId = `bot_${bot_slot}`;
  const { data: handRow } = await supabase.from("hands").select("*").eq("room_id", roomId).eq("owner", botId).limit(1).single();
  if (!handRow) throw new Error("bot_no_hand");
  const cards: string[] = handRow.cards || [];
  if (!cards || cards.length === 0) throw new Error("bot_no_cards");

  const { data: ct } = await supabase.from("current_trick").select("*").eq("room_id", roomId).limit(1).single();
  const plays = ct && ct.plays ? ct.plays : [];
  const leadSuit = (plays.length > 0) ? plays[0].card.split("_")[1] : null;

  let chosenIndex = 0;
  if (leadSuit) {
    let foundIdx = -1;
    let bestVal = -1;
    for (let i=0;i<cards.length;i++) {
      const c = cards[i];
      if (c.split("_")[1] === leadSuit) {
        const rv = rankValue(c.split("_")[0]);
        if (rv > bestVal) { bestVal = rv; foundIdx = i; }
      }
    }
    if (foundIdx >= 0) chosenIndex = foundIdx;
  }
  const chosenCard = cards[chosenIndex];

  // reuse playCardHandler (server-side play)
  const res = await playCardHandler({ roomId, slot: bot_slot, card: chosenCard });
  return { ok: true, chosen: chosenCard, result: res };
}

/* ---------------- HTTP routing ---------------- */

const handler = async (req: Request): Promise<Response> => {
  try {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/create_room") {
      const body = await req.json();
      const r = await createRoomHandler(body);
      return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type":"application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/join_room") {
      const body = await req.json();
      const r = await joinRoomHandler(body);
      return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type":"application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/start_deal") {
      const body = await req.json();
      const r = await startDealHandler(body);
      return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type":"application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/kick_player") {
      const body = await req.json();
      const r = await kickPlayerHandler(body);
      return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type":"application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/bot_play") {
      const body = await req.json();
      const r = await botPlayHandler(body);
      return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type":"application/json" } });
    }
    if (req.method === "GET" && url.pathname === "/get_room_state") {
      const r = await getRoomStateHandler(url);
      return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type":"application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/set_trump") {
      const body = await req.json();
      const r = await setTrumpHandler(body);
      return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type":"application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/play_card") {
      const body = await req.json();
      const r = await playCardHandler(body);
      return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type":"application/json" } });
    }

    return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type":"application/json" } });
  } catch (err) {
    const msg = (err instanceof Error) ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { "Content-Type":"application/json" } });
  }
};

/* ---------------- start server (compatible local & deploy) ---------------- */
if (import.meta.main) {
  // running directly (local)
  console.log("Starting server locally on http://localhost:8000");
  // serve with port in local dev for convenience
  await serve(handler, { port: 8000 });
} else {
  // running in Deploy/Edge environment: just serve (no explicit port)
  serve(handler);
}

