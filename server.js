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
  res.json({ ok: true });
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

const robotTypes = [
  {
    id: "tank",
    name: "TANK-X",
    role: "Těžký robot",
    description: "Vydrží hodně zásahů, je pomalejší a dává silnější damage.",
    maxHp: 160,
    speed: 185,
    jumpForce: 390,
    cooldown: 0.45,
    bulletSpeed: 480,
    bulletDamage: 18,
    bulletCount: 1,
    spread: 0,
    bodyColor: "#7cff4d"
  },
  {
    id: "scout",
    name: "SCOUT-Z",
    role: "Lehký robot",
    description: "Je rychlý, skáče vysoko, ale má méně životů.",
    maxHp: 85,
    speed: 300,
    jumpForce: 520,
    cooldown: 0.22,
    bulletSpeed: 560,
    bulletDamage: 10,
    bulletCount: 1,
    spread: 0,
    bodyColor: "#00f6ff"
  },
  {
    id: "sniper",
    name: "SNIPER-V",
    role: "Dálkový robot",
    description: "Má rychlé projektily a velký zásah, ale střílí pomaleji.",
    maxHp: 95,
    speed: 235,
    jumpForce: 430,
    cooldown: 0.7,
    bulletSpeed: 880,
    bulletDamage: 28,
    bulletCount: 1,
    spread: 0,
    bodyColor: "#b47cff"
  },
  {
    id: "blaster",
    name: "BLASTER-Q",
    role: "Rozptylový robot",
    description: "Střílí tři projektily najednou a je nebezpečný na blízko.",
    maxHp: 110,
    speed: 245,
    jumpForce: 440,
    cooldown: 0.52,
    bulletSpeed: 520,
    bulletDamage: 9,
    bulletCount: 3,
    spread: 0.18,
    bodyColor: "#ff5bd2"
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

const state = {
  phase: "waiting", // waiting | selecting | playing | gameover
  players: {},
  bullets: [],
  winner: null
};

function robotById(id) {
  return robotTypes.find((r) => r.id === id);
}

function getActivePlayers() {
  return Object.values(state.players)
    .filter((p) => p.slot === 1 || p.slot === 2)
    .sort((a, b) => a.slot - b.slot);
}

function getPlayerBySlot(slot) {
  return getActivePlayers().find((p) => p.slot === slot);
}

function assignSlot() {
  const active = getActivePlayers();
  const slots = active.map((p) => p.slot);

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
    isSpectator: false,
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
    input: {
      left: false,
      right: false,
      jump: false,
      shoot: false
    }
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

function bothPlayersReady() {
  const active = getActivePlayers();
  if (active.length < 2) return false;
  return active.every((p) => p.ready && p.selectedRobotId);
}

function startMatch() {
  const active = getActivePlayers();
  if (active.length < 2) {
    state.phase = "waiting";
    return;
  }

  if (!bothPlayersReady()) {
    state.phase = "selecting";
    return;
  }

  for (const player of active) {
    resetPlayerForMatch(player);
  }

  state.bullets = [];
  state.winner = null;
  state.phase = "playing";
}

function updatePhaseByOccupancy() {
  const active = getActivePlayers();

  if (active.length < 2) {
    state.phase = "waiting";
    state.winner = null;
    state.bullets = [];
    return;
  }

  if (!bothPlayersReady()) {
    state.phase = "selecting";
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

function updatePlayer(player, dt) {
  if (player.hp <= 0) return;

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

    if (player.hp <= 0) {
      finishGame(player.slot === 1 ? 2 : 1);
      return;
    }
  }

  if (player.cooldown > 0) {
    player.cooldown -= dt;
  }

  if (player.input.shoot && player.cooldown <= 0) {
    if (player.bulletCount === 1) {
      state.bullets.push(spawnBullet(player, 0));
    } else {
      state.bullets.push(spawnBullet(player, -player.spread));
      state.bullets.push(spawnBullet(player, 0));
      state.bullets.push(spawnBullet(player, player.spread));
    }

    player.cooldown = player.cooldownTime;
  }
}

function updateBullets(dt) {
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    const owner = state.players[b.ownerId];
    if (!owner) {
      state.bullets.splice(i, 1);
      continue;
    }

    const target = getActivePlayers().find((p) => p.id !== b.ownerId);

    if (target && target.hp > 0 && rectsOverlap(b, target)) {
      target.hp = Math.max(0, target.hp - b.damage);
      state.bullets.splice(i, 1);

      if (target.hp <= 0) {
        finishGame(target.slot === 1 ? 2 : 1);
      }
      continue;
    }

    let hitPlatform = false;
    for (const p of platforms) {
      if (rectsOverlap(b, p)) {
        hitPlatform = true;
        break;
      }
    }

    if (
      hitPlatform ||
      b.x < -40 ||
      b.x > canvas.width + 40 ||
      b.y < -40 ||
      b.y > canvas.height + 40
    ) {
      state.bullets.splice(i, 1);
    }
  }
}

function finishGame(winnerSlot) {
  const winnerPlayer = getPlayerBySlot(winnerSlot);

  state.phase = "gameover";
  state.winner = {
    winnerSlot,
    message: winnerPlayer
      ? `${winnerPlayer.name} ovládl arénu.`
      : `Vyhrál Hráč ${winnerSlot}.`
  };
}

function publicState() {
  return {
    phase: state.phase,
    platforms,
    bullets: state.bullets,
    winner: state.winner,
    players: getActivePlayers().map((p) => ({
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
      role: p.role
    }))
  };
}

function broadcastState() {
  io.emit("state", publicState());
}

io.on("connection", (socket) => {
  const slot = assignSlot();

  if (slot === null) {
    state.players[socket.id] = {
      id: socket.id,
      isSpectator: true
    };
    socket.emit("spectator");
    socket.emit("serverMessage", "Server je plný. Tahle verze je jen pro 2 aktivní hráče.");
    return;
  }

  state.players[socket.id] = createPlayer(socket.id, slot);

  updatePhaseByOccupancy();
  broadcastState();

  socket.on("selectRobot", ({ robotId }) => {
    const player = state.players[socket.id];
    if (!player || player.isSpectator) return;
    if (state.phase === "playing") return;

    const robot = robotById(robotId);
    if (!robot) return;

    player.selectedRobotId = robotId;
    player.ready = true;

    updatePhaseByOccupancy();

    if (bothPlayersReady()) {
      startMatch();
      io.emit("serverMessage", "Oba hráči jsou připravení. Zápas začíná.");
    } else {
      io.emit("serverMessage", "Jeden hráč je připravený. Čeká se na druhého.");
    }

    broadcastState();
  });

  socket.on("input", (input) => {
    const player = state.players[socket.id];
    if (!player || player.isSpectator) return;
    if (state.phase !== "playing") return;

    player.input.left = !!input.left;
    player.input.right = !!input.right;
    player.input.jump = !!input.jump;
    player.input.shoot = !!input.shoot;
  });

  socket.on("requestRestart", () => {
    const player = state.players[socket.id];
    if (!player || player.isSpectator) return;
    if (state.phase !== "gameover") return;

    const active = getActivePlayers();
    if (active.length < 2) return;
    if (!active.every((p) => p.selectedRobotId)) return;

    startMatch();
    io.emit("serverMessage", "Rematch startuje.");
    broadcastState();
  });

  socket.on("disconnect", () => {
    delete state.players[socket.id];
    updatePhaseByOccupancy();
    broadcastState();
  });
});

let lastTime = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTime) / 1000, 0.033);
  lastTime = now;

  if (state.phase === "playing") {
    const active = getActivePlayers();
    for (const player of active) {
      updatePlayer(player, dt);
    }
    updateBullets(dt);
  }

  broadcastState();
}, 1000 / 60);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Allowed FRONTEND_URL: ${FRONTEND_URL}`);
});