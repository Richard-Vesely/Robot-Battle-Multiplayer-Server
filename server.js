/*
  Multiplayer architecture
  ========================

  - Authoritative server. Clients send only inputs; server simulates physics
    at 60Hz and broadcasts world state to each room.
  - Rooms isolate matches. Each room has its own state, players, bullets.
  - Broadcasts are scoped via Socket.IO rooms (io.to(code).emit).
  - Inputs are sticky: server keeps last value until next "input" event.
  - Spawn invulnerability (1s) prevents respawn-instakill.
  - Forfeit on mid-match disconnect: remaining player wins.
  - finishGame is idempotent — first slot to KO wins, no overwrite.
  - In non-"playing" phases the loop does NOT spam state every tick;
    state is broadcast only when something actually changes (joins, leaves,
    selectRobot, etc.).
  - On connect, server emits "config" with robotTypes so client UI is
    sourced from a single place (server.js).
*/

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://127.0.0.1:5500";

const allowedOrigins = [
  FRONTEND_URL,
  "https://richard-vesely.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    }
  })
);

app.get("/health", (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Socket.IO CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST"]
  }
});

const canvas = { width: 1100, height: 620 };
const gravity = 900;
const SPAWN_INVULN_S = 1.0;

const robotTypes = [
  {
    id: "tank",
    name: "TANK-X",
    role: "Těžký robot",
    description: "Vydrží hodně zásahů, je pomalejší a dává silnější damage.",
    maxHp: 160, speed: 185, jumpForce: 390,
    cooldown: 0.45, bulletSpeed: 480, bulletDamage: 18,
    bulletCount: 1, spread: 0, bodyColor: "#7cff4d"
  },
  {
    id: "scout",
    name: "SCOUT-Z",
    role: "Lehký robot",
    description: "Je rychlý, skáče vysoko, ale má méně životů.",
    maxHp: 85, speed: 300, jumpForce: 520,
    cooldown: 0.22, bulletSpeed: 560, bulletDamage: 10,
    bulletCount: 1, spread: 0, bodyColor: "#00f6ff"
  },
  {
    id: "sniper",
    name: "SNIPER-V",
    role: "Dálkový robot",
    description: "Má rychlé projektily a velký zásah, ale střílí pomaleji.",
    maxHp: 95, speed: 235, jumpForce: 430,
    cooldown: 0.7, bulletSpeed: 880, bulletDamage: 28,
    bulletCount: 1, spread: 0, bodyColor: "#b47cff"
  },
  {
    id: "blaster",
    name: "BLASTER-Q",
    role: "Rozptylový robot",
    description: "Střílí tři projektily najednou a je nebezpečný na blízko.",
    maxHp: 110, speed: 245, jumpForce: 440,
    cooldown: 0.52, bulletSpeed: 520, bulletDamage: 9,
    bulletCount: 3, spread: 0.18, bodyColor: "#ff5bd2"
  }
];

const platforms = [
  { x: 0, y: 570, width: 1100, height: 50 },

  { x: 40, y: 510, width: 140, height: 18 },
  { x: 220, y: 460, width: 140, height: 18 },
  { x: 400, y: 510, width: 140, height: 18 },
  { x: 580, y: 460, width: 140, height: 18 },
  { x: 760, y: 510, width: 140, height: 18 },
  { x: 920, y: 460, width: 140, height: 18 },

  { x: 120, y: 400, width: 140, height: 18 },
  { x: 300, y: 350, width: 140, height: 18 },
  { x: 480, y: 400, width: 140, height: 18 },
  { x: 660, y: 350, width: 140, height: 18 },
  { x: 840, y: 400, width: 140, height: 18 },

  { x: 210, y: 290, width: 140, height: 18 },
  { x: 390, y: 240, width: 140, height: 18 },
  { x: 570, y: 290, width: 140, height: 18 },
  { x: 750, y: 240, width: 140, height: 18 },

  { x: 300, y: 180, width: 140, height: 18 },
  { x: 480, y: 130, width: 140, height: 18 },
  { x: 660, y: 180, width: 140, height: 18 }
];

// rooms: Map<code, room>
const rooms = new Map();

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O for clarity

function generateRoomCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) {
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

function makeRoom() {
  const code = generateRoomCode();
  const room = {
    code,
    phase: "waiting", // waiting | selecting | playing | gameover
    players: {},
    bullets: [],
    winner: null,
    tick: 0
  };
  rooms.set(code, room);
  return room;
}

function robotById(id) {
  return robotTypes.find((r) => r.id === id);
}

function getActivePlayers(room) {
  return Object.values(room.players)
    .filter((p) => p.slot === 1 || p.slot === 2)
    .sort((a, b) => a.slot - b.slot);
}

function getPlayerBySlot(room, slot) {
  return getActivePlayers(room).find((p) => p.slot === slot);
}

function assignSlot(room) {
  const slots = getActivePlayers(room).map((p) => p.slot);
  if (!slots.includes(1)) return 1;
  if (!slots.includes(2)) return 2;
  return null;
}

function createPlayer(socketId, slot) {
  return {
    id: socketId,
    slot,
    selectedRobotId: null,
    ready: false,
    x: slot === 1 ? 90 : 970,
    y: 400,
    spawnX: slot === 1 ? 90 : 970,
    spawnY: 400,
    width: 44,
    height: 54,
    vx: 0,
    vy: 0,
    dir: slot === 1 ? 1 : -1,
    onGround: false,
    cooldown: 0,
    cooldownTime: 0.3,
    spawnInvuln: 0,
    hp: 100,
    maxHp: 100,
    speed: 200,
    jumpForce: 400,
    bulletSpeed: 500,
    bulletDamage: 10,
    bulletCount: 1,
    spread: 0,
    bodyColor: "#00f6ff",
    name: "Nezvolen",
    role: "-",
    typeId: "scout",
    input: { left: false, right: false, jump: false, shoot: false }
  };
}

function resetPlayerForMatch(player) {
  const robot = robotById(player.selectedRobotId);
  if (!robot) return;

  player.x = player.spawnX;
  player.y = player.spawnY;
  player.vx = 0;
  player.vy = 0;
  player.dir = player.slot === 1 ? 1 : -1;
  player.onGround = false;
  player.cooldown = 0;
  player.spawnInvuln = SPAWN_INVULN_S;

  player.selectedRobotId = robot.id;
  player.typeId = robot.id;
  player.name = robot.name;
  player.role = robot.role;
  player.bodyColor = robot.bodyColor;

  player.maxHp = robot.maxHp;
  player.hp = robot.maxHp;
  player.speed = robot.speed;
  player.jumpForce = robot.jumpForce;
  player.bulletSpeed = robot.bulletSpeed;
  player.bulletDamage = robot.bulletDamage;
  player.bulletCount = robot.bulletCount;
  player.spread = robot.spread;
  player.cooldownTime = robot.cooldown;
}

function bothPlayersReady(room) {
  const active = getActivePlayers(room);
  if (active.length < 2) return false;
  return active.every((p) => p.ready && p.selectedRobotId);
}

function startMatch(room) {
  const active = getActivePlayers(room);
  if (active.length < 2) {
    room.phase = "waiting";
    return;
  }
  if (!bothPlayersReady(room)) {
    room.phase = "selecting";
    return;
  }
  for (const player of active) resetPlayerForMatch(player);
  room.bullets = [];
  room.winner = null;
  room.phase = "playing";
}

function updatePhaseByOccupancy(room) {
  const active = getActivePlayers(room);

  if (active.length < 2) {
    // If we already finished, keep gameover so the remaining player can read
    // the winner overlay. They can leave manually.
    if (room.phase === "gameover") return;

    room.phase = "waiting";
    room.winner = null;
    room.bullets = [];
    for (const p of active) {
      p.ready = false;
      p.selectedRobotId = null;
    }
    return;
  }

  if (room.phase === "waiting") {
    room.phase = bothPlayersReady(room) ? "playing" : "selecting";
  }
}

function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function spawnBullet(player, angleOffset) {
  return {
    x: player.dir === 1 ? player.x + player.width + 4 : player.x - 12,
    y: player.y + player.height / 2,
    vx: player.dir * player.bulletSpeed,
    vy: angleOffset * player.bulletSpeed,
    width: 12,
    height: 4,
    ownerId: player.id,
    damage: player.bulletDamage,
    color: player.bodyColor
  };
}

function updatePlayer(room, player, dt) {
  if (player.hp <= 0) return;
  if (player.spawnInvuln > 0) player.spawnInvuln = Math.max(0, player.spawnInvuln - dt);

  player.vx = 0;
  if (player.input.left) {
    player.vx = -player.speed;
    player.dir = -1;
  }
  if (player.input.right) {
    player.vx = player.speed;
    player.dir = 1;
  }
  if (player.input.jump && player.onGround) {
    player.vy = -player.jumpForce;
    player.onGround = false;
  }

  player.vy += gravity * dt;
  const prevY = player.y;
  player.x += player.vx * dt;
  player.y += player.vy * dt;
  player.x = Math.max(0, Math.min(canvas.width - player.width, player.x));
  player.onGround = false;

  for (const p of platforms) {
    const wasAbove = prevY + player.height <= p.y + 4;
    if (
      player.x + player.width > p.x &&
      player.x < p.x + p.width &&
      player.y + player.height >= p.y &&
      player.y + player.height <= p.y + p.height + 18 &&
      player.vy >= 0 &&
      wasAbove
    ) {
      player.y = p.y - player.height;
      player.vy = 0;
      player.onGround = true;
    }
  }

  if (player.y > canvas.height + 250) {
    player.hp = Math.max(0, player.hp - 15);
    player.x = player.spawnX;
    player.y = player.spawnY;
    player.vx = 0;
    player.vy = 0;
    player.dir = player.slot === 1 ? 1 : -1;
    player.spawnInvuln = SPAWN_INVULN_S;
    if (player.hp <= 0) {
      finishGame(room, player.slot === 1 ? 2 : 1);
      return;
    }
  }

  if (player.cooldown > 0) player.cooldown -= dt;

  if (player.input.shoot && player.cooldown <= 0) {
    if (player.bulletCount === 1) {
      room.bullets.push(spawnBullet(player, 0));
    } else {
      room.bullets.push(spawnBullet(player, -player.spread));
      room.bullets.push(spawnBullet(player, 0));
      room.bullets.push(spawnBullet(player, player.spread));
    }
    player.cooldown = player.cooldownTime;
  }
}

function updateBullets(room, dt) {
  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const b = room.bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    const owner = room.players[b.ownerId];
    if (!owner) {
      room.bullets.splice(i, 1);
      continue;
    }

    const target = getActivePlayers(room).find((p) => p.id !== b.ownerId);
    if (
      target &&
      target.hp > 0 &&
      (target.spawnInvuln || 0) <= 0 &&
      rectsOverlap(b, target)
    ) {
      target.hp = Math.max(0, target.hp - b.damage);
      room.bullets.splice(i, 1);
      if (target.hp <= 0) finishGame(room, target.slot === 1 ? 2 : 1);
      continue;
    }

    let hitPlatform = false;
    for (const p of platforms) {
      if (rectsOverlap(b, p)) { hitPlatform = true; break; }
    }
    if (
      hitPlatform ||
      b.x < -40 || b.x > canvas.width + 40 ||
      b.y < -40 || b.y > canvas.height + 40
    ) {
      room.bullets.splice(i, 1);
    }
  }
}

function finishGame(room, winnerSlot) {
  if (room.phase === "gameover") return; // idempotent — first KO wins
  const winnerPlayer = getPlayerBySlot(room, winnerSlot);
  room.phase = "gameover";
  room.winner = {
    winnerSlot,
    message: winnerPlayer
      ? `${winnerPlayer.name} ovládl arénu.`
      : `Vyhrál Hráč ${winnerSlot}.`
  };
  // Clear inputs so a held key doesn't carry into rematch.
  for (const p of getActivePlayers(room)) {
    p.ready = false;
    p.input = { left: false, right: false, jump: false, shoot: false };
  }
  room.bullets = [];
}

function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    tick: room.tick,
    platforms,
    bullets: room.bullets,
    winner: room.winner,
    players: getActivePlayers(room).map((p) => ({
      id: p.id,
      slot: p.slot,
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      dir: p.dir,
      hp: p.hp,
      maxHp: p.maxHp,
      typeId: p.typeId,
      bodyColor: p.bodyColor,
      name: p.name,
      role: p.role,
      ready: p.ready,
      selectedRobotId: p.selectedRobotId,
      spawnInvuln: Math.max(0, p.spawnInvuln || 0)
    }))
  };
}

function broadcastState(room) {
  io.to(room.code).emit("state", publicState(room));
}

function leaveCurrentRoom(socket, reason) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.roomCode = null;
  socket.leave(code);
  if (!room) return;

  const wasPlayer = !!room.players[socket.id];
  const wasPlaying = room.phase === "playing";
  delete room.players[socket.id];

  if (Object.keys(room.players).length === 0) {
    rooms.delete(code);
    return;
  }

  if (wasPlayer && wasPlaying) {
    // Mid-match disconnect → remaining player wins by forfeit.
    const remaining = getActivePlayers(room)[0];
    if (remaining) {
      finishGame(room, remaining.slot);
      io.to(code).emit("serverMessage", "Druhý hráč odešel. Vyhráváš zápas.");
    } else {
      updatePhaseByOccupancy(room);
    }
  } else {
    updatePhaseByOccupancy(room);
    if (reason) io.to(code).emit("serverMessage", reason);
  }
  broadcastState(room);
}

function joinRoomFlow(socket, room) {
  const slot = assignSlot(room);
  if (slot === null) {
    socket.emit("roomError", { reason: "full", message: "Místnost je plná." });
    return false;
  }

  socket.data.roomCode = room.code;
  socket.join(room.code);
  room.players[socket.id] = createPlayer(socket.id, slot);
  updatePhaseByOccupancy(room);

  socket.emit("roomJoined", { code: room.code, slot });
  broadcastState(room);

  if (getActivePlayers(room).length === 2) {
    io.to(room.code).emit("serverMessage", "Druhý hráč připojen. Vyberte si roboty.");
  }
  return true;
}

io.on("connection", (socket) => {
  socket.data.roomCode = null;

  // One-shot config so client doesn't need to duplicate robotTypes.
  socket.emit("config", {
    robotTypes,
    canvas,
    spawnInvulnSeconds: SPAWN_INVULN_S
  });

  socket.on("createRoom", () => {
    if (socket.data.roomCode) leaveCurrentRoom(socket, null);
    const room = makeRoom();
    joinRoomFlow(socket, room);
  });

  socket.on("joinRoom", ({ code }) => {
    if (typeof code !== "string") {
      socket.emit("roomError", { reason: "invalid", message: "Neplatný kód." });
      return;
    }
    const normalized = code.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(normalized)) {
      socket.emit("roomError", { reason: "invalid", message: "Kód má 4 písmena." });
      return;
    }
    const room = rooms.get(normalized);
    if (!room) {
      socket.emit("roomError", { reason: "not_found", message: "Místnost neexistuje." });
      return;
    }
    if (socket.data.roomCode === normalized) return;
    if (socket.data.roomCode) leaveCurrentRoom(socket, null);
    joinRoomFlow(socket, room);
  });

  socket.on("leaveRoom", () => {
    leaveCurrentRoom(socket, "Hráč opustil místnost.");
  });

  socket.on("selectRobot", ({ robotId }) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const player = room.players[socket.id];
    if (!player) return;
    if (room.phase === "playing") return;

    const robot = robotById(robotId);
    if (!robot) return;

    player.selectedRobotId = robotId;
    player.ready = true;

    if (bothPlayersReady(room)) {
      startMatch(room);
      io.to(code).emit("serverMessage", "Oba hráči jsou připraveni. Zápas začíná.");
    } else if (getActivePlayers(room).length < 2) {
      room.phase = "waiting";
      io.to(code).emit("serverMessage", "Robot zvolen. Čeká se na druhého hráče.");
    } else {
      room.phase = "selecting";
      io.to(code).emit("serverMessage", "Jeden hráč připraven. Čeká se na druhého.");
    }

    broadcastState(room);
  });

  socket.on("input", (input) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    if (room.phase !== "playing") return;

    const player = room.players[socket.id];
    if (!player) return;

    player.input.left = !!input.left;
    player.input.right = !!input.right;
    player.input.jump = !!input.jump;
    player.input.shoot = !!input.shoot;
  });

  socket.on("requestRestart", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    if (room.phase !== "gameover") return;

    const player = room.players[socket.id];
    if (!player) return;

    const active = getActivePlayers(room);
    if (active.length < 2) return;
    if (!active.every((p) => p.selectedRobotId)) return;

    player.ready = true;
    if (active.every((p) => p.ready)) {
      startMatch(room);
      io.to(code).emit("serverMessage", "Rematch startuje.");
    } else {
      io.to(code).emit("serverMessage", "Jeden hráč chce hrát znovu. Čeká se na druhého.");
    }
    broadcastState(room);
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket, "Druhý hráč se odpojil.");
  });
});

let lastTime = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTime) / 1000, 0.033);
  lastTime = now;

  for (const room of rooms.values()) {
    if (room.phase === "playing") {
      const active = getActivePlayers(room);
      for (const player of active) updatePlayer(room, player, dt);
      updateBullets(room, dt);
      room.tick++;
      broadcastState(room);
    }
    // Non-playing phases: no per-tick broadcast — state pushes happen on
    // events (selectRobot, joinRoom, etc.). Saves bandwidth in the lobby.
  }
}, 1000 / 60);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Allowed FRONTEND_URL: ${FRONTEND_URL}`);
});
