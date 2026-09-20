# Village After Dark — a text-only Werewolf/Mafia game

A free, browser-based Werewolf game for you and your friends. No mic needed —
everything happens through text chat, with one person running the game as a
**moderator** who assigns roles by hand and narrates the story each night.

## What's inside

```
werewolf-game/
├── server.js          the whole backend: rooms, roles, phases, chat relay
├── package.json
└── public/
    ├── index.html      the page structure
    ├── style.css       the "night village" look
    └── client.js       all client-side logic
```

## Roles

- **Werewolf** — vote with the pack each night to kill someone. Any number.
- **Villager** — no power. The default for anyone the moderator doesn't assign.
- **Seer** — each night, check one player's true role.
- **Tanner** — wants to die. If the village votes out every Tanner, the
  village instantly loses. If wolves kill a Tanner instead, that Tanner wins
  personally when the game ends — and if 2+ wolves are alive, one of them
  dies too. Any number allowed.
- **Witch** — one power for the whole game: revive a dead player, or kill a
  living one. Used once, ever, on whichever night she chooses. One per game.
- **Knight** — protects one player a night from a werewolf attack. Can
  protect the same person again on a later night. One per game.
- **Chupacabra** — a solo role. Attacks one player a night; nothing happens
  unless the target is a werewolf. Wins alone if their attack kills the last
  werewolf — but if the village votes out the last werewolf first, they lose
  their only chance. One per game.
- **Gossip** — watches two players a night and learns only whether at least
  one of them took *any* night action (meaning they're not a plain
  Villager) — never who, never what. One per game.

Not every role has to be in every game — the moderator picks who plays what
before each round starts.

## The moderator

One person hosts the room as **moderator** and does not play — they can't
win or lose. They get a dashboard where they:
- manually assign every player's role before the game starts
- write a short story before Night 1, and before every night after that —
  the game pauses for players until it's sent
- see every role and the wolf-only chat at all times
- get a live feed of every action players take (who voted for whom, who the
  Seer checked, etc.) — players never see this
- can send a narrator "announcement" to everyone at any time
- can skip the current phase's timer early if everyone's ready

Players just join with a name and room code, get their role in a private
card, and can open a **role guide** at any time to read what every role does
(not just their own) — handy for taking their turn without hunting through
rules.

## 1. Run it locally first

You'll need [Node.js](https://nodejs.org) installed (this gives you `npm`).
Notepad++ is fine for editing the code — you just need Node installed
separately to actually *run* it.

```bash
cd werewolf-game
npm install
npm start
```

Then open `http://localhost:3000` in a browser. To test with friends on the
same wifi network, find your computer's local IP (e.g. `192.168.1.23`) and
have them open `http://192.168.1.23:3000` instead.

## 2. Put it online for free (so anyone can join, anywhere)

Once it works locally, push it to a free host. **Render** is the easiest:

1. Create a free account at [render.com](https://render.com).
2. Put this project in a GitHub repo (Render deploys from GitHub).
3. In Render, click **New → Web Service**, connect the repo.
4. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
5. Deploy. You'll get a URL like `https://your-game.onrender.com` — send
   that to your friends.

**The catch with free hosting:** the free tier "sleeps" after ~15 minutes of
no traffic. The first person to open the link after a quiet period will wait
20–50 seconds for it to wake up. After that it's instant for everyone until
it goes quiet again. Totally fine for a casual game night — just have
whoever's hosting open the link a minute before you start.

Alternatives that work the same way: [Fly.io](https://fly.io) (slightly less
aggressive sleep) or [Glitch](https://glitch.com) (lets you edit code
directly in the browser, no local setup at all — you could skip step 1
entirely and paste this code straight into a new Glitch project).

## 3. How to play

1. Whoever's running the game clicks **Enter the Village** → **Host as
   Moderator**. They get a 4-letter room code.
2. Everyone else clicks **Enter the Village** → **Join as a Player**, enters
   their name and that code.
3. Once at least 4 players have joined, the moderator assigns each one a
   role from a dropdown, then clicks **Lock in roles**.
4. The moderator writes an opening story and clicks **Send story & begin
   Night 1**. Every player sees the story, then night begins.
5. Each role with a night action gets a private prompt. Werewolves also get
   a private pack chat.
6. Each morning, the result is announced, then there's an open discussion
   timer, then a vote to eliminate someone.
7. Before every night after the first, the moderator writes a new short
   story before the night can begin — the village "waits" until then.
8. The game ends when a win condition is met (see the roles above for the
   Tanner and Chupacabra's special endings). The moderator can then start a
   fresh round with new role assignments.

## Notes on scope

This is intentionally simple — in-memory state only (no database), so if the
server restarts, active games are lost. That's fine for casual play. If you
want to extend it later: reconnect handling, more roles (Hunter, Witch),
spectator mode, and persistent stats are the natural next steps.
