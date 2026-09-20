// Village After Dark — Werewolf text game server
// Node.js + Express + Socket.IO
//
// Run with: npm install && npm start

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ---------- Config ----------
const NIGHT_SECONDS = 60;
const DISCUSSION_SECONDS = 90;
const VOTE_SECONDS = 30;
const MIN_PLAYERS = 4;

const VILLAGE_ROLES = ["villager", "seer", "witch", "knight", "gossip"];
const SINGLETON_ROLES = ["seer", "witch", "knight", "chupacabra", "gossip"];
const ALL_ROLES = ["werewolf", "villager", "seer", "tanner", "witch", "knight", "chupacabra", "gossip"];

// ---------- In-memory state ----------
// rooms[code] = { code, moderatorId, players:{id:{id,name,role,alive,votedFor,tannerWon}},
//   phase, dayNumber, story, witchUsed, lastWolfDeathCause, chupacabraFailed,
//   nightActions, timer, log }
const rooms = {};

function roomCodeGenerate() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms[code]);
  return code;
}

function getRoom(socket) {
  return rooms[socket.data.roomCode];
}

function isModerator(room, socket) {
  return room && room.moderatorId === socket.id;
}

function alivePlayers(room) {
  return Object.values(room.players).filter((p) => p.alive);
}
function aliveByRole(room, role) {
  return alivePlayers(room).filter((p) => p.role === role);
}
function aliveWerewolves(room) {
  return aliveByRole(room, "werewolf");
}
function findByRole(room, role) {
  return Object.values(room.players).find((p) => p.role === role);
}

function publicPlayerList(room) {
  return Object.values(room.players).map((p) => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    role: !p.alive || room.phase === "gameover" ? p.role : undefined,
  }));
}

function modPlayerList(room) {
  return Object.values(room.players).map((p) => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    role: p.role,
  }));
}

function broadcastState(room) {
  io.to(room.code).emit("state", {
    code: room.code,
    phase: room.phase,
    dayNumber: room.dayNumber,
    players: publicPlayerList(room),
    moderatorPresent: !!room.moderatorId,
    timerEndsAt: room.timer ? room.timer.endsAt : null,
  });
  if (room.moderatorId) {
    io.to(room.moderatorId).emit("modState", {
      code: room.code,
      phase: room.phase,
      dayNumber: room.dayNumber,
      players: modPlayerList(room),
      witchUsed: room.witchUsed,
      timerEndsAt: room.timer ? room.timer.endsAt : null,
    });
  }
}

function logEvent(room, text) {
  room.log.push({ text, ts: Date.now() });
  io.to(room.code).emit("log", { text, ts: Date.now() });
}

function modFeed(room, text) {
  if (room.moderatorId) io.to(room.moderatorId).emit("modFeed", { text, ts: Date.now() });
}

function sendRole(room, player) {
  const packMates =
    player.role === "werewolf"
      ? aliveWerewolves(room)
          .filter((w) => w.id !== player.id)
          .map((w) => w.name)
      : [];
  io.to(player.id).emit("role", { role: player.role, packMates });
}

function clearTimer(room) {
  if (room.timer && room.timer.handle) clearTimeout(room.timer.handle);
  room.timer = null;
}
function setPhaseTimer(room, seconds, onExpire) {
  clearTimer(room);
  const endsAt = Date.now() + seconds * 1000;
  room.timer = { endsAt, handle: setTimeout(onExpire, seconds * 1000) };
}

function tallyMajority(votesObj) {
  const counts = {};
  Object.values(votesObj).forEach((id) => {
    if (id) counts[id] = (counts[id] || 0) + 1;
  });
  let best = null,
    bestCount = 0,
    tie = false;
  Object.entries(counts).forEach(([id, count]) => {
    if (count > bestCount) {
      best = id;
      bestCount = count;
      tie = false;
    } else if (count === bestCount && count > 0) {
      tie = true;
    }
  });
  return { best: tie ? null : best, bestCount };
}

// ---------- Death bookkeeping ----------
function applyDeath(room, player, cause) {
  if (!player || !player.alive) return;
  player.alive = false;
  if (player.role === "tanner") player.tannerWon = true;
  if (player.role === "werewolf") room.lastWolfDeathCause = cause;
}

// ---------- Role assignment (moderator-driven) ----------
function validateAssignments(room, assignments) {
  const ids = Object.keys(room.players);
  const seen = {};
  let werewolfCount = 0;
  for (const id of ids) {
    const role = assignments[id] || "villager";
    if (!ALL_ROLES.includes(role)) return { ok: false, error: `Unknown role: ${role}` };
    if (SINGLETON_ROLES.includes(role)) {
      if (seen[role]) return { ok: false, error: `Only one ${role} is allowed.` };
      seen[role] = true;
    }
    if (role === "werewolf") werewolfCount++;
  }
  if (werewolfCount === 0) return { ok: false, error: "You need at least one Werewolf." };
  return { ok: true };
}

function applyRoleAssignments(room, assignments) {
  Object.keys(room.players).forEach((id) => {
    const p = room.players[id];
    p.role = assignments[id] || "villager";
    p.alive = true;
    p.tannerWon = false;
    p.votedFor = null;
  });
  room.witchUsed = false;
  room.lastWolfDeathCause = null;
  room.chupacabraFailed = false;
  Object.values(room.players).forEach((p) => sendRole(room, p));
}

// ---------- Phase transitions ----------
function readyForStory(room) {
  room.phase = "storywait";
  broadcastState(room);
  logEvent(
    room,
    room.dayNumber === 0
      ? "The moderator is preparing the opening tale..."
      : "The village waits as the moderator prepares tonight's tale..."
  );
}

function beginNight(room, storyText) {
  clearTimer(room);
  room.story = storyText || "";
  if (storyText && storyText.trim()) logEvent(room, `📖 ${storyText.trim()}`);
  room.dayNumber += 1;
  room.phase = "night";
  room.nightActions = {
    wolfVotes: {},
    knightTarget: null,
    witchAction: null,
    chupacabraTarget: null,
    gossipPairs: {},
    actedIds: new Set(),
  };
  logEvent(room, `🌙 Night ${room.dayNumber} falls. The village sleeps.`);
  broadcastState(room);

  aliveWerewolves(room).forEach((w) => {
    io.to(w.id).emit("nightPrompt", {
      role: "werewolf",
      targets: alivePlayers(room)
        .filter((p) => p.role !== "werewolf")
        .map((p) => ({ id: p.id, name: p.name })),
    });
  });

  const seer = aliveByRole(room, "seer")[0];
  if (seer) {
    io.to(seer.id).emit("nightPrompt", {
      role: "seer",
      targets: alivePlayers(room)
        .filter((p) => p.id !== seer.id)
        .map((p) => ({ id: p.id, name: p.name })),
    });
  }

  const knight = aliveByRole(room, "knight")[0];
  if (knight) {
    io.to(knight.id).emit("nightPrompt", {
      role: "knight",
      targets: alivePlayers(room).map((p) => ({ id: p.id, name: p.name })),
    });
  }

  const witch = aliveByRole(room, "witch")[0];
  if (witch && !room.witchUsed) {
    io.to(witch.id).emit("nightPrompt", {
      role: "witch",
      deadTargets: Object.values(room.players)
        .filter((p) => !p.alive)
        .map((p) => ({ id: p.id, name: p.name })),
      aliveTargets: alivePlayers(room)
        .filter((p) => p.id !== witch.id)
        .map((p) => ({ id: p.id, name: p.name })),
    });
  }

  const chupacabra = aliveByRole(room, "chupacabra")[0];
  if (chupacabra) {
    io.to(chupacabra.id).emit("nightPrompt", {
      role: "chupacabra",
      targets: alivePlayers(room)
        .filter((p) => p.id !== chupacabra.id)
        .map((p) => ({ id: p.id, name: p.name })),
    });
  }

  const gossip = aliveByRole(room, "gossip")[0];
  if (gossip) {
    io.to(gossip.id).emit("nightPrompt", {
      role: "gossip",
      targets: alivePlayers(room)
        .filter((p) => p.id !== gossip.id)
        .map((p) => ({ id: p.id, name: p.name })),
    });
  }

  setPhaseTimer(room, NIGHT_SECONDS, () => resolveNight(room));
}

function resolveNight(room) {
  clearTimer(room);
  const na = room.nightActions;
  const wolvesAliveBefore = aliveWerewolves(room).length;
  const deathLines = [];

  // 1. Witch acts first (may revive a corpse or kill a living target)
  if (na.witchAction) {
    const witch = aliveByRole(room, "witch")[0];
    if (witch) {
      if (na.witchAction.type === "revive") {
        const target = room.players[na.witchAction.targetId];
        if (target && !target.alive) {
          target.alive = true;
          room.witchUsed = true;
          deathLines.push(`✨ A dead soul was mysteriously brought back before dawn.`);
        }
      } else if (na.witchAction.type === "kill") {
        const target = room.players[na.witchAction.targetId];
        if (target && target.alive) {
          applyDeath(room, target, "witch-kill");
          room.witchUsed = true;
          deathLines.push(`🧪 ${target.name} was found poisoned. They were a ${target.role}.`);
        }
      }
    }
  }

  // 2. Werewolf attack (majority vote), blocked if the Knight guarded the target
  const { best: victimId } = tallyMajority(na.wolfVotes);
  const victim = victimId ? room.players[victimId] : null;
  const saved = victim && na.knightTarget === victimId;

  if (victim && victim.alive && !saved) {
    if (victim.role === "tanner") {
      applyDeath(room, victim, "wolf-night-kill");
      let backfireText = "";
      if (wolvesAliveBefore >= 2) {
        const remainingWolves = aliveWerewolves(room);
        if (remainingWolves.length) {
          const bf = remainingWolves[Math.floor(Math.random() * remainingWolves.length)];
          applyDeath(room, bf, "tanner-backfire");
          backfireText = ` The pack turned on itself — ${bf.name}, a werewolf, did not survive the night.`;
        }
      }
      deathLines.push(`☠️ ${victim.name} was found dead. They were the Tanner.${backfireText}`);
    } else {
      applyDeath(room, victim, "wolf-night-kill");
      deathLines.push(`☠️ ${victim.name} was found dead this morning. They were a ${victim.role}.`);
    }
  } else if (victim && saved) {
    deathLines.push(`🩹 Someone was attacked last night, but they were protected. No one died.`);
  } else if (!na.witchAction) {
    deathLines.push(`☀️ No one died last night.`);
  }

  // 3. Chupacabra attack — only harms an actual werewolf
  if (na.chupacabraTarget) {
    const chup = aliveByRole(room, "chupacabra")[0];
    const target = room.players[na.chupacabraTarget];
    if (chup && target && target.alive) {
      if (target.role === "werewolf") {
        applyDeath(room, target, "chupacabra-kill");
        deathLines.push(`🐾 Something else hunted in the dark: ${target.name}, a werewolf, was torn apart.`);
        io.to(chup.id).emit("chupacabraResult", { hit: true, name: target.name });
      } else {
        io.to(chup.id).emit("chupacabraResult", { hit: false, name: target.name });
      }
    }
  }

  deathLines.forEach((line) => logEvent(room, line));

  // 4. Gossip results
  Object.entries(na.gossipPairs).forEach(([gossipId, pair]) => {
    const acted = pair.some((pid) => na.actedIds.has(pid));
    io.to(gossipId).emit("gossipResult", { acted });
  });

  broadcastState(room);
  const outcome = checkWinCondition(room);
  if (outcome) return endGame(room, outcome);
  startDiscussion(room);
}

function startDiscussion(room) {
  room.phase = "discussion";
  Object.values(room.players).forEach((p) => (p.votedFor = null));
  logEvent(room, `💬 Discussion phase. ${DISCUSSION_SECONDS} seconds before the vote opens.`);
  broadcastState(room);
  setPhaseTimer(room, DISCUSSION_SECONDS, () => startVote(room));
}

function startVote(room) {
  room.phase = "vote";
  logEvent(room, `🗳️ Voting is open. Choose who to eliminate.`);
  broadcastState(room);
  setPhaseTimer(room, VOTE_SECONDS, () => resolveVote(room));
}

function resolveVote(room) {
  clearTimer(room);
  const votes = {};
  alivePlayers(room).forEach((p) => {
    if (p.votedFor) votes[p.id] = p.votedFor;
  });
  const { best } = tallyMajority(votes);

  if (best && room.players[best] && room.players[best].alive) {
    const target = room.players[best];
    applyDeath(room, target, "day-vote");
    logEvent(room, `⚖️ The village voted to eliminate ${target.name}. They were a ${target.role}.`);

    if (target.role === "tanner") {
      const tannersAlive = alivePlayers(room).filter((p) => p.role === "tanner").length;
      if (tannersAlive === 0) {
        broadcastState(room);
        return endGame(room, {
          type: "tanner",
          winners: Object.values(room.players)
            .filter((p) => p.role === "tanner")
            .map((p) => p.id),
        });
      }
    }
    if (target.role === "werewolf" && aliveWerewolves(room).length === 0) {
      room.chupacabraFailed = true;
    }
  } else {
    logEvent(room, `⚖️ The vote was tied or inconclusive. No one was eliminated.`);
  }

  broadcastState(room);
  const outcome = checkWinCondition(room);
  if (outcome) return endGame(room, outcome);
  readyForStory(room);
}

function checkWinCondition(room) {
  const wolves = aliveWerewolves(room);
  const tannerBonusIds = Object.values(room.players)
    .filter((p) => p.role === "tanner" && p.tannerWon)
    .map((p) => p.id);

  if (wolves.length === 0) {
    if (room.lastWolfDeathCause === "chupacabra-kill" && !room.chupacabraFailed) {
      const chup = findByRole(room, "chupacabra");
      if (chup && chup.alive) return { type: "chupacabra", winners: [chup.id] };
    }
    const villageWinners = Object.values(room.players)
      .filter((p) => VILLAGE_ROLES.includes(p.role))
      .map((p) => p.id);
    return { type: "village", winners: [...villageWinners, ...tannerBonusIds] };
  }

  const nonWolfAlive = alivePlayers(room).filter((p) => p.role !== "werewolf").length;
  if (wolves.length >= nonWolfAlive) {
    const wolfWinners = Object.values(room.players)
      .filter((p) => p.role === "werewolf")
      .map((p) => p.id);
    return { type: "werewolf", winners: [...wolfWinners, ...tannerBonusIds] };
  }
  return null;
}

function endGame(room, outcome) {
  room.phase = "gameover";
  clearTimer(room);
  const labels = {
    village: "🏆 The Village wins!",
    werewolf: "🐺 The Werewolves win!",
    tanner: "🃏 The Tanner wins — the village is disbanded in shame!",
    chupacabra: "🐾 The Chupacabra wins, alone in the dark!",
  };
  logEvent(room, labels[outcome.type] || "Game over.");
  io.to(room.code).emit("gameover", outcome);
  broadcastState(room);
}

// ---------- Socket handlers ----------
io.on("connection", (socket) => {
  // ----- Moderator -----
  socket.on("modCreateRoom", (_payload, cb) => {
    const code = roomCodeGenerate();
    rooms[code] = {
      code,
      moderatorId: socket.id,
      players: {},
      phase: "lobby",
      dayNumber: 0,
      story: "",
      witchUsed: false,
      lastWolfDeathCause: null,
      chupacabraFailed: false,
      nightActions: {},
      timer: null,
      log: [],
    };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isModerator = true;
    cb && cb({ ok: true, code });
    broadcastState(rooms[code]);
  });

  socket.on("modAssignRoles", ({ assignments }, cb) => {
    const room = getRoom(socket);
    if (!isModerator(room, socket)) return cb && cb({ ok: false, error: "Not the moderator." });
    if (Object.keys(room.players).length < MIN_PLAYERS)
      return cb && cb({ ok: false, error: `Need at least ${MIN_PLAYERS} players.` });
    const check = validateAssignments(room, assignments || {});
    if (!check.ok) return cb && cb({ ok: false, error: check.error });
    applyRoleAssignments(room, assignments || {});
    room.dayNumber = 0;
    readyForStory(room);
    cb && cb({ ok: true });
  });

  socket.on("modSendStory", ({ text }) => {
    const room = getRoom(socket);
    if (!isModerator(room, socket)) return;
    if (room.phase !== "storywait") return;
    beginNight(room, text);
  });

  socket.on("modAnnounce", ({ text }) => {
    const room = getRoom(socket);
    if (!isModerator(room, socket)) return;
    const clean = (text || "").slice(0, 300).trim();
    if (clean) logEvent(room, `📖 ${clean}`);
  });

  socket.on("modAdvancePhase", () => {
    const room = getRoom(socket);
    if (!isModerator(room, socket)) return;
    if (room.phase === "night") resolveNight(room);
    else if (room.phase === "discussion") startVote(room);
    else if (room.phase === "vote") resolveVote(room);
  });

  socket.on("modPlayAgain", () => {
    const room = getRoom(socket);
    if (!isModerator(room, socket)) return;
    room.phase = "lobby";
    room.dayNumber = 0;
    room.log = [];
    room.witchUsed = false;
    room.lastWolfDeathCause = null;
    room.chupacabraFailed = false;
    Object.values(room.players).forEach((p) => {
      p.role = null;
      p.alive = true;
      p.votedFor = null;
      p.tannerWon = false;
    });
    broadcastState(room);
  });

  // ----- Players -----
  socket.on("joinRoom", ({ name, code }, cb) => {
    const room = rooms[(code || "").toUpperCase()];
    if (!room) return cb && cb({ ok: false, error: "Room not found." });
    if (room.phase !== "lobby") return cb && cb({ ok: false, error: "Game already in progress." });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.isModerator = false;
    room.players[socket.id] = {
      id: socket.id,
      name: (name || "Player").slice(0, 20),
      role: null,
      alive: true,
      votedFor: null,
      tannerWon: false,
    };
    logEvent(room, `${room.players[socket.id].name} joined the lobby.`);
    broadcastState(room);
    cb && cb({ ok: true, code: room.code });
  });

  socket.on("chat", ({ text }) => {
    const room = getRoom(socket);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player || room.phase === "night" || room.phase === "storywait" || !player.alive) return;
    const clean = (text || "").slice(0, 500).trim();
    if (!clean) return;
    io.to(room.code).emit("chatMsg", { name: player.name, text: clean, ts: Date.now() });
  });

  socket.on("wolfChat", ({ text }) => {
    const room = getRoom(socket);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player || player.role !== "werewolf" || !player.alive || room.phase !== "night") return;
    const clean = (text || "").slice(0, 500).trim();
    if (!clean) return;
    aliveWerewolves(room).forEach((w) => io.to(w.id).emit("wolfChatMsg", { name: player.name, text: clean, ts: Date.now() }));
    if (room.moderatorId) io.to(room.moderatorId).emit("modWolfChat", { name: player.name, text: clean, ts: Date.now() });
  });

  socket.on("wolfVote", ({ targetId }) => {
    const room = getRoom(socket);
    if (!room || room.phase !== "night") return;
    const player = room.players[socket.id];
    if (!player || player.role !== "werewolf" || !player.alive) return;
    room.nightActions.wolfVotes[socket.id] = targetId;
    room.nightActions.actedIds.add(socket.id);
    aliveWerewolves(room).forEach((w) => io.to(w.id).emit("wolfVoteUpdate", room.nightActions.wolfVotes));
    modFeed(room, `${player.name} (Werewolf) voted to kill ${room.players[targetId] ? room.players[targetId].name : "?"}.`);
  });

  socket.on("seerAction", ({ targetId }) => {
    const room = getRoom(socket);
    if (!room || room.phase !== "night") return;
    const player = room.players[socket.id];
    if (!player || player.role !== "seer" || !player.alive) return;
    const target = room.players[targetId];
    if (!target) return;
    room.nightActions.actedIds.add(socket.id);
    io.to(socket.id).emit("seerResult", { name: target.name, isWolf: target.role === "werewolf" });
    modFeed(room, `${player.name} (Seer) checked ${target.name}.`);
  });

  socket.on("knightAction", ({ targetId }) => {
    const room = getRoom(socket);
    if (!room || room.phase !== "night") return;
    const player = room.players[socket.id];
    if (!player || player.role !== "knight" || !player.alive) return;
    room.nightActions.knightTarget = targetId;
    room.nightActions.actedIds.add(socket.id);
    modFeed(room, `${player.name} (Knight) is protecting ${room.players[targetId] ? room.players[targetId].name : "?"}.`);
  });

  socket.on("witchAction", ({ type, targetId }) => {
    const room = getRoom(socket);
    if (!room || room.phase !== "night" || room.witchUsed) return;
    const player = room.players[socket.id];
    if (!player || player.role !== "witch" || !player.alive) return;
    if (type !== "revive" && type !== "kill") return;
    room.nightActions.witchAction = { type, targetId };
    room.nightActions.actedIds.add(socket.id);
    modFeed(room, `${player.name} (Witch) chose to ${type} ${room.players[targetId] ? room.players[targetId].name : "?"}.`);
  });

  socket.on("chupacabraAction", ({ targetId }) => {
    const room = getRoom(socket);
    if (!room || room.phase !== "night") return;
    const player = room.players[socket.id];
    if (!player || player.role !== "chupacabra" || !player.alive) return;
    room.nightActions.chupacabraTarget = targetId;
    room.nightActions.actedIds.add(socket.id);
    modFeed(room, `${player.name} (Chupacabra) is attacking ${room.players[targetId] ? room.players[targetId].name : "?"}.`);
  });

  socket.on("gossipAction", ({ targetAId, targetBId }) => {
    const room = getRoom(socket);
    if (!room || room.phase !== "night") return;
    const player = room.players[socket.id];
    if (!player || player.role !== "gossip" || !player.alive) return;
    if (!targetAId || !targetBId || targetAId === targetBId) return;
    room.nightActions.gossipPairs[socket.id] = [targetAId, targetBId];
    modFeed(
      room,
      `${player.name} (Gossip) is watching ${room.players[targetAId] ? room.players[targetAId].name : "?"} & ${
        room.players[targetBId] ? room.players[targetBId].name : "?"
      }.`
    );
  });

  socket.on("castVote", ({ targetId }) => {
    const room = getRoom(socket);
    if (!room || room.phase !== "vote") return;
    const player = room.players[socket.id];
    if (!player || !player.alive) return;
    player.votedFor = targetId;
    const tally = {};
    alivePlayers(room).forEach((p) => {
      if (p.votedFor) tally[p.votedFor] = (tally[p.votedFor] || 0) + 1;
    });
    io.to(room.code).emit("voteTally", tally);
    modFeed(room, `${player.name} voted for ${room.players[targetId] ? room.players[targetId].name : "?"}.`);
  });

  socket.on("disconnect", () => {
    const room = getRoom(socket);
    if (!room) return;

    if (socket.data.isModerator) {
      room.moderatorId = null;
      logEvent(room, "⚠️ The moderator disconnected. The game may be unable to continue.");
      broadcastState(room);
      return;
    }

    const player = room.players[socket.id];
    if (!player) return;
    delete room.players[socket.id];
    logEvent(room, `${player.name} disconnected.`);

    if (Object.keys(room.players).length === 0 && !room.moderatorId) {
      clearTimer(room);
      delete rooms[room.code];
      return;
    }
    if (room.phase !== "lobby" && room.phase !== "storywait") {
      const outcome = checkWinCondition(room);
      if (outcome) return endGame(room, outcome);
    }
    broadcastState(room);
  });
});

server.listen(PORT, () => {
  console.log(`Village After Dark server running on port ${PORT}`);
});
