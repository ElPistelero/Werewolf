const socket = io();

let myId = null;
let myRoom = null;
let myRole = null;
let isModerator = false;
let currentState = null;
let lastWinner = null;
let pendingAssignments = {};

const ALL_ROLES = ["villager", "werewolf", "seer", "tanner", "witch", "knight", "chupacabra", "gossip"];

const ROLE_INFO = {
  werewolf: {
    label: "Werewolf",
    team: "Werewolf",
    desc: "Each night, vote with your pack to choose a victim. The majority target dies unless someone protected them. Blend in during the day.",
  },
  villager: {
    label: "Villager",
    team: "Village",
    desc: "You have no special power. Watch, listen, and vote wisely.",
  },
  seer: {
    label: "Seer",
    team: "Village",
    desc: "Each night, choose one player to learn whether they are a Werewolf.",
  },
  tanner: {
    label: "Tanner",
    team: "Neutral",
    desc: "You want to die. If the village votes out every Tanner, the village instantly loses. If werewolves kill you at night instead, you personally win once the game ends — and if two or more wolves are alive, one of them dies too.",
  },
  witch: {
    label: "Witch",
    team: "Village",
    desc: "You have one power for the entire game: on any night you choose, either revive someone who has died, or kill a living player. Once used, it's gone for good.",
  },
  knight: {
    label: "Knight",
    team: "Village",
    desc: "Each night, choose one player to protect from a werewolf attack. You can protect the same person again on a later night if you want.",
  },
  chupacabra: {
    label: "Chupacabra",
    team: "Neutral (solo)",
    desc: "Each night, attack one player. If they're a werewolf, they die — if not, nothing happens. You win alone the instant your attack kills the last werewolf. If the village votes out the last werewolf first, you lose your only chance to win.",
  },
  gossip: {
    label: "Gossip",
    team: "Village",
    desc: "Each night, watch two players. You'll learn only whether at least one of them took a night action (meaning they aren't a plain Villager) — never who, and never what they did.",
  },
};

// ---------- Screen management ----------
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : str;
  return div.innerHTML;
}

// ---------- Audio: synthesized howl (no external files, no copyrighted audio) ----------
let audioCtx = null;
function playHowl() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sawtooth";
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(520, now + 0.9);
    osc.frequency.exponentialRampToValueAtTime(260, now + 2.2);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.5);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.6);
    osc.start(now);
    osc.stop(now + 2.7);
  } catch (e) {
    /* audio not available — silently continue */
  }
}

// ---------- Role guide modal ----------
const roleGuideModal = document.getElementById("role-guide-modal");
function openRoleGuide() {
  const body = document.getElementById("role-guide-body");
  body.innerHTML = "";
  ALL_ROLES.forEach((r) => {
    const info = ROLE_INFO[r];
    const div = document.createElement("div");
    div.className = "role-entry";
    div.innerHTML = `<div class="role-name">${info.label} <span style="color:var(--moon-dim);font-size:12px;">(${info.team})</span></div><div class="role-desc">${escapeHtml(info.desc)}</div>`;
    body.appendChild(div);
  });
  roleGuideModal.classList.remove("hidden");
}
document.getElementById("btn-close-guide").addEventListener("click", () => roleGuideModal.classList.add("hidden"));
document.getElementById("btn-open-guide-lobby").addEventListener("click", openRoleGuide);
document.getElementById("btn-open-guide-game").addEventListener("click", openRoleGuide);

// ---------- Landing ----------
document.getElementById("btn-enter").addEventListener("click", () => {
  playHowl();
  document.getElementById("btn-enter").classList.add("hidden");
  document.getElementById("path-choice").classList.remove("hidden");
});

document.getElementById("btn-be-mod").addEventListener("click", () => {
  socket.emit("modCreateRoom", {}, (res) => {
    if (!res.ok) return;
    isModerator = true;
    myRoom = res.code;
    document.getElementById("mod-lobby-code").textContent = res.code;
    showScreen("screen-mod-lobby");
  });
});

document.getElementById("btn-be-player").addEventListener("click", () => {
  document.getElementById("join-fields").classList.remove("hidden");
});

document.getElementById("btn-join").addEventListener("click", () => {
  const name = document.getElementById("input-name").value.trim();
  const code = document.getElementById("input-code").value.trim().toUpperCase();
  const err = document.getElementById("landing-error");
  if (!name) return (err.textContent = "Enter a name first.");
  if (!code) return (err.textContent = "Enter a room code.");
  socket.emit("joinRoom", { name, code }, (res) => {
    if (!res.ok) return (err.textContent = res.error || "Could not join room.");
    isModerator = false;
    myRoom = res.code;
    showScreen("screen-lobby");
  });
});

// ---------- Player lobby ----------
function renderPlayerLobby(state) {
  document.getElementById("lobby-code").textContent = state.code;
  const list = document.getElementById("lobby-player-list");
  list.innerHTML = "";
  state.players.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(p.name)}</span>`;
    list.appendChild(li);
  });
}

// ---------- Moderator lobby / role assignment ----------
function renderAssignList(state) {
  const list = document.getElementById("assign-list");
  list.innerHTML = "";
  state.players.forEach((p) => {
    if (!(p.id in pendingAssignments)) pendingAssignments[p.id] = "villager";
    const row = document.createElement("div");
    row.className = "assign-row";
    const select = document.createElement("select");
    ALL_ROLES.forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = ROLE_INFO[r].label;
      if (pendingAssignments[p.id] === r) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => {
      pendingAssignments[p.id] = select.value;
    });
    row.innerHTML = `<span class="name">${escapeHtml(p.name)}</span>`;
    row.appendChild(select);
    list.appendChild(row);
  });
}

document.getElementById("btn-lock-roles").addEventListener("click", () => {
  socket.emit("modAssignRoles", { assignments: pendingAssignments }, (res) => {
    const err = document.getElementById("assign-error");
    if (!res.ok) return (err.textContent = res.error || "Could not assign roles.");
    err.textContent = "";
    document.getElementById("mod-story-panel").classList.remove("hidden");
  });
});

document.getElementById("btn-begin-night1").addEventListener("click", () => {
  const text = document.getElementById("mod-story-input").value;
  socket.emit("modSendStory", { text });
});

document.getElementById("btn-send-nightly-story").addEventListener("click", () => {
  const text = document.getElementById("mod-nightly-story-input").value;
  socket.emit("modSendStory", { text });
  document.getElementById("mod-nightly-story-input").value = "";
});

document.getElementById("btn-mod-announce").addEventListener("click", () => {
  const input = document.getElementById("mod-announce-input");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("modAnnounce", { text });
  input.value = "";
});

document.getElementById("btn-mod-advance").addEventListener("click", () => {
  socket.emit("modAdvancePhase");
});

document.getElementById("btn-play-again").addEventListener("click", () => {
  if (isModerator) socket.emit("modPlayAgain");
});

// ---------- Player roster + header ----------
const PHASE_LABELS = {
  storywait: "🌒 Awaiting the story",
  night: "🌙 Night",
  discussion: "☀️ Discussion",
  vote: "🗳️ Voting",
  gameover: "Game over",
  lobby: "Lobby",
};

function phaseLabel(state) {
  if (state.phase === "night") return `🌙 Night ${state.dayNumber}`;
  return PHASE_LABELS[state.phase] || state.phase;
}

function renderRoster(listEl, players, showRolesAlways) {
  listEl.innerHTML = "";
  players.forEach((p) => {
    const li = document.createElement("li");
    if (!p.alive) li.classList.add("dead");
    let roleTag = "";
    if (p.role && (showRolesAlways || !p.alive)) {
      const cls = ["werewolf", "tanner", "chupacabra"].includes(p.role) ? p.role : "";
      roleTag = `<span class="role-tag ${cls}">${ROLE_INFO[p.role] ? ROLE_INFO[p.role].label : p.role}</span>`;
    }
    li.innerHTML = `<span>${escapeHtml(p.name)}${p.alive ? "" : " 💀"}</span>${roleTag}`;
    listEl.appendChild(li);
  });
}

// ---------- Timer ----------
function startTimerDisplay(elId, endsAt, intervalRef) {
  clearInterval(intervalRef.handle);
  const el = document.getElementById(elId);
  if (!el) return;
  if (!endsAt) {
    el.textContent = "--:--";
    return;
  }
  function tick() {
    const remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    el.textContent = `${m}:${String(s).padStart(2, "0")}`;
    if (remaining <= 0) clearInterval(intervalRef.handle);
  }
  tick();
  intervalRef.handle = setInterval(tick, 250);
}
const timerRef = { handle: null };
const modTimerRef = { handle: null };

// ---------- Chat ----------
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatLog = document.getElementById("chat-log");

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  if (myRole === "werewolf" && currentState && currentState.phase === "night") {
    socket.emit("wolfChat", { text });
  } else {
    socket.emit("chat", { text });
  }
  chatInput.value = "";
});

function appendChat(cls, who, text) {
  const div = document.createElement("div");
  div.className = "msg " + cls;
  div.innerHTML = who ? `<span class="who">${escapeHtml(who)}</span>${escapeHtml(text)}` : escapeHtml(text);
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function updateChatHint(state) {
  const hint = document.getElementById("chat-hint");
  const me = state.players.find((p) => p.id === myId);
  const alive = me ? me.alive : true;
  if (!alive) {
    hint.textContent = "You have died and can no longer send messages.";
    chatInput.disabled = true;
  } else if (state.phase === "storywait") {
    hint.textContent = "Waiting for the moderator's story...";
    chatInput.disabled = true;
  } else if (state.phase === "night" && myRole !== "werewolf") {
    hint.textContent = "It's night — only werewolves can talk right now.";
    chatInput.disabled = true;
  } else if (state.phase === "night" && myRole === "werewolf") {
    hint.textContent = "Night chat is private to your pack.";
    chatInput.disabled = false;
  } else {
    hint.textContent = "";
    chatInput.disabled = false;
  }
}

// ---------- Event log (shared renderer, used by both player + mod screens) ----------
function appendLogTo(elId, text) {
  const el = document.getElementById(elId);
  if (!el) return;
  const div = document.createElement("div");
  div.className = "entry";
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// ---------- Night action panel (players) ----------
function renderNightPanel(payload) {
  const panel = document.getElementById("night-action-panel");
  panel.classList.remove("hidden");
  panel.innerHTML = "";

  const title = document.createElement("h3");
  title.className = "panel-title-sm";
  const titles = {
    werewolf: "Choose your pack's victim",
    seer: "Choose someone to investigate",
    knight: "Choose someone to protect",
    chupacabra: "Choose someone to attack",
  };
  title.textContent = titles[payload.role] || "Your move";
  panel.appendChild(title);

  if (payload.role === "witch") {
    renderWitchPanel(panel, payload);
    return;
  }
  if (payload.role === "gossip") {
    renderGossipPanel(panel, payload);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "target-grid";
  payload.targets.forEach((t) => {
    const btn = document.createElement("button");
    btn.className = "target-btn";
    btn.textContent = t.name;
    btn.addEventListener("click", () => {
      grid.querySelectorAll(".target-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      if (payload.role === "werewolf") socket.emit("wolfVote", { targetId: t.id });
      else if (payload.role === "seer") socket.emit("seerAction", { targetId: t.id });
      else if (payload.role === "knight") socket.emit("knightAction", { targetId: t.id });
      else if (payload.role === "chupacabra") socket.emit("chupacabraAction", { targetId: t.id });
    });
    grid.appendChild(btn);
  });
  panel.appendChild(grid);

  if (payload.role === "werewolf") {
    const note = document.createElement("p");
    note.className = "hint";
    note.style.marginTop = "10px";
    note.textContent = "Your pack's votes are combined — the majority target dies.";
    panel.appendChild(note);
  }
}

function renderWitchPanel(panel, payload) {
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = "Choose one: revive someone who has died, or kill a living player. This power can only be used once, ever — you may also skip and save it for later.";
  panel.appendChild(note);

  if (payload.deadTargets.length) {
    const reviveTitle = document.createElement("div");
    reviveTitle.className = "hint";
    reviveTitle.style.margin = "10px 0 6px 0";
    reviveTitle.textContent = "Revive:";
    panel.appendChild(reviveTitle);
    const reviveGrid = document.createElement("div");
    reviveGrid.className = "target-grid";
    payload.deadTargets.forEach((t) => {
      const btn = document.createElement("button");
      btn.className = "target-btn";
      btn.textContent = t.name;
      btn.addEventListener("click", () => {
        panel.querySelectorAll(".target-btn").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        socket.emit("witchAction", { type: "revive", targetId: t.id });
      });
      reviveGrid.appendChild(btn);
    });
    panel.appendChild(reviveGrid);
  }

  const killTitle = document.createElement("div");
  killTitle.className = "hint";
  killTitle.style.margin = "12px 0 6px 0";
  killTitle.textContent = "Kill:";
  panel.appendChild(killTitle);
  const killGrid = document.createElement("div");
  killGrid.className = "target-grid";
  payload.aliveTargets.forEach((t) => {
    const btn = document.createElement("button");
    btn.className = "target-btn";
    btn.textContent = t.name;
    btn.addEventListener("click", () => {
      panel.querySelectorAll(".target-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      socket.emit("witchAction", { type: "kill", targetId: t.id });
    });
    killGrid.appendChild(btn);
  });
  panel.appendChild(killGrid);
}

function renderGossipPanel(panel, payload) {
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = "Pick two players to watch tonight.";
  panel.appendChild(note);

  let picked = [];
  const grid = document.createElement("div");
  grid.className = "target-grid";
  payload.targets.forEach((t) => {
    const btn = document.createElement("button");
    btn.className = "target-btn";
    btn.textContent = t.name;
    btn.addEventListener("click", () => {
      if (btn.classList.contains("selected")) {
        btn.classList.remove("selected");
        picked = picked.filter((id) => id !== t.id);
      } else if (picked.length < 2) {
        btn.classList.add("selected");
        picked.push(t.id);
      }
      if (picked.length === 2) {
        socket.emit("gossipAction", { targetAId: picked[0], targetBId: picked[1] });
      }
    });
    grid.appendChild(btn);
  });
  panel.appendChild(grid);
}

function hideNightPanel() {
  document.getElementById("night-action-panel").classList.add("hidden");
}

// ---------- Vote panel ----------
function renderVotePanel(state) {
  const panel = document.getElementById("vote-panel");
  const me = state.players.find((p) => p.id === myId);
  if (state.phase !== "vote" || !me || !me.alive) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  const grid = document.getElementById("vote-targets");
  grid.innerHTML = "";
  state.players
    .filter((p) => p.alive)
    .forEach((p) => {
      const btn = document.createElement("button");
      btn.className = "target-btn";
      btn.textContent = p.name;
      btn.addEventListener("click", () => {
        grid.querySelectorAll(".target-btn").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        socket.emit("castVote", { targetId: p.id });
      });
      grid.appendChild(btn);
    });
}

// ---------- Game over ----------
function renderGameOver(state, winner) {
  showScreen("screen-gameover");
  const titles = {
    village: "🏆 The Village Wins",
    werewolf: "🐺 The Werewolves Win",
    tanner: "🃏 The Tanner Wins",
    chupacabra: "🐾 The Chupacabra Wins",
  };
  document.getElementById("gameover-title").textContent = titles[winner ? winner.type : ""] || "Game Over";

  const rolesDiv = document.getElementById("gameover-roles");
  rolesDiv.innerHTML = "";
  const winnerIds = winner ? winner.winners || [] : [];
  state.players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "row" + (winnerIds.includes(p.id) ? " winner" : "");
    const roleCls = ["werewolf", "tanner", "chupacabra"].includes(p.role) ? p.role : "";
    row.innerHTML = `<span>${escapeHtml(p.name)}${winnerIds.includes(p.id) ? " ⭐" : ""}</span><span class="role ${roleCls}">${
      ROLE_INFO[p.role] ? ROLE_INFO[p.role].label : "?"
    }</span>`;
    rolesDiv.appendChild(row);
  });

  const btn = document.getElementById("btn-play-again");
  btn.classList.toggle("hidden", !isModerator);
  document.getElementById("gameover-wait-hint").textContent = isModerator ? "" : "Waiting for the moderator to start a new round...";
}

// ---------- Socket listeners ----------
socket.on("connect", () => {
  myId = socket.id;
});

// Player-facing state
socket.on("state", (state) => {
  if (isModerator) return;
  currentState = state;

  if (state.phase === "lobby") {
    showScreen("screen-lobby");
    renderPlayerLobby(state);
    return;
  }
  if (state.phase === "gameover") {
    renderGameOver(state, lastWinner);
    return;
  }

  showScreen("screen-game");
  document.getElementById("game-code").textContent = state.code;
  document.getElementById("phase-pill").textContent = phaseLabel(state);
  renderRoster(document.getElementById("roster-list"), state.players, false);
  startTimerDisplay("timer-display", state.timerEndsAt, timerRef);
  updateChatHint(state);
  renderVotePanel(state);

  document.getElementById("storywait-panel").classList.toggle("hidden", state.phase !== "storywait");
  if (state.phase !== "night") hideNightPanel();
  document.getElementById("vote-panel").classList.toggle("hidden", state.phase !== "vote");
});

// Moderator-facing state
socket.on("modState", (state) => {
  if (!isModerator) return;
  currentState = state;

  if (state.phase === "gameover") {
    renderGameOver(state, lastWinner);
    return;
  }

  if (state.phase === "lobby") {
    showScreen("screen-mod-lobby");
    renderAssignList(state);
    return;
  }

  if (state.phase === "storywait" && state.dayNumber === 0) {
    showScreen("screen-mod-lobby");
    return;
  }

  showScreen("screen-mod-game");
  document.getElementById("mod-game-code").textContent = state.code;
  document.getElementById("mod-phase-pill").textContent = phaseLabel(state);
  renderRoster(document.getElementById("mod-roster-list"), state.players, true);
  startTimerDisplay("mod-timer-display", state.timerEndsAt, modTimerRef);
  document.getElementById("mod-story-gate").classList.toggle("hidden", state.phase !== "storywait");
});

socket.on("log", (entry) => {
  appendLogTo("event-log", entry.text);
  appendLogTo("mod-event-log", entry.text);
});

socket.on("modFeed", (entry) => appendLogTo("mod-feed", entry.text));
socket.on("modWolfChat", (msg) => appendLogTo("mod-wolf-chat", `${msg.name}: ${msg.text}`));

socket.on("gameover", (outcome) => {
  lastWinner = outcome;
  if (currentState) renderGameOver(currentState, outcome);
});

socket.on("role", (payload) => {
  myRole = payload.role;
  const info = ROLE_INFO[payload.role];
  document.getElementById("my-role-name").textContent = info.label;
  document.getElementById("my-role-desc").textContent = info.desc;
  const pack = document.getElementById("pack-mates");
  pack.textContent = payload.role === "werewolf" && payload.packMates.length ? "Your pack: " + payload.packMates.join(", ") : "";
});

socket.on("nightPrompt", (payload) => renderNightPanel(payload));

socket.on("seerResult", (payload) => {
  appendLogTo("event-log", `🔮 Vision: ${payload.name} is ${payload.isWolf ? "a WEREWOLF" : "not a werewolf"}.`);
});

socket.on("chupacabraResult", (payload) => {
  appendLogTo(
    "event-log",
    payload.hit
      ? `🐾 Your attack tore into ${payload.name} — they were a werewolf!`
      : `🐾 Your attack on ${payload.name} found nothing. They weren't a werewolf.`
  );
});

socket.on("gossipResult", (payload) => {
  appendLogTo("event-log", payload.acted ? "👂 One of the two you watched made a move in the dark." : "👂 Neither of the two you watched seemed to do anything.");
});

socket.on("chatMsg", (msg) => appendChat("", msg.name, msg.text));
socket.on("wolfChatMsg", (msg) => appendChat("wolf", msg.name, msg.text));
