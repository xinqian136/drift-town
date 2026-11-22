/* 漂流小镇 (Drift Town) — a 60-second 3D voxel collect-and-dodge game in the
 * spirit of Flotsam: pilot a raft, fish garbage out of the sea, dodge sharks,
 * and every few pieces a new building joins your floating town. Classic script:
 * the page provides window.THREE (three.js) and window.GAME = { title, rules,
 * slots: { slot: { tile, custom } }, assets: { slot: data URL } }. Characters
 * and ground are drawn in code until a slot holds the user's own art
 * (slots[slot].custom); then that image is used: camera-facing sprites for
 * characters, a repeating texture for the ground. */
(function () {
  'use strict';

  var GAME = window.GAME || {};
  var canvas = document.getElementById('game');
  var parentWindow = window.parent && window.parent !== window ? window.parent : null;

  function post(message) {
    if (!parentWindow) return;
    message.source = 'dsh-game-studio';
    try { parentWindow.postMessage(message, '*'); } catch (e) { /* the host may be gone */ }
  }
  function reportError(text) { post({ type: 'error', message: String(text).slice(0, 300) }); }
  window.addEventListener('error', function (event) { reportError(event.message || event.error || 'error'); });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    reportError((reason && reason.message) || reason || 'unhandled rejection');
  });

  /* 1. RULES — every gameplay value lives here, read from GAME.rules (game.json)
   * with these defaults; a wrong type falls back to the default. Distances are
   * world units: one ground block is 1 unit. */
  var DEFAULTS = {
    duration: 75,            // seconds per round
    hearts: 3,               // hits the hero can take
    heroSpeed: 6.5,          // units per second
    enemySpeed: 2.6,         // starting chase speed
    enemySpeedGrowth: 0.05,  // added to enemy speed every second
    enemySpawnEvery: 5,      // seconds between new enemies
    maxEnemies: 6,
    maxPickups: 8,           // floating garbage out there at once
    heroSize: 1.9,           // height in units
    enemySize: 1.7,
    pickupSize: 1.3,
    shield: { enabled: true, every: 5, seconds: 4 }, // every N pickups, N seconds of safety
    target: 24,              // garbage pieces that finish the floating town
    buildEvery: 6,           // garbage pieces between two buildings on the raft
    autoBuild: true,         // build automatically so the run keeps its rhythm
    dash: { cooldown: 3, speed: 15, time: 0.4 }, // the raft's burst of speed
    comboWindow: 4,          // seconds between pickups to keep a combo alive
    specialEvery: 8,         // seconds between special-item spawn attempts
    /* Survival layer (design doc stage 0–1): workbench → shelter → four pieces
     * of survival gear. Every number here is meant to be tuned from game.json
     * without touching code. Costs are in the same {wood, plastic, metal} shape
     * as the town buildings, so one cost line and one pay function serve both. */
    survival: {
      thirstRate: 1.5,            // canteen points drained per second
      hungerRate: 0.6,            // food points drained per second (once the belly bar is on)
      starveEvery: 1.6,           // seconds between hearts lost on an empty belly
      selfSustainSec: 60,         // hold water and food above zero this long → town unlocked
      shelterCountsAsTown: true,  // the shelter is a dwelling, so it counts toward 镇 x/6
      rainEvery: 8, rainAmount: 8,        // 集雨器: rainwater into the canteen
      fishEvery: 10, fishAmount: 6,       // 鱼篓: a little food over time
      purifyEvery: 5, purifyAmount: 12,   // 净水器: steady clean water
      foodDropEvery: 9, foodDropAmount: 26, // seconds between floating food, and its value
      workbench: { wood: 4, plastic: 0, metal: 0 },
      shelter: { wood: 8, plastic: 2, metal: 0 },
      rainCatcher: { wood: 3, plastic: 2, metal: 0 },
      fishBasket: { wood: 4, plastic: 0, metal: 0 },
      scoopNet: { wood: 3, plastic: 0, metal: 0 },
      purifier: { wood: 4, plastic: 0, metal: 2 }
    },
    worldSize: 34,           // sea diameter in blocks
    seed: 7,                 // island shape
    palette: {
      skyTop: '#1d2550', skyBottom: '#e58a6a', fog: '#6f5a7e', grass: '#6bab5c',
      dirt: '#8b6446', sand: '#e6cf96', water: '#3f7fb3', accent: '#ffc463'
    }
  };

  function merge(fallback, value) {
    if (typeof fallback === 'number') return typeof value === 'number' && isFinite(value) ? value : fallback;
    if (typeof fallback === 'string') return typeof value === 'string' && value ? value : fallback;
    if (typeof fallback === 'boolean') return typeof value === 'boolean' ? value : fallback;
    var out = {};
    for (var key in fallback) out[key] = merge(fallback[key], value && typeof value === 'object' ? value[key] : undefined);
    return out;
  }
  var R = merge(DEFAULTS, GAME.rules || {});
  var SLOTS = GAME.slots || {};
  var ASSETS = GAME.assets || {};
  var TITLE = GAME.title || '漂流小镇';
  function customArt(slot) { return !!(SLOTS[slot] && SLOTS[slot].custom && ASSETS[slot]); }

  /* 2. RENDERER — fail readably when WebGL is unavailable. */
  var THREE = window.THREE;
  var renderer;
  try {
    if (!THREE) throw new Error('the three.js runtime is missing');
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (error) {
    // WebGL is unavailable: say so on the canvas itself — no DOM, so it also works on WeChat.
    try {
      var ctx2d = canvas.getContext('2d');
      if (ctx2d) {
        var ew = canvas.width || 300, eh = canvas.height || 150;
        ctx2d.fillStyle = '#1d2550';
        ctx2d.fillRect(0, 0, ew, eh);
        ctx2d.fillStyle = '#fff';
        ctx2d.font = '16px system-ui,sans-serif';
        ctx2d.textAlign = 'center';
        ctx2d.fillText('This game needs WebGL, which is not available here (' + (error && error.message || error) + ').', ew / 2, eh / 2);
      }
    } catch (e) { /* nothing more we can do */ }
    reportError('WebGL unavailable: ' + (error && error.message || error));
    window.__gameState = function () { return { phase: 'error', score: 0, renderer: 'none' }; };
    return;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false; // the frame() loop clears, then draws the world and the HUD quad
  canvas.style.background = 'linear-gradient(to bottom,' + R.palette.skyTop + ' 0%,' + R.palette.skyTop + ' 18%,' + R.palette.skyBottom + ' 100%)';

  var scene = new THREE.Scene();
  scene.fog = new THREE.Fog(R.palette.fog, 30, 90);
  var camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500);

  /* 3. HELPERS */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rand = mulberry32(Math.round(R.seed) * 2654435761);
  var hashSeed = Math.round(R.seed) * 374761393;
  function hash2(x, z) {
    var h = (x * 374761393 + z * 668265263 + hashSeed) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function valueNoise(x, z) {
    var xi = Math.floor(x), zi = Math.floor(z), xf = smooth(x - xi), zf = smooth(z - zi);
    return lerp(lerp(hash2(xi, zi), hash2(xi + 1, zi), xf), lerp(hash2(xi, zi + 1), hash2(xi + 1, zi + 1), xf), zf);
  }
  function fbm(x, z) { return valueNoise(x, z) * 0.62 + valueNoise(x * 2.1 + 17, z * 2.1 + 5) * 0.28 + valueNoise(x * 4.3 + 3, z * 4.3 + 11) * 0.1; }
  function color(hex) { return new THREE.Color(hex); }

  /** A small radial-gradient texture drawn on a 2D canvas (glows, shadows, the moon). */
  function radialTexture(stops, size) {
    var c = document.createElement('canvas');
    c.width = c.height = size || 128;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(c.width / 2, c.height / 2, 0, c.width / 2, c.height / 2, c.width / 2);
    for (var i = 0; i < stops.length; i++) grad.addColorStop(stops[i][0], stops[i][1]);
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    var texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
  var GLOW = radialTexture([[0, 'rgba(255,230,160,1)'], [0.25, 'rgba(255,196,99,0.55)'], [1, 'rgba(255,170,60,0)']]);
  var BLOB = radialTexture([[0, 'rgba(0,0,0,0.5)'], [0.6, 'rgba(0,0,0,0.25)'], [1, 'rgba(0,0,0,0)']], 64);

  /**
   * Merge boxes into one mesh with vertex colours, so a whole character is one
   * draw call. Each box is [x, y, z, w, h, d, colour, glow]; glowing boxes go
   * into a second, unlit mesh.
   */
  function voxelModel(boxes) {
    var parts = [[], []];
    for (var i = 0; i < boxes.length; i++) parts[boxes[i][7] ? 1 : 0].push(boxes[i]);
    var group = new THREE.Group();
    for (var p = 0; p < 2; p++) {
      if (!parts[p].length) continue;
      var positions = [], normals = [], colors = [], indices = [];
      for (var b = 0; b < parts[p].length; b++) {
        var box = parts[p][b];
        var geo = new THREE.BoxGeometry(box[3], box[4], box[5]);
        geo.translate(box[0], box[1], box[2]);
        var pos = geo.attributes.position, nor = geo.attributes.normal, base = positions.length / 3;
        var tint = color(box[6]);
        for (var v = 0; v < pos.count; v++) {
          positions.push(pos.getX(v), pos.getY(v), pos.getZ(v));
          normals.push(nor.getX(v), nor.getY(v), nor.getZ(v));
          colors.push(tint.r, tint.g, tint.b);
        }
        var index = geo.index.array;
        for (var k = 0; k < index.length; k++) indices.push(base + index[k]);
        geo.dispose();
      }
      var merged = new THREE.BufferGeometry();
      merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      merged.setIndex(indices);
      merged.computeBoundingSphere();
      var material = p === 0 ? new THREE.MeshLambertMaterial({ vertexColors: true }) : new THREE.MeshBasicMaterial({ vertexColors: true });
      var mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = p === 0;
      group.add(mesh);
    }
    return group;
  }

  /* 4. SEA — open water with a few low sandbars, stacked blocks like the island had. */
  var N = clamp(Math.round(R.worldSize), 16, 64);
  var HALF = N / 2;
  var WATER_Y = 0.55;
  var height = new Int8Array(N * N);   // 0 = water, otherwise blocks stacked from y = 0
  var sandy = new Uint8Array(N * N);
  var solid = new Uint8Array(N * N);   // trees and rocks block movement
  for (var gx = 0; gx < N; gx++) {
    for (var gz = 0; gz < N; gz++) {
      var wx = gx - HALF + 0.5, wz = gz - HALF + 0.5;
      var d = Math.sqrt(wx * wx + wz * wz) / HALF;
      var n = fbm(gx * 0.11, gz * 0.11);
      var land = 0.10 - d * 0.5 + (n - 0.5) * 0.6;
      var i0 = gx * N + gz;
      if (land < 0.19) continue;
      var h = 1 + Math.floor(clamp(land, 0, 1) * 1.6 + n * 0.5);
      height[i0] = clamp(h, 1, 2);
      sandy[i0] = 1;
    }
  }
  function cell(x, z) {
    var cx = Math.floor(x + HALF), cz = Math.floor(z + HALF);
    return cx < 0 || cz < 0 || cx >= N || cz >= N ? -1 : cx * N + cz;
  }
  function groundAt(x, z) { var c = cell(x, z); return c < 0 ? 0 : height[c]; }
  function walkable(x, z) { return Math.hypot(x, z) < HALF - 0.6; } // the whole open sea belongs to the raft
  function floatY(x, z) { return Math.max(groundAt(x, z), WATER_Y); } // everything rides the water surface
  function cellCenter(index) { return { x: Math.floor(index / N) - HALF + 0.5, z: (index % N) - HALF + 0.5 }; }
  function isShore(index) {
    var cx = Math.floor(index / N), cz = index % N;
    if (!height[index]) return false;
    for (var dx = -1; dx <= 1; dx++) for (var dz = -1; dz <= 1; dz++) {
      var x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= N || z >= N || !height[x * N + z]) return true;
    }
    return false;
  }

  // Decoration: a palm here and there on the sandbars, never where the hero starts.
  var trees = [], rocks = [];
  for (var t = 0; t < N * N; t++) {
    if (!height[t]) continue;
    var at = cellCenter(t);
    if (Math.abs(at.x) < 3 && Math.abs(at.z) < 3) continue;
    if (rand() < 0.4) { trees.push(t); solid[t] = 1; }
  }

  var BOX = new THREE.BoxGeometry(1, 1, 1);
  var dummy = new THREE.Object3D();
  function blockMesh(count, material) {
    var mesh = new THREE.InstancedMesh(BOX, material, Math.max(1, count));
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }
  function addBlock(mesh, x, y, z, sx, sy, sz, tint) {
    dummy.position.set(x, y, z);
    dummy.scale.set(sx, sy, sz);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(mesh.count, dummy.matrix);
    mesh.setColorAt(mesh.count, tint);
    mesh.count++;
  }

  var columns = 0, stacked = 0;
  for (var q = 0; q < N * N; q++) if (height[q]) { columns++; stacked += height[q]; }
  var groundTexture = null;
  if (customArt('background')) {
    groundTexture = new THREE.TextureLoader().load(ASSETS.background);
    groundTexture.colorSpace = THREE.SRGBColorSpace;
  }
  var tops = blockMesh(columns, new THREE.MeshLambertMaterial(groundTexture ? { map: groundTexture } : {}));
  var sides = blockMesh(stacked, new THREE.MeshLambertMaterial());
  var tint = new THREE.Color();
  for (var s = 0; s < N * N; s++) {
    if (!height[s]) continue;
    var c0 = cellCenter(s), top = height[s];
    var jitter = 0.9 + hash2(s, 99) * 0.14;
    if (groundTexture) tint.setRGB(jitter, jitter, jitter);
    else tint.set(sandy[s] ? R.palette.sand : R.palette.grass).multiplyScalar(jitter);
    addBlock(tops, c0.x, top - 0.5, c0.z, 1, 1, 1, tint);
    for (var y = 0; y < top - 1; y++) {
      tint.set(sandy[s] ? R.palette.sand : R.palette.dirt).multiplyScalar((0.75 + y * 0.06) * (0.92 + hash2(s, y) * 0.1));
      addBlock(sides, c0.x, y + 0.5, c0.z, 1, 1, 1, tint);
    }
  }
  tops.instanceMatrix.needsUpdate = sides.instanceMatrix.needsUpdate = true;

  var trunks = blockMesh(trees.length * 2, new THREE.MeshLambertMaterial());
  var leaves = blockMesh(trees.length * 13, new THREE.MeshLambertMaterial());
  var stones = blockMesh(rocks.length * 2, new THREE.MeshLambertMaterial());
  var LEAF_TONES = ['#3f7d4a', '#4b8f50', '#356b45', '#5a9a52'];
  trees.forEach(function (index, k) {
    var p = cellCenter(index), base = height[index];
    addBlock(trunks, p.x, base + 0.6, p.z, 0.42, 1.2, 0.42, tint.set('#6b4a32'));
    var tall = 1.3 + (k % 2) * 0.5;
    for (var lx = -1; lx <= 1; lx++) for (var lz = -1; lz <= 1; lz++) {
      if (lx && lz && hash2(index, lx * 3 + lz) < 0.5) continue;
      addBlock(leaves, p.x + lx * 0.62, base + tall + 0.45, p.z + lz * 0.62, 0.66, 0.66, 0.66, tint.set(LEAF_TONES[(k + lx + lz + 4) % 4]));
    }
    addBlock(leaves, p.x, base + tall + 1.05, p.z, 0.7, 0.62, 0.7, tint.set(LEAF_TONES[k % 4]));
  });
  rocks.forEach(function (index, k) {
    var p = cellCenter(index), base = height[index];
    addBlock(stones, p.x, base + 0.3, p.z, 0.8, 0.6, 0.7, tint.set('#8a8f98'));
    if (k % 2) addBlock(stones, p.x + 0.15, base + 0.75, p.z - 0.1, 0.45, 0.35, 0.45, tint.set('#a3a8b0'));
  });
  [trunks, leaves, stones].forEach(function (mesh) { mesh.instanceMatrix.needsUpdate = true; });

  // Water: an animated plane of rolling waves, over a darker sea floor.
  var waterGeo = new THREE.PlaneGeometry(N * 4.4, N * 4.4, 42, 42);
  waterGeo.rotateX(-Math.PI / 2);
  var waterBase = waterGeo.attributes.position.array.slice();
  var water = new THREE.Mesh(waterGeo, new THREE.MeshLambertMaterial({ color: R.palette.water, transparent: true, opacity: 0.78, depthWrite: false }));
  water.position.y = WATER_Y;
  water.receiveShadow = true;
  scene.add(water);
  // The deep-water zone marker: a warm ring on the surface and a subtle glow,
  // so the riskiest loot is always findable at a glance.
  var zoneRing = new THREE.Mesh(
    new THREE.RingGeometry(1, 1.09, 64),
    new THREE.MeshBasicMaterial({ color: '#ffd166', transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
  );
  zoneRing.rotation.x = -Math.PI / 2;
  zoneRing.position.y = WATER_Y + 0.14;
  scene.add(zoneRing);
  var zoneDisc = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.13, depthWrite: false })
  );
  zoneDisc.rotation.x = -Math.PI / 2;
  zoneDisc.position.y = WATER_Y + 0.1;
  scene.add(zoneDisc);
  var floor = new THREE.Mesh(new THREE.CircleGeometry(N * 2.2, 32), new THREE.MeshBasicMaterial({ color: color(R.palette.water).multiplyScalar(0.35) }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.6;
  scene.add(floor);

  // Lights: a cool sky, a warm low sun, and a hint of fill.
  scene.add(new THREE.HemisphereLight('#cfe8ff', '#3a7f92', 1.05));
  var sun = new THREE.DirectionalLight('#ffe9c0', 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -22;
  sun.shadow.camera.right = sun.shadow.camera.top = 22;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 80;
  sun.shadow.bias = -0.0008;
  scene.add(sun, sun.target);

  // Sky dressing: a warm high sun, far away. (Stars stay hidden in daylight.)
  var starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(0), 3));
  var stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0 }));
  stars.visible = false;
  scene.add(stars);
  var moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture([[0, '#fffbe0'], [0.34, '#ffe9a8'], [0.46, 'rgba(255,225,150,0.35)'], [1, 'rgba(255,215,130,0)']]), fog: false, depthWrite: false }));
  moon.scale.set(34, 34, 1);
  scene.add(moon);

  // Sun glints sparkling on the waves.
  var FLY_COUNT = 48, flyGeo = new THREE.BufferGeometry(), flyBase = [];
  for (var f = 0; f < FLY_COUNT; f++) flyBase.push((rand() - 0.5) * N * 0.9, 0.8 + rand() * 0.7, (rand() - 0.5) * N * 0.9, rand() * 10);
  flyGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(FLY_COUNT * 3), 3));
  var flies = new THREE.Points(flyGeo, new THREE.PointsMaterial({ map: GLOW, color: '#f2ffff', size: 0.4, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(flies);

  // Drifting clouds, high above the waves and far from the play area.
  var clouds = [];
  for (var cl = 0; cl < 7; cl++) {
    var clw = 3.6 + rand() * 2.6;
    var clh = 1.5 + rand() * 0.9;
    var cloud = voxelModel([
      [0, 0, 0, clw, clh, clw * 0.72, '#ffffff'],
      [clw * 0.55, clh * 0.22, 0.2, clw * 0.62, clh * 0.78, clw * 0.5, '#f7fbff'],
      [-clw * 0.5, clh * 0.16, -0.15, clw * 0.56, clh * 0.72, clw * 0.46, '#f2f8ff'],
      [clw * 0.1, -clh * 0.28, 0, clw * 0.9, clh * 0.4, clw * 0.6, '#e9f2fb']
    ]);
    cloud.position.set((rand() - 0.5) * 130, 38 + rand() * 14, (rand() - 0.5) * 130);
    cloud.scale.setScalar(1.6 + rand() * 1.1);
    scene.add(cloud);
    clouds.push(cloud);
  }
  var GULL_BOXES = [
    [0, 0, 0, 0.9, 0.5, 1.4, '#fdfdfd'], [0, 0.18, 0.5, 0.5, 0.35, 0.5, '#fdfdfd'], [0, 0.18, 0.5, 0.12, 0.2, 0.14, '#e8a13c'],
    [-0.85, 0.25, 0, 0.9, 0.16, 0.5, '#ffffff'], [0.85, 0.25, 0, 0.9, 0.16, 0.5, '#ffffff']
  ];
  var gulls = [];
  for (var gl = 0; gl < 3; gl++) {
    var gull = voxelModel(GULL_BOXES);
    scene.add(gull);
    gulls.push({ node: gull, r: 7 + gl * 3.5, a: rand() * 6, y: 7 + gl * 1.6, speed: 0.5 + gl * 0.14 });
  }
  // Schools of little fish, circling well under the surface and kept small.
  var FISH_BOXES = [
    [0, 0, 0, 0.3, 0.18, 0.62, '#3f8fa0'], [0, 0.02, -0.36, 0.22, 0.14, 0.22, '#357f90'],
    [0, 0.02, 0.36, 0.14, 0.1, 0.22, '#3f8fa0'], [0.14, 0.04, 0.08, 0.09, 0.09, 0.09, '#0f2a33']
  ];
  var fish = [], fishModel = voxelModel(FISH_BOXES);  var fishMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.5 });
  fishModel.traverse(function (n) { if (n.isMesh) n.material = fishMat; });
  for (var fs = 0; fs < 5; fs++) {
    var fnode = fishModel.clone();
    var ang = rand() * 6.283, rad = 7 + rand() * 8;
    scene.add(fnode);
    fish.push({
      node: fnode, cx: Math.cos(ang) * rad, cz: Math.sin(ang) * rad,
      r: 0.6 + rand() * 0.9, a: rand() * 6.283, speed: 0.55 + rand() * 0.6
    });
  }

  /* 5. CHARACTERS — detailed voxel models, drawn in code; a slot holding the
   * user's own art replaces its model wholesale (sprites / ground texture). */

  /** An array that also knows how to push a box: [x, y, z, w, h, d, colour, glow]. */
  function boxList() {
    var list = [];
    list.add = function (x, y, z, w, h, d, c, g) { list.push([x, y, z, w, h, d, c, g === true]); };
    return list;
  }
  /** A box list plus every box mirrored across x — fins, eyes, windows, posts. */
  function withMirror(boxes) {
    var out = [];
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (b[0] !== 0) out.push([-b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
      out.push(b);
    }
    return out;
  }

  /* --- The raft: an elliptical hull of lashed planks, a mast, and a tiny crew. --- */
  var HERO_BOXES = (function buildRaft() {
    var B = boxList(), TONE = ['#9c6d3e', '#a97845', '#8f6135', '#b4834d'];
    var LEN = 4.0, WID = 3.0, strip = 0, z, k, w;
    for (z = -LEN; z <= LEN + 1e-6; z += 0.32) {              // hull strips, elliptical
      k = 1 - Math.pow(z / (LEN + 0.55), 2);
      if (k <= 0.05) continue;
      w = WID * Math.sqrt(k);
      B.add(0, 0.34, z, w * 2, 0.62, 0.3, TONE[strip++ % 4]); // side band
      B.add(0, -0.14, z, w * 1.78, 0.4, 0.3, '#664423');       // belly
      B.add(-w + 0.16, 0.74, z, 0.32, 0.26, 0.3, '#cba76d');   // gunwales
      B.add(w - 0.16, 0.74, z, 0.32, 0.26, 0.3, '#cba76d');
    }
    strip = 0;
    for (z = -LEN + 0.22; z <= LEN - 0.18; z += 0.4) {         // deck planks
      k = 1 - Math.pow(z / (LEN + 0.55), 2);
      w = WID * Math.sqrt(Math.max(0.04, k)) - 0.42;
      B.add(0, 0.71, z, w * 2, 0.12, 0.36, strip++ % 2 ? '#c9a069' : '#bb9159');
    }
    [-2.75, -0.5, 1.75].forEach(function (rz) {                // rope lashings
      var kk = 1 - Math.pow(rz / (LEN + 0.55), 2), ww = WID * Math.sqrt(Math.max(0.05, kk));
      B.add(0, 0.79, rz, ww * 2 - 0.55, 0.07, 0.11, '#7a5a34');
    });
    B.add(0, 1.85, -2.95, 0.15, 2.2, 0.15, '#7d5530');         // mast
    B.add(0, 1.35, -2.95, 0.5, 0.22, 0.5, '#5e4024');          // mast step
    B.add(0.46, 2.66, -2.95, 0.92, 0.46, 0.1, '#ff8a4c');      // flag
    B.add(0.46, 2.66, -2.95, 0.92, 0.1, 0.11, '#e2574c');
    B.add(2.25, 1.32, 2.42, 0.1, 1.2, 0.1, '#6b4a2c');         // lantern post
    B.add(2.25, 1.98, 2.42, 0.34, 0.42, 0.34, '#ffd98a', true);
    B.add(2.25, 2.24, 2.42, 0.42, 0.1, 0.42, '#5c4028');
    B.add(-2.05, 1.02, 2.25, 0.6, 0.72, 0.6, '#a97845');       // barrel
    B.add(-2.05, 1.4, 2.25, 0.66, 0.1, 0.66, '#7d5530');
    B.add(-2.1, 0.98, 1.3, 0.74, 0.56, 0.74, '#c9a069');       // crate
    B.add(-2.1, 1.0, 1.3, 0.8, 0.13, 0.8, '#8f6135');
    B.add(1.95, 0.98, 1.35, 0.42, 0.44, 0.42, '#8fa3b8');      // bucket
    B.add(0.85, 1.02, 2.6, 0.08, 1.0, 0.08, '#6b4a2c');        // fishing rod
    B.add(0.85, 1.55, 2.6, 0.06, 0.5, 0.06, '#8a6b48');
    B.add(0.85, 1.3, 2.85, 0.05, 0.6, 0.05, '#8a6b48');
    // The little rafter who runs the town.
    var fx = 0, fy = 0.78, fz = 2.2;
    B.add(fx - 0.13, fy + 0.2, fz, 0.2, 0.42, 0.24, '#2f4a6b');
    B.add(fx + 0.13, fy + 0.2, fz, 0.2, 0.42, 0.24, '#2f4a6b');
    B.add(fx, fy + 0.7, fz, 0.62, 0.6, 0.38, '#e2574c');
    B.add(fx - 0.4, fy + 0.68, fz, 0.17, 0.48, 0.21, '#f2c99a');
    B.add(fx + 0.4, fy + 0.68, fz, 0.17, 0.48, 0.21, '#f2c99a');
    B.add(fx, fy + 1.2, fz, 0.52, 0.5, 0.48, '#f2c99a');
    B.add(fx - 0.12, fy + 1.26, fz + 0.23, 0.1, 0.1, 0.07, '#2b2b2b');
    B.add(fx + 0.12, fy + 1.26, fz + 0.23, 0.1, 0.1, 0.07, '#2b2b2b');
    B.add(fx, fy + 1.5, fz, 0.94, 0.1, 0.9, '#e8c87a');        // straw hat
    B.add(fx, fy + 1.62, fz, 0.54, 0.22, 0.54, '#d9b264');
    return B;
  })();

  /** A shark as seen from above (the game camera looks down): a flat, tapered
   *  body lying in the water with its dorsal fin sticking out of the surface.
   *  Segments are [z, halfWidth, thickness, yOffset] from nose to tail. */
  function buildShark(body, belly, fin, eye) {
    var B = boxList(), i, s;
    var segs = [
      [2.30, 0.20, 0.16, 0.02], [2.05, 0.40, 0.24, 0.01], [1.75, 0.55, 0.28, 0.00],
      [1.40, 0.64, 0.30, 0.00], [1.00, 0.68, 0.30, 0.00], [0.55, 0.66, 0.28, 0.00],
      [0.10, 0.58, 0.26, 0.00], [-0.35, 0.46, 0.22, 0.00], [-0.80, 0.33, 0.18, 0.00],
      [-1.20, 0.23, 0.14, 0.00], [-1.55, 0.14, 0.11, 0.00], [-1.78, 0.08, 0.09, 0.00]
    ];
    for (i = 0; i < segs.length; i++) {
      s = segs[i];
      B.add(0, 0, s[0], s[1] * 2, s[2], 0.4, body);            // flat body in the water
      B.add(0, -s[2] * 0.42, s[0], s[1] * 1.6, s[2] * 0.5, 0.41, belly); // pale underside
    }
    B.add(0, 0.26, 0.7, 0.22, 0.5, 0.7, body);                 // dorsal fin above the surface
    B.add(0, 0.52, 0.66, 0.16, 0.3, 0.46, fin);
    B.add(0, 0.5, -1.92, 0.14, 0.2, 0.5, fin);                 // tail fin, flat
    B.add(0, 0.5, -2.05, 0.9, 0.16, 0.18, fin);
    var sides = [];
    sides.push([0.72, 0.02, 0.9, 0.66, 0.14, 0.5, fin]);       // pectoral fins, flat and wide
    sides.push([0.5, 0.02, -0.45, 0.44, 0.11, 0.36, fin]);     // pelvic fins
    sides.push([0.34, 0.1, 1.9, 0.17, 0.14, 0.14, eye]);       // eyes
    sides.push([0.62, 0.02, 1.0, 0.08, 0.1, 0.36, '#20303c']); // gills
    sides.push([0.63, 0.02, 0.8, 0.07, 0.1, 0.32, '#20303c']);
    sides.push([0.6, 0.02, 0.6, 0.07, 0.1, 0.28, '#20303c']);
    sides.push([0.16, 0.06, 2.24, 0.14, 0.1, 0.16, '#ffffff']); // teeth
    sides.push([0, 0.05, 2.3, 0.36, 0.09, 0.1, '#f7fbff']);
    return withMirror(B.concat ? B.concat(sides) : B);
  }
  var SHARK_BOXES = buildShark('#5d7f9c', '#eaf2f6', '#4f6f8c', '#16222e');

  /** The hammerhead: the same flat swimmer, with a wide flat head and eyes on its tips. */
  var HAMMER_BOXES = (function buildHammer() {
    var B = boxList(), i, s;
    var segs = [
      [2.05, 0.22, 0.18, 0.00], [1.88, 0.34, 0.24, 0.00], [1.66, 0.52, 0.28, 0.00],
      [1.32, 0.62, 0.30, 0.00], [0.95, 0.66, 0.30, 0.00], [0.50, 0.64, 0.28, 0.00],
      [0.05, 0.56, 0.26, 0.00], [-0.40, 0.44, 0.22, 0.00], [-0.85, 0.31, 0.18, 0.00],
      [-1.25, 0.21, 0.14, 0.00], [-1.60, 0.13, 0.11, 0.00]
    ];
    for (i = 0; i < segs.length; i++) {
      s = segs[i];
      B.add(0, 0, s[0], s[1] * 2, s[2], 0.4, '#8d9c9a');
      B.add(0, -s[2] * 0.42, s[0], s[1] * 1.55, s[2] * 0.5, 0.41, '#eef4f0');
    }
    B.add(0, 0.24, 0.62, 0.21, 0.46, 0.66, '#8d9c9a');         // dorsal fin
    B.add(0, 0.48, 0.58, 0.15, 0.28, 0.44, '#7b8a88');
    B.add(0, 0.48, -1.96, 0.14, 0.18, 0.5, '#7b8a88');         // tail
    B.add(0, 0.48, -2.08, 0.86, 0.15, 0.18, '#7b8a88');
    var sides = [];
    sides.push([0.7, 0.02, 0.82, 0.62, 0.13, 0.46, '#7b8a88']); // pectorals
    sides.push([0.48, 0.02, -0.45, 0.42, 0.1, 0.34, '#7b8a88']);
    sides.push([1.15, 0.0, 1.8, 0.9, 0.2, 0.42, '#8d9c9a']);    // the hammer lobe
    sides.push([1.62, 0.02, 1.8, 0.16, 0.16, 0.36, '#8d9c9a']);
    sides.push([1.6, 0.08, 1.86, 0.12, 0.12, 0.12, '#16222e']); // eye on the tip
    sides.push([0.2, 0.06, 2.0, 0.3, 0.09, 0.16, '#ffffff']);   // teeth
    return withMirror(B.concat ? B.concat(sides) : B);
  })();

  /* --- Floating garbage: each kind has its own look and its own value.
   *  The camera looks straight down, so silhouettes are built to read from above. --- */
  var BOTTLE_BOXES = [
    [0, 0.3, -0.1, 0.72, 0.6, 1.5, '#3fae7a'], [0, 0.3, 0.82, 0.56, 0.46, 0.4, '#5cc98f'],
    [0, 0.3, 1.08, 0.34, 0.32, 0.26, '#2f7fd8'], [0, 0.48, -0.15, 0.74, 0.18, 0.8, '#eaf7ff'],
    [0, 0.3, 0.16, 0.76, 0.36, 0.44, '#8ee3b8']
  ];
  var CAN_BOXES = [
    [0, 0.32, 0, 0.58, 0.62, 0.58, '#e0443f'], [0, 0.32, 0, 0.62, 0.3, 0.62, '#f2f7fb'],
    [0, 0.64, 0, 0.5, 0.1, 0.5, '#b9c4cf'], [0, 0.14, 0, 0.56, 0.12, 0.56, '#6f3a30']
  ];
  var CRATE_BOXES = [
    [0, 0.5, 0, 1.35, 1.0, 1.35, '#c98d3f'], [0, 1.04, 0, 1.42, 0.14, 1.42, '#a8763a'],
    [0, 0.02, 0, 1.42, 0.12, 1.42, '#a8763a'], [0, 0.5, 0.69, 1.35, 0.16, 0.12, '#a8763a'],
    [0, 0.5, -0.69, 1.35, 0.16, 0.12, '#a8763a'], [0.69, 0.5, 0, 0.12, 0.16, 1.35, '#a8763a'],
    [-0.69, 0.5, 0, 0.12, 0.16, 1.35, '#a8763a'], [0.34, 1.02, 0.34, 0.3, 0.1, 0.3, '#f2d9a8']
  ];
  var BARREL_BOXES = [
    [0, 0.62, 0, 1.05, 1.2, 1.05, '#b07a44'], [0, 0.26, 0, 1.14, 0.14, 1.14, '#6b4a2c'],
    [0, 0.7, 0, 1.14, 0.14, 1.14, '#6b4a2c'], [0, 1.12, 0, 1.14, 0.14, 1.14, '#6b4a2c'],
    [0, 1.28, 0, 0.8, 0.12, 0.8, '#c99a5e'], [0, 0.62, 0.55, 0.46, 0.46, 0.08, '#8f6135']
  ];
  var DUCK_BOXES = [
    [0, 0.38, 0, 1.0, 0.56, 1.25, '#ffd21f'], [0, 0.66, -0.58, 0.5, 0.36, 0.42, '#ffd21f'],
    [0, 0.9, 0.4, 0.62, 0.62, 0.62, '#ffd21f'], [0, 0.85, 0.86, 0.34, 0.24, 0.28, '#ff7a2c'],
    [-0.24, 1.08, 0.66, 0.11, 0.11, 0.08, '#262626'], [0.24, 1.08, 0.66, 0.11, 0.11, 0.08, '#262626'],
    [0, 0.56, 0.36, 0.46, 0.18, 0.46, '#ffe98a']
  ];
  var TIRE_BOXES = (function () {
    var B = boxList(), i, a, x, z, r = 0.56;
    for (i = 0; i < 8; i++) {
      a = i * Math.PI / 4; x = Math.cos(a) * r; z = Math.sin(a) * r;
      B.add(x, 0.3, z, i % 2 ? 0.42 : 0.5, 0.34, i % 2 ? 0.5 : 0.42, '#26292e');
      B.add(x, 0.48, z, i % 2 ? 0.32 : 0.4, 0.1, i % 2 ? 0.4 : 0.32, '#3f454d');
    }
    B.add(0, 0.3, 0, 0.5, 0.2, 0.5, '#8f6135'); // the hub
    return B;
  })();
  var NET_BOXES = (function () {
    var B = boxList(), i;
    for (i = -2; i <= 2; i++) B.add(i * 0.38, 0.2, 0, 0.07, 0.1, 1.5, '#2f9e78');
    for (i = -2; i <= 2; i++) B.add(0, 0.2, i * 0.32, 1.75, 0.1, 0.07, '#2f9e78');
    [[-0.88, 0.7], [0.88, 0.7], [-0.88, -0.7], [0.88, -0.7]].forEach(function (p) {
      B.add(p[0], 0.3, p[1], 0.3, 0.32, 0.3, '#ff9f45');
    });
    B.add(0, 0.34, 0.74, 1.5, 0.14, 0.1, '#7fd8b4');
    B.add(0, 0.34, -0.74, 1.5, 0.14, 0.1, '#7fd8b4');
    return B;
  })();

  /** Every collectable: model, point value, resource it yields, and glow colour.
   *  wood / plastic / metal are the three lines the town is built from. */
  var PICKUP_KINDS = [
    { model: BOTTLE_BOXES, value: 1, glow: '#8ee3b8', name: '塑料瓶', res: { plastic: 1 } },
    { model: CAN_BOXES, value: 1, glow: '#ff9a96', name: '易拉罐', res: { metal: 1 } },
    { model: DUCK_BOXES, value: 1, glow: '#ffe066', name: '橡皮鸭', res: { plastic: 1 } },
    { model: CRATE_BOXES, value: 2, glow: '#ffd166', name: '木箱', res: { wood: 2 } },
    { model: BARREL_BOXES, value: 2, glow: '#e0b072', name: '木桶', res: { wood: 1, metal: 1 } },
    { model: TIRE_BOXES, value: 2, glow: '#aab4c0', name: '轮胎', res: { plastic: 1, metal: 1 } },
    { model: NET_BOXES, value: 3, glow: '#7fd8b4', name: '渔网', res: { wood: 1, plastic: 2 } }
  ];

  /* Fresh water: the survival pressure. Every piece of garbage you pick up
   * costs thirst, because hauling it back is work. Drink at the raft's barrel,
   * or fish rainwater out of the sea. Run dry and you start losing hearts. */
  var WATER_BOXES = [
    [0, 0.3, 0, 0.62, 0.56, 0.62, '#4fa8e8'], [0, 0.62, 0, 0.44, 0.14, 0.44, '#8fd0f5'],
    [0, 0.7, 0, 0.2, 0.14, 0.2, '#d8eefc'], [0, 0.3, 0, 0.66, 0.2, 0.66, '#eaf7ff']
  ];

  /* Food bobbing in the water: a bait pail of small fish. Eating it is the fastest
   *  way to top the belly bar back up without waiting on the fish basket. */
  var FOOD_BOXES = [
    [0, 0.3, 0, 0.72, 0.56, 0.72, '#8fb6c9'], [0, 0.6, 0, 0.78, 0.12, 0.78, '#6b8fa3'],
    [0, 0.72, 0, 0.3, 0.12, 0.3, '#d8eefc'], [0.06, 0.74, 0.02, 0.5, 0.1, 0.34, '#9fd8e8'],
    [-0.2, 0.78, -0.16, 0.26, 0.1, 0.3, '#7fc4d8'], [0.24, 0.8, -0.12, 0.22, 0.1, 0.26, '#9fd8e8']
  ];

  var RING_BOXES = [
    [-0.58, 0.3, 0, 0.52, 0.52, 0.42, '#ffffff'], [0.58, 0.3, 0, 0.52, 0.52, 0.42, '#ffffff'],
    [0, 0.3, -0.58, 0.42, 0.52, 0.52, '#ffffff'], [0, 0.3, 0.58, 0.42, 0.52, 0.52, '#ffffff'],
    [-0.58, 0.3, 0, 0.54, 0.5, 0.18, '#ff5f5f'], [0.58, 0.3, 0, 0.54, 0.5, 0.18, '#ff5f5f'],
    [0, 0.3, -0.58, 0.18, 0.5, 0.54, '#ff5f5f'], [0, 0.3, 0.58, 0.18, 0.5, 0.54, '#ff5f5f']
  ];
  var CHEST_BOXES = [
    [0, 0.35, 0, 1.2, 0.7, 0.92, '#9a6a34'], [0, 0.76, 0, 1.26, 0.18, 0.98, '#7c5226'],
    [0, 0.5, 0.47, 0.26, 0.3, 0.06, '#ffd166', true], [0, 0.5, 0, 0.17, 0.7, 0.96, '#7c5226'],
    [0, 1.0, 0, 0.5, 0.16, 0.5, '#ffd166', true], [-0.4, 0.95, 0, 0.1, 0.28, 0.3, '#c9a24a'],
    [0.4, 0.95, 0, 0.1, 0.28, 0.3, '#c9a24a']
  ];
  var SPECIAL_MODELS = { ring: RING_BOXES, chest: CHEST_BOXES };

  /* --- Six buildings that grow on the raft, one every few pieces of garbage. --- */
  var CABIN_BOXES = [
    [0, 0.62, 0, 1.6, 1.24, 1.3, '#e0b183'], [0, 1.34, 0, 1.72, 0.16, 1.42, '#b8875a'],
    [0, 1.62, 0, 1.5, 0.42, 1.22, '#d0705c'], [0, 1.94, 0, 0.9, 0.3, 0.78, '#c2624f'],
    [0, 2.16, 0, 0.42, 0.16, 0.4, '#a94f3f'],
    [0, 0.5, 0.68, 0.42, 0.9, 0.1, '#7a4a28'], [0, 0.86, 0.68, 0.46, 0.08, 0.12, '#5c3620'],
    [-0.5, 0.78, 0.68, 0.34, 0.34, 0.07, '#bfeef2'], [0.5, 0.78, 0.68, 0.34, 0.34, 0.07, '#bfeef2'],
    [0.62, 1.9, -0.4, 0.22, 0.9, 0.22, '#b8875a'], [0.62, 2.4, -0.4, 0.3, 0.14, 0.3, '#6b5136'],
    [-0.78, 0.62, 0, 0.1, 1.2, 0.1, '#b8875a'], [0.78, 0.62, 0, 0.1, 1.2, 0.1, '#b8875a']
  ];
  var TOWER_BOXES = (function () {
    var B = boxList(), i;
    [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].forEach(function (p) {
      B.add(p[0], 0.55, p[1], 0.16, 1.1, 0.16, '#7a5a3a');
    });
    for (i = 0; i < 4; i++) B.add(0, 0.3 + i * 0.26, 0.5, 0.4, 0.08, 0.08, '#9a7a52');
    B.add(0, 1.55, 0, 1.3, 0.9, 1.3, '#8fb6c9');               // tank
    B.add(0, 1.1, 0, 1.36, 0.14, 1.36, '#6b8fa3');
    B.add(0, 2.0, 0, 1.36, 0.14, 1.36, '#6b8fa3');
    B.add(0, 2.2, 0, 1.5, 0.24, 1.5, '#5d7f94');               // roof
    B.add(0, 2.42, 0, 0.9, 0.22, 0.9, '#4f6f84');
    B.add(0, 2.6, 0, 0.4, 0.16, 0.4, '#3f5c70');
    B.add(0.66, 1.4, 0.16, 0.16, 0.9, 0.16, '#6b8fa3');        // down pipe
    return B;
  })();
  var GREENHOUSE_BOXES = (function () {
    var B = boxList(), i, j;
    B.add(0, 0.18, 0, 1.5, 0.26, 1.3, '#8f6135');               // soil bed
    B.add(0, 0.34, 0, 1.4, 0.12, 1.2, '#5e4126');
    for (i = -1; i <= 1; i += 2) for (j = -1; j <= 1; j += 2) {
      B.add(i * 0.68, 0.85, j * 0.58, 0.1, 1.14, 0.1, '#d8e8ea'); // frame posts
    }
    B.add(0, 1.36, 0, 1.5, 0.1, 1.24, '#d8e8ea');               // eave
    B.add(0, 0.85, 0.6, 1.4, 0.9, 0.06, '#cdeef5');             // glass walls
    B.add(0, 0.85, -0.6, 1.4, 0.9, 0.06, '#cdeef5');
    B.add(0.72, 0.85, 0, 0.06, 0.9, 1.2, '#cdeef5');
    B.add(-0.72, 0.85, 0, 0.06, 0.9, 1.2, '#cdeef5');
    B.add(0, 1.56, 0, 1.3, 0.14, 1.1, '#bfe9f2');               // shallow glass roof
    B.add(0, 1.7, 0, 0.8, 0.14, 0.7, '#a8dce8');
    for (i = 0; i < 3; i++) {
      B.add(-0.4 + i * 0.4, 0.6, 0.15, 0.16, 0.34, 0.16, '#4c9a5c'); // plants
      B.add(-0.4 + i * 0.4, 0.82, 0.15, 0.3, 0.16, 0.3, '#6dbd6a');
    }
    return B;
  })();
  var LIGHTHOUSE_BOXES = (function () {
    var B = boxList(), i;
    B.add(0, 0.14, 0, 0.9, 0.28, 0.9, '#9aa4b0');               // base
    var bands = ['#f6f2e8', '#e2574c', '#f6f2e8', '#e2574c'];
    for (i = 0; i < 4; i++) {
      var w = 0.72 - i * 0.09;
      B.add(0, 0.34 + i * 0.4, 0, w, 0.4, w, bands[i]);
    }
    B.add(0, 1.94, 0, 0.66, 0.14, 0.66, '#3a4a56');             // balcony
    B.add(0, 2.16, 0, 0.5, 0.3, 0.5, '#cdeef5');                // lamp room
    B.add(0, 2.16, 0, 0.28, 0.28, 0.28, '#ffd98a', true);       // the lamp
    B.add(0, 2.38, 0, 0.62, 0.16, 0.62, '#3a4a56');             // roof
    B.add(0, 2.52, 0, 0.34, 0.14, 0.34, '#2d3a44');
    B.add(0, 2.64, 0, 0.12, 0.16, 0.12, '#c9a24a');
    return B;
  })();
  var STALL_BOXES = (function () {
    var B = boxList(), i;
    B.add(0, 0.52, 0, 1.4, 0.16, 0.9, '#c9a069');               // counter
    B.add(-0.62, 0.24, 0.36, 0.1, 0.5, 0.1, '#8f6135');
    B.add(0.62, 0.24, 0.36, 0.1, 0.5, 0.1, '#8f6135');
    B.add(-0.62, 1.0, -0.36, 0.1, 1.5, 0.1, '#8f6135');          // posts
    B.add(0.62, 1.0, -0.36, 0.1, 1.5, 0.1, '#8f6135');
    for (i = 0; i < 5; i++) {                                    // striped awning
      B.add(-0.56 + i * 0.28, 1.42, 0.05, 0.28, 0.1, 1.0, i % 2 ? '#f6f2e8' : '#e2574c');
    }
    B.add(0, 1.52, -0.36, 1.4, 0.1, 0.1, '#8f6135');
    // fruit on the counter
    B.add(-0.4, 0.68, 0, 0.24, 0.2, 0.24, '#ff9f45');
    B.add(-0.1, 0.68, 0.05, 0.24, 0.2, 0.24, '#8ec44f');
    B.add(0.22, 0.68, -0.02, 0.24, 0.2, 0.24, '#e2574c');
    B.add(0.44, 0.66, 0.22, 0.3, 0.28, 0.3, '#c98d3f');          // crate
    B.add(-0.55, 1.06, 0.1, 0.2, 0.32, 0.2, '#ffd98a', true);    // hanging lantern
    return B;
  })();
  var WINDMILL_BOXES = (function () {
    var B = boxList(), i;
    B.add(0, 0.12, 0, 0.9, 0.24, 0.9, '#8f6135');
    for (i = 0; i < 4; i++) B.add(0, 0.4 + i * 0.34, 0, 0.72 - i * 0.1, 0.34, 0.72 - i * 0.1, i % 2 ? '#e0c9a0' : '#d8bd90');
    B.add(0, 1.72, 0, 0.56, 0.16, 0.56, '#8f6135');
    B.add(0, 1.9, 0, 0.42, 0.3, 0.42, '#a97a4a');
    B.add(0, 2.1, 0, 0.3, 0.18, 0.3, '#7a5230');
    B.add(0.3, 0.55, 0.3, 0.16, 0.5, 0.16, '#7a5230');            // little door
    return B;
  })();
  /** The windmill's sails, a separate mesh so they can spin. */
  var BLADE_BOXES = (function () {
    var B = boxList();
    B.add(0, 0, 0, 0.2, 0.2, 0.2, '#5c4028');
    for (var i = 0; i < 4; i++) {
      var a = i * Math.PI / 2;
      var dx = Math.cos(a), dy = Math.sin(a);
      B.add(dx * 0.45, dy * 0.45, 0, 0.16, 0.16, 0.16, '#7a5230');
      for (var j = 0; j < 3; j++) {
        var d = 0.7 + j * 0.38;
        B.add(dx * d, dy * d, 0.02, dx ? 0.4 : 0.14, dy ? 0.4 : 0.14, 0.06, j % 2 ? '#f6f2e8' : '#e8dcc0');
      }
    }
    return B;
  })();

  var BUILDING_BOXES = [
    CABIN_BOXES, TOWER_BOXES, GREENHOUSE_BOXES, LIGHTHOUSE_BOXES, STALL_BOXES, WINDMILL_BOXES
  ];
  var BUILDING_NAMES = ['小屋', '水塔', '温室', '灯塔', '市集', '风车'];
  /** Each building costs materials, houses residents and bends the run.
   *  Perks: maxHearts, speed, water (bigger canteen), shields (longer safety),
   *  magnet (wider pickup reach), trade (garbage is worth more). */
  var BUILDING_SPECS = [
    { name: '小屋', cost: { wood: 4, plastic: 0, metal: 0 }, pop: 1, perk: 'maxHearts', desc: '+1 心' },
    { name: '水塔', cost: { wood: 3, plastic: 3, metal: 0 }, pop: 1, perk: 'water', desc: '水壶 +25' },
    { name: '温室', cost: { wood: 2, plastic: 4, metal: 0 }, pop: 1, perk: 'magnet', desc: '吸附范围+' },
    { name: '灯塔', cost: { wood: 3, plastic: 2, metal: 3 }, pop: 0, perk: 'shields', desc: '护盾更久' },
    { name: '市集', cost: { wood: 4, plastic: 3, metal: 3 }, pop: 2, perk: 'trade', desc: '收益 +1' },
    { name: '风车', cost: { wood: 5, plastic: 3, metal: 4 }, pop: 1, perk: 'speed', desc: '船速 +' }
  ];
  /** Positions are in the raft body's own space, before it is scaled down as a whole.
   *  Spread across the deck so a finished town reads as a skyline, leaving the
   *  mast (z ≈ -2.95) and the crew (z ≈ 2.2) clear. */
  var BUILDING_POS = [
    [-1.75, 0.8, -2.35], [1.85, 0.8, -2.3], [-2.1, 0.8, -0.75],
    [2.15, 0.8, -0.7], [-1.65, 0.8, 0.95], [1.75, 0.8, 1.0]
  ];
  /* --- Survival gear (design doc stage 0–1). Small models that sit on the deck:
   *  the workbench you build everything at, the shelter that makes the raft a
   *  home, and the four pieces that turn thirst and hunger into background. --- */
  var WORKBENCH_BOXES = (function () {
    var B = boxList(), i;
    B.add(0, 0.62, 0, 1.24, 0.14, 0.72, '#c9a069');              // bench top
    [[-0.5, -0.3], [0.5, -0.3], [-0.5, 0.3], [0.5, 0.3]].forEach(function (p) {
      B.add(p[0], 0.3, p[1], 0.1, 0.6, 0.1, '#8f6135');          // legs
    });
    B.add(0, 0.42, -0.24, 1.1, 0.1, 0.1, '#8f6135');             // stretcher
    for (i = 0; i < 3; i++) B.add(-0.34 + i * 0.34, 0.77, 0.08, 0.24, 0.14, 0.24, i % 2 ? '#aab4c0' : '#8fa3b8'); // tools
    B.add(0.34, 0.92, -0.17, 0.07, 0.44, 0.07, '#7a5230');       // hammer
    B.add(0.34, 1.16, -0.17, 0.3, 0.14, 0.14, '#8fa3b8');
    B.add(-0.52, 1.2, -0.28, 0.08, 1.0, 0.08, '#6b4a2c');        // a post with a slate to plan on
    B.add(-0.52, 1.52, -0.28, 0.08, 0.5, 0.62, '#e8dcc0');
    return B;
  })();
  var SHELTER_BOXES = (function () {
    var B = boxList(), i;
    B.add(0, 0.72, 0, 1.9, 1.1, 1.6, '#d8a06a');                 // cabin wall
    B.add(0, 1.34, 0, 2.05, 0.16, 1.72, '#b8875a');              // eave
    for (i = 0; i < 3; i++) {                                    // pitched thatch roof
      var w = 1.9 - i * 0.42;
      B.add(0, 1.5 + i * 0.22, 0, w, 0.24, 1.5 - i * 0.3, i % 2 ? '#c9853f' : '#b8773a');
    }
    B.add(0, 0.62, 0.82, 0.5, 0.86, 0.1, '#7a4a28');             // door
    B.add(0, 0.72, 0.86, 0.16, 0.16, 0.08, '#ffd98a', true);     // door light
    B.add(-0.62, 0.9, 0.82, 0.36, 0.34, 0.07, '#bfeef2');        // window
    B.add(0.62, 0.9, 0.82, 0.36, 0.34, 0.07, '#bfeef2');
    B.add(0, 0.98, -0.82, 0.9, 0.5, 0.08, '#8f6135');            // a bedroll strapped on
    B.add(0, 1.18, -0.86, 0.94, 0.18, 0.1, '#e8dcc0');
    return B;
  })();
  var RAINCATCHER_BOXES = (function () {
    var B = boxList(), i;
    [[-0.44, -0.44], [0.44, -0.44], [-0.44, 0.44], [0.44, 0.44]].forEach(function (p) {
      B.add(p[0], 0.52, p[1], 0.08, 1.04, 0.08, '#8fa3b8');      // frame
    });
    B.add(0, 1.06, 0, 1.16, 0.08, 1.16, '#5fb6d8');              // funnel mouth
    B.add(0, 1.12, 0, 0.72, 0.08, 0.72, '#8fd0f5');
    B.add(0, 0.5, 0, 0.76, 0.6, 0.76, '#4f97c4');                // tank
    B.add(0, 0.82, 0, 0.8, 0.08, 0.8, '#6fb8dc');
    B.add(0.42, 0.34, 0, 0.14, 0.36, 0.14, '#6fb8dc');           // tap
    B.add(0.56, 0.24, 0, 0.24, 0.08, 0.08, '#8fd0f5');
    for (i = 0; i < 3; i++) B.add(0, 0.16 + i * 0.14, 0, 0.86, 0.06, 0.86, '#3f7fa3');
    return B;
  })();
  var FISHBASKET_BOXES = (function () {
    var B = boxList(), i, j;
    for (i = 0; i < 4; i++) {                                    // woven basket
      B.add(0, 0.16 + i * 0.18, 0, 0.94 - i * 0.06, 0.18, 0.94 - i * 0.06, i % 2 ? '#c9a069' : '#b08a52');
    }
    for (i = -1; i <= 1; i++) for (j = -1; j <= 1; j++) {
      if (!i && !j) continue;
      B.add(i * 0.3, 0.44, j * 0.3, 0.1, 0.86, 0.1, '#a8763a'); // hoop ribs
    }
    B.add(0, 0.3, 0, 0.34, 0.14, 0.72, '#9fd8e8');              // a fish in the basket
    B.add(0, 0.34, 0.34, 0.22, 0.12, 0.2, '#7fc4d8');
    B.add(0, 0.66, 0, 0.5, 0.06, 0.5, '#7fd8b4');               // netting lid
    return B;
  })();
  var SCOOPNET_BOXES = (function () {
    var B = boxList(), i;
    B.add(-0.56, 0.9, 0, 0.09, 1.8, 0.09, '#8f6135');           // handle
    B.add(0.14, 1.68, 0, 1.2, 0.09, 0.09, '#a88a60');           // hoop arm
    for (i = 0; i < 5; i++) {                                    // net ring
      var a = i * Math.PI * 2 / 5;
      B.add(0.14 + Math.cos(a) * 0.52, 1.68, Math.sin(a) * 0.52, 0.08, 0.08, 0.08, '#c9c0a8');
    }
    for (i = -2; i <= 2; i++) B.add(0.14 + i * 0.2, 1.54, 0, 0.05, 0.05, 0.9, '#7fd8b4');
    for (i = -2; i <= 2; i++) B.add(0.14, 1.54, i * 0.18, 1.0, 0.05, 0.05, '#7fd8b4');
    B.add(-0.56, 1.72, 0, 0.14, 0.14, 0.14, '#ff9f45');         // grip
    return B;
  })();
  var PURIFIER_BOXES = (function () {
    var B = boxList(), i;
    B.add(0, 0.2, 0, 1.1, 0.18, 1.1, '#6b6f78');                // base plate
    B.add(0, 0.72, 0, 0.82, 0.9, 0.82, '#aab4c0');              // boiler
    B.add(0, 1.2, 0, 0.86, 0.12, 0.86, '#8f97a2');
    for (i = 0; i < 3; i++) B.add(0, 0.44 + i * 0.24, 0.42, 0.5, 0.1, 0.06, '#c8d0d8'); // ribs
    B.add(0, 1.5, 0, 0.28, 0.5, 0.28, '#8fa3b8');               // chimney / condenser
    B.add(0, 1.78, 0, 0.44, 0.1, 0.44, '#7b8794');
    B.add(0.52, 0.72, 0, 0.12, 0.9, 0.12, '#9aa4b0');           // output pipe
    B.add(0.62, 0.34, 0, 0.32, 0.1, 0.1, '#6fb8dc');
    B.add(0, 0.82, 0.44, 0.28, 0.2, 0.06, '#ffd98a', true);     // level window
    B.add(-0.56, 0.94, 0, 0.1, 0.1, 0.6, '#c8d0d8');            // a little solar still panel
    return B;
  })();

  /** The survival build order. Each step lists what it needs built first, so the
   *  unlock chain of the design doc lives in one readable table:
   *  workbench → shelter → { rain catcher, fish basket, scoop net → purifier }. */
  var SURVIVAL_STEPS = [
    { id: 'workbench', name: '工作台', boxes: WORKBENCH_BOXES, at: [0, 0.72, 2.05], scale: 1.0, needs: [],
      short: '建造', desc: '解锁建造 · 木材加工', tip: '造出工作台，才能动手搭别的东西' },
    { id: 'shelter', name: '庇护所', boxes: SHELTER_BOXES, at: [-1.5, 0.72, 1.1], scale: 1.05, needs: ['workbench'],
      short: '床位+2', desc: '床位+2 · 存档点 · 生存装备图纸', tip: '有了遮风挡雨的家，才顾得上喝水吃饭' },
    { id: 'rainCatcher', name: '集雨器', boxes: RAINCATCHER_BOXES, at: [1.85, 0.72, 0.55], scale: 0.95, needs: ['shelter'],
      short: '自动蓄水', desc: '每 ' + R.survival.rainEvery + ' 秒 +' + R.survival.rainAmount + ' 水', tip: '' },
    { id: 'fishBasket', name: '鱼篓', boxes: FISHBASKET_BOXES, at: [1.15, 0.72, -0.5], scale: 0.95, needs: ['shelter'],
      short: '自动加餐', desc: '每 ' + R.survival.fishEvery + ' 秒 +' + R.survival.fishAmount + ' 食', tip: '' },
    { id: 'scoopNet', name: '捞网', boxes: SCOOPNET_BOXES, at: [-1.9, 0.72, -1.4], scale: 0.95, needs: ['shelter'],
      short: '打捞范围+50%', desc: '打捞范围 +50%', tip: '' },
    { id: 'purifier', name: '净水器', boxes: PURIFIER_BOXES, at: [0.2, 0.72, 1.75], scale: 0.95,
      needs: ['rainCatcher', 'workbench'],
      short: '稳定供水', desc: '每 ' + R.survival.purifyEvery + ' 秒 +' + R.survival.purifyAmount + ' 水', tip: '' }
  ];

  var MODEL_HEIGHT = { hero: 4.7, enemy: 1.1, pickup: 1.9 };
  /** The raft body is scaled to R.heroSize / MODEL_HEIGHT.hero; buildings counter-scale to stay legible. */
  var BUILDING_SCALE = 1.45;
  /** Every character's look in one place: the game and the studio's thumbnails both draw from here. */
  var MODELS = { hero: HERO_BOXES, enemy: SHARK_BOXES, pickup: BOTTLE_BOXES };
  var spriteTextures = {};
  function spriteTexture(slot) {
    if (!spriteTextures[slot]) {
      var texture = new THREE.TextureLoader().load(ASSETS[slot]);
      texture.colorSpace = THREE.SRGBColorSpace;
      spriteTextures[slot] = texture;
    }
    return spriteTextures[slot];
  }

  /** One character: a body (voxel model or sprite) on a holder that stands on the ground, with a blob shadow. */
  function makeCharacter(slot, size, boxes) {
    var holder = new THREE.Group();
    var body;
    if (customArt(slot)) {
      body = new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteTexture(slot), alphaTest: 0.08 }));
      body.center.set(0.5, 0.02);
      body.scale.set(size * 1.25, size * 1.25, 1);
      body.userData.sprite = true;
    } else {
      body = voxelModel(boxes);
      body.scale.setScalar(size / MODEL_HEIGHT[slot]);
    }
    holder.add(body);
    var shadow = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.9, size * 0.9), new THREE.MeshBasicMaterial({ map: BLOB, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.03;
    holder.add(shadow);
    holder.userData.body = body;
    scene.add(holder);
    return holder;
  }

  var hero = { x: 0, z: 0, y: floatY(0, 0), vx: 0, vz: 0, facing: 0, dashT: 0, dashCd: 0, dashX: 0, dashZ: 0, node: makeCharacter('hero', R.heroSize, MODELS.hero) };
  var heroMode = customArt('hero') ? 'sprite' : 'voxel';
  var BASE_HERO_SCALE = hero.node.userData.body.scale.x;
  var bubble = new THREE.Mesh(new THREE.SphereGeometry(R.heroSize * 0.78, 20, 14), new THREE.MeshBasicMaterial({ color: '#9fe8ff', transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }));
  bubble.position.y = R.heroSize * 0.5;
  bubble.visible = false;
  hero.node.add(bubble);

  // White foam for the wake and dash bursts, pooled separately from the gold sparks.
  var FOAM = 48, foam = [];
  var foamMesh = new THREE.InstancedMesh(BOX, new THREE.MeshBasicMaterial({ color: '#eafcff', transparent: true, opacity: 0.85 }), FOAM);
  foamMesh.frustumCulled = false;
  for (var fo = 0; fo < FOAM; fo++) foam.push({ life: 0, x: 0, y: WATER_Y + 0.1, z: 0, vx: 0, vy: 0, vz: 0, s: 1 });
  scene.add(foamMesh);
  function spawnFoam(x, z, n, spread) {
    var made = 0;
    for (var i = 0; i < FOAM && made < n; i++) {
      var p = foam[i];
      if (p.life > 0) continue;
      var a = Math.random() * Math.PI * 2;
      p.life = 0.4 + Math.random() * 0.3; p.x = x; p.y = WATER_Y + 0.1; p.z = z;
      p.vx = Math.cos(a) * spread * Math.random(); p.vz = Math.sin(a) * spread * Math.random(); p.vy = 0.4;
      p.s = 0.12 + Math.random() * 0.1;
      made++;
    }
  }

  var enemies = [], pickups = [];

  // Pickup burst particles, pooled.
  var SPARKS = 72, sparks = [];
  var sparkMesh = new THREE.InstancedMesh(BOX, new THREE.MeshBasicMaterial({ color: R.palette.accent }), SPARKS);
  sparkMesh.frustumCulled = false;
  for (var sp = 0; sp < SPARKS; sp++) { sparks.push({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }); }
  scene.add(sparkMesh);
  function burst(x, y, z) {
    var made = 0;
    for (var i = 0; i < SPARKS && made < 16; i++) {
      var p = sparks[i];
      if (p.life > 0) continue;
      var a = Math.random() * Math.PI * 2, up = 2 + Math.random() * 3;
      p.life = 0.6 + Math.random() * 0.4; p.x = x; p.y = y; p.z = z;
      p.vx = Math.cos(a) * (1 + Math.random() * 2); p.vz = Math.sin(a) * (1 + Math.random() * 2); p.vy = up;
      made++;
    }
  }

  /* 6. AUDIO — tiny synthesized blips, started on the first gesture. */
  var audio = null, muted = false, musicTimer = null, musicStep = 0;
  function blipAt(freq, duration, type, volume, slideTo, delay) {
    if (muted) return;
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      var now = audio.currentTime + (delay || 0), osc = audio.createOscillator(), gain = audio.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, now);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, now + duration);
      gain.gain.setValueAtTime(volume || 0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      osc.connect(gain).connect(audio.destination);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    } catch (e) { /* audio is optional */ }
  }
  function blip(freq, duration, type, volume, slideTo) { blipAt(freq, duration, type, volume, slideTo, 0); }
  function fanfare(notes, gap, type, volume) {
    for (var i = 0; i < notes.length; i++) blipAt(notes[i], 0.14, type || 'triangle', volume || 0.06, 0, i * gap);
  }
  // A tiny pentatonic loop, quiet enough to sit under the splashes.
  var MELODY = [523, 0, 659, 0, 784, 659, 0, 587, 523, 0, 659, 0, 880, 784, 659, 0];
  var BASS = [262, 220, 196, 175];
  function ensureMusic() {
    if (musicTimer) return;
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      musicTimer = setInterval(function () {
        if (muted || phase !== 'playing' || paused) return;
        var note = MELODY[musicStep % MELODY.length];
        if (note) blipAt(note, 0.22, 'triangle', 0.022, 0, 0);
        if (musicStep % 4 === 0) blipAt(BASS[Math.floor(musicStep / 4) % BASS.length], 0.4, 'sine', 0.03, 0, 0);
        musicStep++;
      }, 270);
    } catch (e) { /* audio is optional */ }
  }

  /* 7. HUD — a 2D canvas layered over the WebGL canvas as a fullscreen
   * texture. WeChat Mini Games have no DOM: this one path draws the pills,
   * cards and on-screen joystick for both web and WeChat. */
  var FONT = 'system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
  var hudCanvas = document.createElement('canvas');
  var hudCtx = hudCanvas.getContext('2d');
  var hudTexture = new THREE.CanvasTexture(hudCanvas);
  hudTexture.colorSpace = THREE.SRGBColorSpace;
  hudTexture.minFilter = THREE.LinearFilter;
  var hudScene = new THREE.Scene();
  var hudCam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  var hudQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: hudTexture, transparent: true, depthTest: false, depthWrite: false }));
  hudQuad.position.set(0.5, 0.5, 0);
  hudScene.add(hudQuad);
  var cardData = null;
  var boostRect = null;    // hit area of the on-screen dash button, refreshed every frame
  var buildBtnRect = null; // hit area of the 建 button, set while the workbench stands
  function showCard(title, body, hint) { cardData = { title: title, body: body, hint: hint }; }
  function clearCard() { cardData = null; }
  function hudFont() { return Math.max(14, Math.min(22, Math.min(window.innerWidth || 1, window.innerHeight || 1) * 0.024)); }
  function roundRect(x, y, w, h, r) {
    hudCtx.beginPath();
    hudCtx.moveTo(x + r, y);
    hudCtx.arcTo(x + w, y, x + w, y + h, r);
    hudCtx.arcTo(x + w, y + h, x, y + h, r);
    hudCtx.arcTo(x, y + h, x, y, r);
    hudCtx.arcTo(x, y, x + w, y, r);
    hudCtx.closePath();
  }
  function drawPill(x, y, parts, fontSize) {
    hudCtx.font = '700 ' + fontSize + 'px ' + FONT;
    var w = 20, i;
    for (i = 0; i < parts.length; i++) w += hudCtx.measureText(parts[i].text).width + (i ? 8 : 0);
    var h = fontSize * 1.3 + 10;
    hudCtx.fillStyle = 'rgba(14,18,40,0.42)';
    roundRect(x, y, w, h, h / 2); hudCtx.fill();
    hudCtx.strokeStyle = 'rgba(255,255,255,0.14)'; hudCtx.lineWidth = 1;
    roundRect(x, y, w, h, h / 2); hudCtx.stroke();
    var tx = x + 10;
    for (i = 0; i < parts.length; i++) {
      if (i) tx += 8;
      hudCtx.fillStyle = parts[i].color || '#fff';
      hudCtx.fillText(parts[i].text, tx, y + 10 + fontSize * 0.82);
      tx += hudCtx.measureText(parts[i].text).width;
    }
  }
  function wrapLines(text, maxW) {
    var lines = [], line = '', chars = String(text).split('');
    for (var i = 0; i < chars.length; i++) {
      var test = line + chars[i];
      if (hudCtx.measureText(test).width > maxW && line) { lines.push(line); line = chars[i]; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  function drawHUD() {
    var w = window.innerWidth || 1, h = window.innerHeight || 1;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    if (hudCanvas.width !== Math.round(w * dpr) || hudCanvas.height !== Math.round(h * dpr)) {
      hudCanvas.width = Math.round(w * dpr);
      hudCanvas.height = Math.round(h * dpr);
    }
    hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hudCtx.clearRect(0, 0, w, h);
    hudCtx.textAlign = 'left';
    hudCtx.textBaseline = 'alphabetic';
    var font = hudFont();
    var m = Math.max(8, Math.min(w, h) * 0.022);
    drawPill(m, m, [
      { text: '♥'.repeat(Math.max(0, hearts)) + '♡'.repeat(Math.max(0, R.hearts - hearts)), color: '#ff8a9a' },
      { text: '镇 ' + townCount() + '/' + townTarget(), color: '#ffe2a8' },
      { text: '民 ' + pop, color: '#c8f0ff' }
    ], font);
    // Material stockpile, and what the next building is still asking for.
    // Plain text, no emoji: Canvas 2D has no colour-emoji font on every platform.
    var resParts = [
      { text: '木 ' + res.wood, color: '#e8c090' },
      { text: '塑 ' + res.plastic, color: '#a8e8a0' },
      { text: '铁 ' + res.metal, color: '#c8d0d8' }
    ];
    drawPill(m, m + font * 1.3 + 14, resParts, font);
    /* Two survival bars — water (canteen) and belly (food). The belly bar only
     * appears once the fish basket stands, so stage 0 keeps its gentle feel.
     * Canvas 2D only: no DOM nodes, no colour emoji (both break on WeChat). */
    var barW = Math.min(150, w * 0.3), barH = font * 0.62;
    var barX = m, barY = m + font * 2.6 + 30;
    function survivalBar(label, value, max, y, lowColour, fullColour) {
      var frac = clamp(max > 0 ? value / max : 0, 0, 1);
      hudCtx.fillStyle = 'rgba(14,18,40,0.5)';
      roundRect(barX, y, barW, barH, barH / 2); hudCtx.fill();
      hudCtx.fillStyle = frac < 0.25 ? '#ff6b6b' : (frac < 0.5 ? lowColour : fullColour);
      roundRect(barX + 2, y + 2, Math.max(0, (barW - 4) * frac), barH - 4, (barH - 4) / 2); hudCtx.fill();
      hudCtx.strokeStyle = 'rgba(255,255,255,0.22)'; hudCtx.lineWidth = 1;
      roundRect(barX, y, barW, barH, barH / 2); hudCtx.stroke();
      hudCtx.fillStyle = frac < 0.25 ? '#ffb4b4' : '#dff6ff';
      hudCtx.font = '700 ' + (font * 0.72) + 'px ' + FONT;
      hudCtx.fillText(label + ' ' + Math.round(value) + '/' + max, barX + barW + 8, y + barH - 2);
    }
    survivalBar('水', canteen, maxWater, barY, '#ffc463', '#5fd0f0');
    if (hasBuilt('fishBasket')) survivalBar('食', food, maxFood, barY + barH + 6, '#ffc463', '#8fd86a');
    // The next survival step in the chain, its price, and whether it is affordable.
    var hintY = barY + barH + (hasBuilt('fishBasket') ? barH + 14 : 8);
    var step = nextSurvivalStep();
    if (step) {
      drawPill(m, hintY, [{
        text: survivalHintText() + (hasBuilt('workbench') ? '  （B 打开建造）' : ''),
        color: canAffordCost(stepCost(step)) ? '#9ff0b8' : '#ffb4a0'
      }], font * 0.78);
    } else if (!buildOffer) {
      drawPill(m, hintY, [{ text: '生存装备齐备 · 打捞攒材料建镇', color: '#9ff0b8' }], font * 0.78);
    }
    /* Self-sustaining: the acceptance gate of stage 1, so it stays on screen as a
     * standing line under the survival hint (not a 3-second toast that a
     * screenshot can miss), plus a bright banner on the moment it first triggers. */
    if (townReady) {
      var srText = '口渴与饥饿可自持 —— 可以建立城镇了';
      hudCtx.font = '700 ' + (font * 0.78) + 'px ' + FONT;
      var srW = hudCtx.measureText(srText).width;
      hudCtx.fillStyle = 'rgba(24,80,60,0.55)';
      roundRect(m, hintY + font * 1.45, srW + 20, font * 1.45, 8); hudCtx.fill();
      hudCtx.strokeStyle = 'rgba(160,255,190,0.55)'; hudCtx.lineWidth = 1;
      roundRect(m, hintY + font * 1.45, srW + 20, font * 1.45, 8); hudCtx.stroke();
      hudCtx.fillStyle = '#c8ffd8';
      hudCtx.fillText(srText, m + 10, hintY + font * 2.45);
    }
    if (townReady && townReadyBanner > 0) { // the moment it first unlocks
      hudCtx.globalAlpha = Math.min(1, townReadyBanner);
      var trText = '可以建立城镇了！';
      hudCtx.font = '800 ' + (font * 1.15) + 'px ' + FONT;
      hudCtx.textAlign = 'center';
      var trW = hudCtx.measureText(trText).width + 34;
      hudCtx.fillStyle = 'rgba(24,80,60,0.72)';
      roundRect((w - trW) / 2, h * 0.14, trW, font * 2.2, 12); hudCtx.fill();
      hudCtx.fillStyle = '#c8ffd8';
      hudCtx.fillText(trText, w / 2, h * 0.14 + font * 1.5);
      hudCtx.textAlign = 'left';
      hudCtx.globalAlpha = 1;
    }
    if (nextBuild < BUILDING_SPECS.length && !buildOffer && townReady) {
      var spec = BUILDING_SPECS[nextBuild], ok = canAfford(spec);
      drawPill(m, hintY + font * 1.5, [{
        text: '造' + spec.name + ' ' + costText(spec),
        color: ok ? '#9ff0b8' : '#ffb4a0'
      }], font * 0.78);
    }
    // TEMP diagnostics removed.
    hudCtx.font = '700 ' + font + 'px ' + FONT;
    var seconds = Math.ceil(timeLeft);
    var timerText = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    var cap = window.GAME && window.GAME.safeArea; // keep clear of WeChat's capsule button
    var ty = cap && typeof cap.bottom === 'number' && cap.bottom > 0 ? cap.bottom + 10 : m;
    drawPill(w - m - hudCtx.measureText(timerText).width - 20, ty, [{ text: timerText, color: '#fff' }], font);
    if (shield > 0) drawPill(m, hintY + font * 1.6 + 22, [{ text: '救生圈 ' + Math.ceil(shield) + 's', color: '#bff0ff' }], font * 0.8);
    if (combo >= 2 && comboShowT > 0) drawPill(m, hintY + font * 2.8 + 32, [{ text: '连击 x' + combo, color: '#ffc463' }], font * 0.85);
    if (surgeShowT > 0) { // shark surge warning, right under the timer
      hudCtx.globalAlpha = Math.min(1, surgeShowT * 1.5);
      var swText = '鲨鱼潮！';
      hudCtx.font = '800 ' + (font * 1.05) + 'px ' + FONT;
      var swW = hudCtx.measureText(swText).width + 28;
      hudCtx.fillStyle = 'rgba(200,40,40,0.55)';
      roundRect(w - m - swW, ty + font * 1.9, swW, font * 1.7, 10); hudCtx.fill();
      hudCtx.fillStyle = '#fff';
      hudCtx.textAlign = 'center';
      hudCtx.fillText(swText, w - m - swW / 2, ty + font * 2.9);
      hudCtx.textAlign = 'left';
      hudCtx.globalAlpha = 1;
    }
    // The blueprint choice: two cards, pick with ← / → or a tap.
    if (buildOffer) {
      buildOfferT += 1 / 60;
      var cardW = Math.min(w * 0.36, 210), cardH = cardW * 0.62;
      var gap = 18, totalW = cardW * buildOffer.length + gap * (buildOffer.length - 1);
      var startX = (w - totalW) / 2, cy2 = h * 0.66;
      hudCtx.fillStyle = 'rgba(8,14,26,0.35)';
      hudCtx.fillRect(0, 0, w, h);
      hudCtx.textAlign = 'center';
      hudCtx.font = '800 ' + (font * 1.1) + 'px ' + FONT;
      hudCtx.fillStyle = '#ffe2a8';
      hudCtx.fillText('选一张图纸（← → 或点击）', w / 2, cy2 - font * 1.2);
      buildCardRects = [];
      for (var bo = 0; bo < buildOffer.length; bo++) {
        var si = buildOffer[bo], sp3 = BUILDING_SPECS[si];
        var cxp = startX + bo * (cardW + gap), cyp = cy2;
        var afford = canAfford(sp3);
        var isSel = bo === buildSel;
        buildCardRects.push({ x: cxp, y: cyp, w: cardW, h: cardH, index: bo });
        hudCtx.fillStyle = afford ? 'rgba(24,46,66,0.94)' : 'rgba(40,26,26,0.9)';
        roundRect(cxp, cyp, cardW, cardH, 14); hudCtx.fill();
        hudCtx.strokeStyle = isSel && afford ? '#ffd166' : 'rgba(255,255,255,0.2)';
        hudCtx.lineWidth = isSel ? 3 : 1;
        roundRect(cxp, cyp, cardW, cardH, 14); hudCtx.stroke();
        hudCtx.fillStyle = afford ? '#fff' : 'rgba(255,255,255,0.45)';
        hudCtx.font = '800 ' + (font * 1.15) + 'px ' + FONT;
        hudCtx.fillText(sp3.name, cxp + cardW / 2, cyp + font * 1.75);
        hudCtx.font = '700 ' + (font * 0.82) + 'px ' + FONT;
        hudCtx.fillStyle = afford ? '#9ff0b8' : '#ffb4a0';
        hudCtx.fillText(costText(sp3), cxp + cardW / 2, cyp + font * 2.95);
        hudCtx.fillStyle = '#c8e8ff';
        hudCtx.font = '700 ' + (font * 0.8) + 'px ' + FONT;
        hudCtx.fillText('民+' + sp3.pop + '  ' + sp3.desc, cxp + cardW / 2, cyp + cardH - font * 0.75);
      }
      hudCtx.textAlign = 'left';
    } else buildCardRects = null;
    // Dash button (touch) — dimmed and swept dark while recharging.
    var br = 30, bx = w - m - br - 10, by = h - m - br - 10;
    boostRect = { x: bx, y: by, r: br + 10 };
    hudCtx.globalAlpha = hero.dashCd > 0 ? 0.5 : 1;
    hudCtx.fillStyle = 'rgba(14,18,40,0.5)';
    hudCtx.beginPath(); hudCtx.arc(bx, by, br, 0, Math.PI * 2); hudCtx.fill();
    hudCtx.strokeStyle = 'rgba(255,255,255,0.4)'; hudCtx.lineWidth = 2; hudCtx.stroke();
    if (hero.dashCd > 0) {
      hudCtx.fillStyle = 'rgba(0,0,0,0.45)';
      hudCtx.beginPath();
      hudCtx.moveTo(bx, by);
      hudCtx.arc(bx, by, br, -Math.PI / 2, -Math.PI / 2 + (hero.dashCd / R.dash.cooldown) * Math.PI * 2);
      hudCtx.closePath(); hudCtx.fill();
    }
    hudCtx.fillStyle = '#fff';
    hudCtx.font = '700 ' + (br * 0.9) + 'px ' + FONT;
    hudCtx.textAlign = 'center';
    hudCtx.fillText('⚡', bx, by + br * 0.34);
    hudCtx.globalAlpha = 1;
    /* The 建 button: the workbench's build list. It only exists once the
     * workbench stands (the design doc's stage-0 gate), sits above the dash
     * button, and glows while something in the chain is affordable. */
    if (hasBuilt('workbench') && !buildOffer && phase === 'playing') {
      var canBuild = false, pool0 = offerableSteps();
      for (var pb = 0; pb < pool0.length; pb++) if (canAffordCost(stepCost(pool0[pb]))) canBuild = true;
      var wbr = 26, wbx = w - m - wbr - 10, wby = by - br - wbr - 12;
      buildBtnRect = { x: wbx, y: wby, r: wbr + 10 };
      hudCtx.globalAlpha = buildOpen ? 0.55 : 1;
      hudCtx.fillStyle = canBuild ? 'rgba(60,120,70,0.72)' : 'rgba(14,18,40,0.5)';
      hudCtx.beginPath(); hudCtx.arc(wbx, wby, wbr, 0, Math.PI * 2); hudCtx.fill();
      hudCtx.strokeStyle = canBuild ? 'rgba(200,255,208,0.75)' : 'rgba(255,255,255,0.4)';
      hudCtx.lineWidth = canBuild ? 3 : 2; hudCtx.stroke();
      if (canBuild) { // a slow pulse so the eye finds it
        hudCtx.globalAlpha = 0.25 + Math.sin(performance.now() / 260) * 0.18;
        hudCtx.beginPath(); hudCtx.arc(wbx, wby, wbr + 4, 0, Math.PI * 2); hudCtx.stroke();
        hudCtx.globalAlpha = buildOpen ? 0.55 : 1;
      }
      hudCtx.fillStyle = '#fff';
      hudCtx.font = '800 ' + (wbr * 0.86) + 'px ' + FONT;
      hudCtx.fillText('建', wbx, wby + wbr * 0.32);
      hudCtx.globalAlpha = 1;
    } else buildBtnRect = null;
    /* The workbench build list: one card per step whose prerequisites stand.
     * Same card language as the town blueprint choice, drawn in Canvas 2D. */
    if (buildOpen && phase === 'playing') {
      var sPool = offerableSteps();
      var sCardW = Math.min(w * 0.27, 168), sCardH = sCardW * 0.72;
      var sGap = Math.min(14, w * 0.02);
      var sTotal = sCardW * sPool.length + sGap * Math.max(0, sPool.length - 1);
      var sStartX = (w - sTotal) / 2, sY = h * 0.64;
      hudCtx.fillStyle = 'rgba(8,14,26,0.42)';
      hudCtx.fillRect(0, 0, w, h);
      hudCtx.textAlign = 'center';
      hudCtx.font = '800 ' + (font * 1.05) + 'px ' + FONT;
      hudCtx.fillStyle = '#ffe2a8';
      hudCtx.fillText('工作台 · 建造（← → 或点击）', w / 2, sY - font * 1.1);
      buildCardRects = [];
      for (var sc = 0; sc < sPool.length; sc++) {
        var stp = sPool[sc], sCost = stepCost(stp), sOk = canAffordCost(sCost);
        var scx = sStartX + sc * (sCardW + sGap);
        buildCardRects.push({ x: scx, y: sY, w: sCardW, h: sCardH, id: stp.id });
        hudCtx.fillStyle = sOk ? 'rgba(24,46,66,0.95)' : 'rgba(40,26,26,0.92)';
        roundRect(scx, sY, sCardW, sCardH, 14); hudCtx.fill();
        hudCtx.strokeStyle = sc === buildSel && sOk ? '#ffd166' : 'rgba(255,255,255,0.2)';
        hudCtx.lineWidth = sc === buildSel ? 3 : 1;
        roundRect(scx, sY, sCardW, sCardH, 14); hudCtx.stroke();
        hudCtx.fillStyle = sOk ? '#fff' : 'rgba(255,255,255,0.45)';
        hudCtx.font = '800 ' + (font * 1.05) + 'px ' + FONT;
        hudCtx.fillText(stp.name, scx + sCardW / 2, sY + font * 1.7);
        hudCtx.font = '700 ' + (font * 0.8) + 'px ' + FONT;
        hudCtx.fillStyle = sOk ? '#9ff0b8' : '#ffb4a0';
        hudCtx.fillText(costWords(sCost), scx + sCardW / 2, sY + font * 2.8);
        hudCtx.fillStyle = '#c8e8ff';
        hudCtx.font = '700 ' + (font * 0.76) + 'px ' + FONT;
        hudCtx.fillText(stp.desc, scx + sCardW / 2, sY + sCardH - font * 0.8);
      }
      hudCtx.textAlign = 'left';
    } else buildCardRects = null;
    // Floating world-space texts, projected onto the screen.
    for (var ft = 0; ft < floatingTexts.length; ft++) {
      var ftx = floatingTexts[ft];
      var v = new THREE.Vector3(ftx.x, floatY(ftx.x, ftx.z) + 2.2, ftx.z).project(camera);
      if (v.z > 1) continue;
      var sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h - (1 - ftx.life / ftx.max) * 34;
      hudCtx.globalAlpha = Math.min(1, ftx.life * 2);
      hudCtx.font = '800 ' + (font * 0.95) + 'px ' + FONT;
      hudCtx.lineWidth = 3;
      hudCtx.strokeStyle = 'rgba(20,30,40,0.75)';
      hudCtx.strokeText(ftx.text, sx, sy);
      hudCtx.fillStyle = ftx.color;
      hudCtx.fillText(ftx.text, sx, sy);
    }
    hudCtx.globalAlpha = 1;
    if (hurtFlash > 0) { // red hurt vignette
      var vg = hudCtx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.75);
      vg.addColorStop(0, 'rgba(255,60,60,0)');
      vg.addColorStop(1, 'rgba(255,40,40,' + (hurtFlash * 0.4).toFixed(3) + ')');
      hudCtx.fillStyle = vg;
      hudCtx.fillRect(0, 0, w, h);
    }
    hudCtx.textAlign = 'left';
    if (drag) { // the on-screen joystick, right where the thumb touched
      var jr = 46;
      hudCtx.fillStyle = 'rgba(255,255,255,0.08)';
      hudCtx.beginPath(); hudCtx.arc(drag.x, drag.y, jr, 0, Math.PI * 2); hudCtx.fill();
      hudCtx.strokeStyle = 'rgba(255,255,255,0.35)'; hudCtx.lineWidth = 2;
      hudCtx.beginPath(); hudCtx.arc(drag.x, drag.y, jr, 0, Math.PI * 2); hudCtx.stroke();
      var jd = Math.hypot(drag.dx || 0, drag.dy || 0), jk = jd > 42 ? 42 / jd : 1;
      hudCtx.fillStyle = 'rgba(255,255,255,0.55)';
      hudCtx.beginPath(); hudCtx.arc(drag.x + (drag.dx || 0) * jk, drag.y + (drag.dy || 0) * jk, 20, 0, Math.PI * 2); hudCtx.fill();
    }
    if (cardData) {
      hudCtx.font = '700 ' + font + 'px ' + FONT;
      var cw = Math.min(w * 0.86, 560);
      var lines = wrapLines(cardData.body, cw - 48);
      var ch = font * (4.6 + lines.length * 1.5);
      // Over the title card the panel sits centred; after a round it moves up so
      // the little town you just built stays visible underneath.
      var cy = phase === 'playing' ? (h - ch) / 2 : Math.max(m + font * 5.2, h * 0.1);
      var cx = (w - cw) / 2;
      hudCtx.fillStyle = 'rgba(14,16,38,0.5)';
      roundRect(cx, cy, cw, ch, 22); hudCtx.fill();
      hudCtx.strokeStyle = 'rgba(255,255,255,0.16)'; hudCtx.lineWidth = 1;
      roundRect(cx, cy, cw, ch, 22); hudCtx.stroke();
      hudCtx.textAlign = 'center';
      hudCtx.fillStyle = '#ffe2a8';
      hudCtx.font = '800 ' + font * 2.2 + 'px ' + FONT;
      hudCtx.fillText(cardData.title, w / 2, cy + font * 2.2);
      hudCtx.fillStyle = 'rgba(255,255,255,0.95)';
      hudCtx.font = '400 ' + font + 'px ' + FONT;
      for (var li = 0; li < lines.length; li++) hudCtx.fillText(lines[li], w / 2, cy + font * (3.7 + li * 1.5));
      hudCtx.fillStyle = '#fff3cf';
      hudCtx.font = '700 ' + font + 'px ' + FONT;
      hudCtx.fillText(cardData.hint, w / 2, cy + ch - font * 1.1);
      hudCtx.textAlign = 'left';
    }
  }

  /* 8. GAME STATE */
  var phase = 'title', paused = false, score = 0, best = 0, hearts = R.hearts, timeLeft = R.duration;
  var elapsed = 0, spawnTimer = 0, invulnerable = 0, shield = 0, sinceShield = 0, endedAt = 0, fps = 60;
  var buildings = [], lastReason = 'town';
  var combo = 0, lastPick = -99, comboShowT = 0, specialTimer = 0, shake = 0, hurtFlash = 0, wakeTimer = 0;
  var floatingTexts = [];
  var tally = {}, pieces = 0; // what was collected this round, per kind
  /** The town's stockpile: garbage turns into these three building materials. */
  var res = { wood: 0, plastic: 0, metal: 0 };
  var pop = 0;               // residents living on the raft
  var nextBuild = 0;         // index into BUILDING_SPECS of the building waiting to be paid for
  var baseHearts = R.hearts, baseSpeed = R.heroSpeed; // per-run baselines the buildings raise
  /* Survival: the canteen and the belly. `canteen` drains as you haul garbage and
   * `food` drains slowly from the moment the fish basket stands; either one at
   * zero costs hearts. (Named `canteen`/`food`, not `water` — `water` is the sea
   * mesh — and the water gainers are the rain catcher and the purifier.) */
  var canteen = 100, maxWater = 100, food = 100, maxFood = 100;
  var rainClock = 0, purifyClock = 0, hungerClock = 0, starveT = 0, foodDropT = 0;
  var selfSustainT = 0;       // seconds both bars have stayed above zero
  var townReady = false;      // self-sustained once → the town is unlocked
  var townReadyBanner = 0;
  var survivalModels = [], shelterCut = 0;
  var magnet = 0, tradeBonus = 0, shieldBonus = 0;
  /* The build choice: two blueprints on offer, the player picks one. */
  var buildOffer = null, buildOfferT = 0, offerCooldown = 6, buildSel = 0, buildCardRects = null;
  var surgeT = 0, surgeShowT = 0, waterDry = 0, waterDropT = 0, guardT = 0;
  function canAfford(spec) {
    return res.wood >= spec.cost.wood && res.plastic >= spec.cost.plastic && res.metal >= spec.cost.metal;
  }
  function costText(spec) {
    var parts = [];
    if (spec.cost.wood) parts.push('木' + spec.cost.wood);
    if (spec.cost.plastic) parts.push('塑' + spec.cost.plastic);
    if (spec.cost.metal) parts.push('铁' + spec.cost.metal);
    return parts.join(' ');
  }
  function payFor(spec) {
    res.wood -= spec.cost.wood; res.plastic -= spec.cost.plastic; res.metal -= spec.cost.metal;
  }
  function addFT(text, x, z, color, life) {
    if (floatingTexts.length > 14) floatingTexts.shift();
    floatingTexts.push({ text: text, x: x, z: z, color: color || '#ffffff', life: life || 1.1, max: life || 1.1 });
  }
  try { best = Number(window.localStorage.getItem('dsh-game-studio:drift-town:best')) || 0; } catch (e) { best = 0; }

  function randomSea(minFromHero) {
    for (var tries = 0; tries < 400; tries++) {
      var a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * (HALF - 3);
      var p = { x: Math.cos(a) * r, z: Math.sin(a) * r };
      if (Math.hypot(p.x - hero.x, p.z - hero.z) < minFromHero) continue;
      if (groundAt(p.x, p.z) > 0) continue; // garbage floats and sharks swim, both in open water
      return p;
    }
    return null;
  }
  /** Ordinary sea, kept out of the patrolled zone so safe loot always exists. */
  function randomSeaSafe(minFromHero) {
    for (var tries = 0; tries < 500; tries++) {
      var a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * (HALF - 3);
      var p = { x: Math.cos(a) * r, z: Math.sin(a) * r };
      if (Math.hypot(p.x - hero.x, p.z - hero.z) < minFromHero) continue;
      if (groundAt(p.x, p.z) > 0) continue;
      if (inZone(p.x, p.z)) continue;       // not in the dangerous patch
      return p;
    }
    return randomSea(minFromHero);
  }
  /** The deep-water zone: a moving patch of sea where the best loot drifts,
   *  patrolled by a shark. Risk for reward. */
  var zone = { x: 0, z: 0, r: 5.5, vx: 0.3, vz: 0.2, a: 0 };
  function inZone(x, z) { return Math.hypot(x - zone.x, z - zone.z) < zone.r; }
  function moveZone(dt) {
    zone.a += dt;
    zone.x += zone.vx * dt;
    zone.z += zone.vz * dt;
    var lim = HALF - zone.r - 2;
    if (zone.x > lim || zone.x < -lim) { zone.vx *= -1; zone.x = clamp(zone.x, -lim, lim); }
    if (zone.z > lim || zone.z < -lim) { zone.vz *= -1; zone.z = clamp(zone.z, -lim, lim); }
  }
  /** Keep the surface marker on the zone and give it a slow breathing pulse. */
  function moveZoneTracking(t) {
    if (!zoneRing) return;
    zoneRing.position.x = zone.x;
    zoneRing.position.z = zone.z;
    zoneDisc.position.x = zone.x;
    zoneDisc.position.z = zone.z;
    var breathe = 1 + Math.sin(t * 1.6) * 0.045;
    zoneRing.scale.setScalar(zone.r * breathe);
    zoneDisc.scale.setScalar(zone.r * 0.97);
    zoneRing.material.opacity = 0.42 + Math.sin(t * 2.2) * 0.16;
  }
  function zonePoint() {
    for (var tries = 0; tries < 40; tries++) {
      var a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * zone.r * 0.85;
      var x = zone.x + Math.cos(a) * r, z = zone.z + Math.sin(a) * r;
      if (Math.hypot(x, z) < HALF - 2 && groundAt(x, z) <= 0) return { x: x, z: z };
    }
    return null;
  }
  /** Offer the next building choice: two blueprints, the player picks one.
   *  With `autoBuild` on (the default, for a rhythm-first run) the choice is
   *  made for you and the game never stops. */
  function offerBuild() {
    if (nextBuild >= BUILDING_SPECS.length) return;
    if (buildOffer) return;
    if (R.autoBuild) {   // keep the rhythm: build the cheapest affordable one now
      for (var k = nextBuild; k < BUILDING_SPECS.length; k++) {
        if (canAfford(BUILDING_SPECS[k])) { pickBuildSpec(k); return; }
      }
      return;
    }
    var pool = [];
    for (var i = nextBuild; i < Math.min(nextBuild + 2, BUILDING_SPECS.length); i++) pool.push(i);
    if (!pool.length) return;
    buildOffer = pool;
    buildSel = 0;
    buildOfferT = 0;
    fanfare([660, 880], 0.1, 'sine', 0.05);
  }
  function pickBuild(poolIndex) {
    if (!buildOffer) return;
    var specIndex = buildOffer[Math.max(0, Math.min(buildOffer.length - 1, poolIndex))];
    buildOffer = null;
    pickBuildSpec(specIndex);
  }
  function pickBuildSpec(specIndex) {
    var spec = BUILDING_SPECS[specIndex];
    if (!canAfford(spec)) { addFT('材料不够！', hero.x, hero.z, '#ff9a96', 1.2); return; }
    payFor(spec);
    var model = voxelModel(BUILDING_BOXES[specIndex]);
    var at = BUILDING_POS[buildings.length % BUILDING_POS.length];
    model.position.set(at[0], at[1], at[2]);
    model.scale.setScalar(BUILDING_SCALE);
    model.userData.pop = 0;
    hero.node.userData.body.add(model);
    buildings.push(model);
    if (spec.perk === 'speed' || specIndex === BUILDING_SPECS.length - 1) {
      var blades = voxelModel(BLADE_BOXES);
      blades.position.set(0, 1.78, 0.34);
      model.add(blades);
      model.userData.blades = blades;
    }
    pop += spec.pop;
    nextBuild = buildings.length;
    if (spec.perk === 'maxHearts' && baseHearts < 5) { baseHearts += 1; R.hearts = baseHearts; hearts = Math.min(hearts + 1, R.hearts); }
    if (spec.perk === 'speed') baseSpeed += 0.5;
    if (spec.perk === 'water') maxWater += 25;
    if (spec.perk === 'magnet') magnet += 0.9;
    if (spec.perk === 'trade') tradeBonus += 1;
    if (spec.perk === 'shields') shieldBonus += 2;
    addFT(spec.name + ' 落成！', hero.x, hero.z, '#ffe2a8', 2);
    burst(hero.x, hero.y + R.heroSize, hero.z);
    fanfare([523, 659, 784], 0.09, 'triangle', 0.07);
    if (buildings.length >= BUILDING_SPECS.length) finish('town');
  }
  /* --- The survival build order (stage 1). The chain, not the wallet, is what
   *  gates progress: a piece is offered only when its prerequisites stand. --- */
  var SURV = R.survival;
  var survival = [];          // ids of everything already standing on the raft
  var buildOpen = false;      // true while the workbench build list is on screen
  function hasBuilt(id) { return survival.indexOf(id) >= 0; }
  function stepById(id) {
    for (var i = 0; i < SURVIVAL_STEPS.length; i++) if (SURVIVAL_STEPS[i].id === id) return SURVIVAL_STEPS[i];
    return null;
  }
  function stepCost(step) {
    var c = SURV[step.id];
    return c && typeof c === 'object' ? { wood: c.wood || 0, plastic: c.plastic || 0, metal: c.metal || 0 }
      : { wood: 0, plastic: 0, metal: 0 };
  }
  function canAffordCost(cost) { return res.wood >= cost.wood && res.plastic >= cost.plastic && res.metal >= cost.metal; }
  function costWords(cost) {
    var parts = [];
    if (cost.wood) parts.push('木' + cost.wood);
    if (cost.plastic) parts.push('塑' + cost.plastic);
    if (cost.metal) parts.push('铁' + cost.metal);
    return parts.join(' ') || '免费';
  }
  /** The next survival step the chain is ready for, or null when everything stands. */
  function nextSurvivalStep() {
    for (var i = 0; i < SURVIVAL_STEPS.length; i++) {
      var step = SURVIVAL_STEPS[i];
      if (hasBuilt(step.id)) continue;
      var ready = true;
      for (var n = 0; n < step.needs.length; n++) if (!hasBuilt(step.needs[n])) ready = false;
      if (ready) return step;
    }
    return null;
  }
  /** Everything the chain could offer right now (prerequisites met, not yet built). */
  function offerableSteps() {
    var out = [];
    for (var i = 0; i < SURVIVAL_STEPS.length; i++) {
      var step = SURVIVAL_STEPS[i];
      if (hasBuilt(step.id)) continue;
      var ready = true;
      for (var n = 0; n < step.needs.length; n++) if (!hasBuilt(step.needs[n])) ready = false;
      if (ready) out.push(step);
    }
    return out;
  }
  /** The one-line "build this next" prompt, with its price, or '' when done. */
  function survivalHintText() {
    var step = nextSurvivalStep();
    if (!step) return '';
    return '造' + step.name + ' ' + costWords(stepCost(step));
  }
  /** The workbench turns the deck into a building site: tap 建 or press B. */
  function openBuildMenu() {
    if (!hasBuilt('workbench') || buildOpen) return;
    var pool = offerableSteps();
    if (!pool.length) return;
    buildOpen = true; buildSel = 0; buildCardRects = null;
    blip(620, 0.1, 'sine', 0.04, 820);
  }
  function closeBuildMenu() { buildOpen = false; buildSel = 0; buildCardRects = null; }
  function pickSurvival(id) {
    var step = stepById(id);
    if (!step || hasBuilt(step.id)) return false;
    var cost = stepCost(step);
    if (!canAffordCost(cost)) { addFT('材料不够！', hero.x, hero.z, '#ff9a96', 1.2); return false; }
    for (var i = 0; i < survival.length; i++) if (survival[i] === step.id) return false;
    res.wood -= cost.wood; res.plastic -= cost.plastic; res.metal -= cost.metal;
    var model = voxelModel(step.boxes);
    model.position.set(step.at[0], step.at[1], step.at[2]);
    model.scale.setScalar(step.scale);
    model.userData.pop = 0;
    hero.node.userData.body.add(model);
    model.userData.stepId = step.id;
    survival.push(step.id);
    survivalModels.push(model);
    addFT(step.name + ' 落成！', hero.x, hero.z, '#ffe2a8', 2);
    burst(hero.x, hero.y + R.heroSize, hero.z);
    fanfare([523, 659, 784], 0.09, 'triangle', 0.07);
    return true;
  }
  /** Build the next step in the chain, whatever it is (used by the autopilot). */
  function buildNextSurvival() {
    var step = nextSurvivalStep();
    if (!step) return false;
    return pickSurvival(step.id);
  }

  /* Loot spawns right around the raft, so the next pickup is always a short
   *  hop away and the loop keeps its rhythm. */
  function nearSea(minFromHero) {
    for (var tries = 0; tries < 300; tries++) {
      var a = Math.random() * Math.PI * 2;
      var r = 3.2 + Math.random() * 6;
      var x = hero.x + Math.cos(a) * r, z = hero.z + Math.sin(a) * r;
      if (Math.hypot(x, z) > HALF - 3) continue;
      if (groundAt(x, z) > 0) continue;
      return { x: x, z: z };
    }
    return randomSeaSafe(minFromHero);
  }
  function addPickup() {
    // A third of the loot drifts in the deep-water zone: better material, more risk.
    var deep = Math.random() < 0.3;
    var p = deep ? zonePoint() : nearSea(3);
    if (!p) { p = randomSeaSafe(3); deep = false; }
    if (!p) return;
    // Rarer kinds are worth more: roll low-value pieces more often.
    // Weights are tuned so the three material lines arrive at a similar rate.
    var roll = Math.random() * 12, kind = PICKUP_KINDS[0];
    if (roll < 2.6) kind = PICKUP_KINDS[0];      // 塑料瓶  plastic
    else if (roll < 5.2) kind = PICKUP_KINDS[1]; // 易拉罐  metal
    else if (roll < 7.0) kind = PICKUP_KINDS[3]; // 木箱    wood
    else if (roll < 8.6) kind = PICKUP_KINDS[2]; // 橡皮鸭  plastic
    else if (roll < 9.8) kind = PICKUP_KINDS[4]; // 木桶    wood+metal
    else if (roll < 10.8) kind = PICKUP_KINDS[5]; // 轮胎   plastic+metal
    else kind = PICKUP_KINDS[6];                 // 渔网    wood+plastic
    var node = makeCharacter('pickup', R.pickupSize, kind.model);
    var glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: deep ? '#ffe866' : kind.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.set(R.pickupSize * (deep ? 3.1 : 2.4), R.pickupSize * (deep ? 3.1 : 2.4), 1);
    glow.position.y = R.pickupSize * 0.5;
    node.add(glow);
    // Deep-water loot is worth double; that is what pays for the extra danger.
    var res = kind.res, mult = deep ? 2 : 1;
    pickups.push({
      x: p.x, z: p.z, phase: Math.random() * 6, drift: Math.random() * 6, node: node, glow: glow,
      special: null, value: kind.value * mult, glowColor: deep ? '#ffe866' : kind.glow,
      name: deep ? '极品' + kind.name : kind.name, res: res, mult: mult, deep: deep
    });
  }
  function hasSpecial() {
    for (var i = 0; i < pickups.length; i++) if (pickups[i].special) return true;
    return false;
  }
  /** Drop a water canteen into the sea: the only way to refill away from the raft. */
  function addWaterDrop() {
    var p = randomSeaSafe(5);
    if (!p) return;
    var node = makeCharacter('pickup', R.pickupSize, WATER_BOXES);
    var glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: '#9fe0ff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.set(R.pickupSize * 3, R.pickupSize * 3, 1);
    glow.position.y = R.pickupSize * 0.5;
    node.add(glow);
    pickups.push({ x: p.x, z: p.z, phase: Math.random() * 6, drift: Math.random() * 6, node: node, glow: glow, special: 'water', value: 0, glowColor: '#9fe0ff', name: '淡水' });
  }
  /** A bait pail of small fish in the water: the quick way to fill the belly bar. */
  function addFoodDrop() {
    var p = randomSeaSafe(5);
    if (!p) return;
    var node = makeCharacter('pickup', R.pickupSize, FOOD_BOXES);
    var glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: '#c8f0b0', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.set(R.pickupSize * 3, R.pickupSize * 3, 1);
    glow.position.y = R.pickupSize * 0.5;
    node.add(glow);
    pickups.push({ x: p.x, z: p.z, phase: Math.random() * 6, drift: Math.random() * 6, node: node, glow: glow, special: 'food', value: 0, glowColor: '#c8f0b0', name: '鱼干' });
  }
  function addSpecial() {
    var type = hearts < R.hearts ? 'ring' : (Math.random() < 0.45 ? 'chest' : null);
    if (!type) return;
    var p = randomSeaSafe(6);
    if (!p) return;
    var node = makeCharacter('pickup', R.pickupSize, SPECIAL_MODELS[type]);
    var glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: type === 'ring' ? '#ff9fb0' : '#ffd166', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.set(R.pickupSize * 3, R.pickupSize * 3, 1);
    glow.position.y = R.pickupSize * 0.5;
    node.add(glow);
    pickups.push({ x: p.x, z: p.z, phase: Math.random() * 6, drift: Math.random() * 6, node: node, glow: glow, special: type, value: 0, glowColor: type === 'ring' ? '#ff9fb0' : '#ffd166', name: type === 'ring' ? '救生圈' : '宝箱' });
    blip(type === 'chest' ? 880 : 660, 0.2, 'sine', 0.05, type === 'chest' ? 1320 : 880);
  }
  function addEnemy() {
    var p = randomSeaSafe(10);
    if (!p) return;
    addEnemyAt(p.x, p.z);
  }
  function addEnemyAt(x, z) {
    // From the halfway point some sharks are hammerheads: wider, faster, harder to dodge.
    var hammer = elapsed > R.duration * 0.5 && Math.random() < 0.3;
    var ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.85, 26), new THREE.MeshBasicMaterial({ color: '#ff4d4d', transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    scene.add(ring);
    enemies.push({
      x: x, z: z, y: floatY(x, z), wobble: Math.random() * 6,
      node: makeCharacter('enemy', hammer ? R.enemySize * 1.12 : R.enemySize, hammer ? HAMMER_BOXES : SHARK_BOXES),
      state: 'cruise', st: 0, nextLunge: 2.5 + Math.random() * 4, lx: 0, lz: 0, ring: ring,
      hammer: hammer, speedMul: hammer ? 1.25 : 1, lungeMul: hammer ? 2.55 : 2.3
    });
  }
  function clearEntities() {
    enemies.forEach(function (e) { scene.remove(e.node); scene.remove(e.ring); });
    pickups.forEach(function (p) { scene.remove(p.node); });
    enemies = [];
    pickups = [];
  }

  /** A one-line summary of what was fished out this round, biggest kinds first. */
  function tallyLine() {
    var parts = [], keys = Object.keys(tally);
    keys.sort(function (a, b) { return tally[b] - tally[a]; });
    for (var i = 0; i < keys.length && i < 4; i++) parts.push(keys[i] + '×' + tally[keys[i]]);
    return parts.length ? parts.join('  ') : '空手而归';
  }
  function setPhase(next) {
    phase = next;
    endedAt = performance.now();
    if (next !== 'playing' && drag) drag = null;
    if (next === 'title') showCard(TITLE, '打捞垃圾换材料。先造工作台，再盖庇护所，然后补齐四件生存装备——水与食能自持，才算站住了脚。躲开鲨鱼的红色预警圈，⚡冲刺能帮你脱身。', '按任意键 / 点击屏幕开始');
    else if (next === 'playing') clearCard();
    else if (next === 'won') {
      var head = lastReason === 'town' ? '漂流小镇落成！' : '小镇初具规模';
      showCard(head,
        townCount() + '/' + townTarget() + ' 座建筑 · ' + pop + ' 位居民 · ' + pieces + ' 件垃圾 · ' + score + ' 分\n' + tallyLine() + '\n最佳: ' + best,
        '按任意键 / 点击屏幕再来一局');
    } else if (next === 'lost') {
      var why = lastReason === 'shark' ? '木筏被鲨鱼撞散了！'
        : lastReason === 'thirst' ? '水喝完了，船员撑不住了…'
        : lastReason === 'hunger' ? '食物吃完了，船员饿垮了…' : '天黑了，垃圾漂走了…';
      showCard(why,
        townCount() + '/' + townTarget() + ' 座建筑 · ' + pop + ' 位居民 · ' + pieces + ' 件垃圾 · ' + score + ' 分\n' + tallyLine() + '\n最佳: ' + best,
        '按任意键 / 点击屏幕再试一次');
    }
    post({ type: 'state', phase: phase, score: score });
  }
  function start() {
    clearEntities();
    buildings.forEach(function (b) { hero.node.userData.body.remove(b); });
    buildings = [];
    survivalModels.forEach(function (b) { hero.node.userData.body.remove(b); });
    survivalModels = []; survival = [];
    buildOpen = false; buildSel = 0; buildCardRects = null; shelterCut = 0;
    score = 0; hearts = R.hearts; timeLeft = R.duration; elapsed = 0; spawnTimer = 0;
    invulnerable = 0; shield = 0; sinceShield = 0; paused = false;
    combo = 0; lastPick = -99; comboShowT = 0; specialTimer = 0; shake = 0; hurtFlash = 0; wakeTimer = 0;
    floatingTexts = []; tally = {}; pieces = 0;
    res = { wood: 0, plastic: 0, metal: 0 }; pop = 0; nextBuild = 0;
    baseHearts = R.hearts; baseSpeed = R.heroSpeed;
    canteen = 100; maxWater = 100; magnet = 0; tradeBonus = 0; shieldBonus = 0;
    food = 100; maxFood = 100; rainClock = 0; purifyClock = 0; hungerClock = 0;
    starveT = 0; foodDropT = 0; selfSustainT = 0; townReady = false; townReadyBanner = 0;
    buildOffer = null; buildSel = 0; buildOfferT = 0; offerCooldown = 5;
    surgeT = 0; surgeShowT = 0; waterDry = 0; waterDropT = 0; guardT = 0;
    // Keep the patrolled zone away from where the raft starts.
    var zAng = Math.random() * Math.PI * 2, zDist = HALF * 0.5;
    zone.x = Math.cos(zAng) * zDist; zone.z = Math.sin(zAng) * zDist;
    hero.x = 0; hero.z = 0; hero.vx = hero.vz = 0; hero.dashT = 0; hero.dashCd = 0;
    ensureMusic();
    for (var i = 0; i < R.maxPickups; i++) addPickup();
    addEnemy();   // one shark to start; the spawn timer brings the rest
    blip(520, 0.12, 'triangle', 0.07, 780);
    setPhase('playing');
  }
  function finish(result) {
    if (score > best) { best = score; try { window.localStorage.setItem('dsh-game-studio:drift-town:best', String(best)); } catch (e) { /* sandboxed */ } }
    var won = result === 'town' || result === 'partial';
    lastReason = result;
    blip(won ? 660 : 220, 0.5, won ? 'triangle' : 'sawtooth', 0.06, won ? 990 : 110);
    setPhase(won ? 'won' : 'lost');
  }
  function canRestart() { return performance.now() - endedAt > 600; }
  /** 镇 x/6 counts the town buildings plus the shelter: a home is a home. The
   *  town still cannot win before the survival layer is self-sustaining. */
  function townCount() { return buildings.length + (SURV.shelterCountsAsTown && hasBuilt('shelter') ? 1 : 0); }
  function townTarget() { return 6; }

  /* 9. INPUT — screen-aligned: right is +x, up is -z (the camera never turns). */
  var keys = {};
  var KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'boost', KeyJ: 'boost' };
  window.addEventListener('keydown', function (event) {
    if (event.code === 'KeyM') { muted = !muted; return; }
    if (phase === 'playing' && event.code === 'KeyP') { paused = !paused; showPause(); return; }
    // The workbench build list: ← / → pick, Enter builds, B / Esc closes.
    if (buildOpen) {
      var pool = offerableSteps();
      if (event.code === 'ArrowLeft' || event.code === 'KeyA') { buildSel = Math.max(0, buildSel - 1); event.preventDefault(); return; }
      if (event.code === 'ArrowRight' || event.code === 'KeyD') { buildSel = Math.min(pool.length - 1, buildSel + 1); event.preventDefault(); return; }
      if (event.code === 'Enter' || event.code === 'Space' || event.code === 'NumpadEnter') {
        if (pool[buildSel]) {
          pickSurvival(pool[buildSel].id);
          if (!offerableSteps().length) closeBuildMenu(); else buildSel = Math.min(buildSel, offerableSteps().length - 1);
        }
        event.preventDefault(); return;
      }
      if (event.code === 'KeyB' || event.code === 'Escape') { closeBuildMenu(); event.preventDefault(); return; }
      return;
    }
    if (event.code === 'KeyB' && phase === 'playing' && !paused) { openBuildMenu(); event.preventDefault(); return; }
    // While a blueprint is on offer the run pauses and ← / → / Enter pick one.
    if (buildOffer) {
      if (event.code === 'ArrowLeft' || event.code === 'KeyA') { buildSel = Math.max(0, buildSel - 1); event.preventDefault(); return; }
      if (event.code === 'ArrowRight' || event.code === 'KeyD') { buildSel = Math.min(buildOffer.length - 1, buildSel + 1); event.preventDefault(); return; }
      if (event.code === 'Enter' || event.code === 'Space' || event.code === 'NumpadEnter') { pickBuild(buildSel); event.preventDefault(); return; }
      return; // other keys are ignored while choosing
    }
    if (KEYMAP[event.code]) { keys[KEYMAP[event.code]] = true; event.preventDefault(); }
    if (phase !== 'playing' && canRestart()) start();
  });
  window.addEventListener('keyup', function (event) { if (KEYMAP[event.code]) keys[KEYMAP[event.code]] = false; });
  window.addEventListener('blur', function () { keys = {}; });
  function showPause() {
    if (paused) showCard('已暂停', '按 P 继续', '');
    else clearCard();
  }
  var drag = null;
  canvas.addEventListener('pointerdown', function (event) {
    try { canvas.focus(); } catch (e) { /* focus is a desktop nicety */ }
    if (phase !== 'playing') { if (canRestart()) start(); return; }
    // The workbench build list: tap a card to build it, tap elsewhere to close.
    if (buildOpen) {
      if (buildCardRects) {
        for (var sb = 0; sb < buildCardRects.length; sb++) {
          var sbR = buildCardRects[sb];
          if (event.clientX >= sbR.x && event.clientX <= sbR.x + sbR.w
              && event.clientY >= sbR.y && event.clientY <= sbR.y + sbR.h) {
            pickSurvival(sbR.id);
            if (!offerableSteps().length) closeBuildMenu();
            return;
          }
        }
      }
      closeBuildMenu();
      return;
    }
    // The 建 button (only there once the workbench stands) opens the build list.
    if (buildBtnRect) {
      var bbx = event.clientX - buildBtnRect.x, bby = event.clientY - buildBtnRect.y;
      if (bbx * bbx + bby * bby <= buildBtnRect.r * buildBtnRect.r) { openBuildMenu(); return; }
    }
    // Tapping a blueprint card picks it; the run is paused behind the offer.
    if (buildOffer && buildCardRects) {
      for (var bc = 0; bc < buildCardRects.length; bc++) {
        var rc = buildCardRects[bc];
        if (event.clientX >= rc.x && event.clientX <= rc.x + rc.w
            && event.clientY >= rc.y && event.clientY <= rc.y + rc.h) {
          pickBuild(rc.index); return;
        }
      }
      return; // taps outside the cards are ignored while choosing
    }
    if (boostRect) {
      var bdx = event.clientX - boostRect.x, bdy = event.clientY - boostRect.y;
      if (bdx * bdx + bdy * bdy <= boostRect.r * boostRect.r) { triggerDash(); return; }
    }
    if (!drag) {
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0 };
      try { canvas.setPointerCapture(event.pointerId); } catch (e) { /* not captured */ }
    }
  });
  canvas.addEventListener('pointermove', function (event) {
    if (!drag || event.pointerId !== drag.id) return;
    drag.dx = event.clientX - drag.x;
    drag.dy = event.clientY - drag.y;
  });
  function endDrag(event) {
    if (drag && event.pointerId === drag.id) drag = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  function inputDirection() {
    var x = (keys.right ? 1 : 0) - (keys.left ? 1 : 0), z = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    if (drag) {
      var length = Math.hypot(drag.dx, drag.dy);
      if (length > 10) { x = drag.dx / length; z = drag.dy / length; }
    }
    var magnitude = Math.hypot(x, z);
    return magnitude > 0 ? { x: x / magnitude, z: z / magnitude } : { x: 0, z: 0 };
  }

  /** The raft's burst of speed: keyboard Space/J, or the on-screen ⚡ button. */
  function triggerDash() {
    if (phase !== 'playing' || paused || hero.dashCd > 0) return;
    var dir = inputDirection();
    if (!dir.x && !dir.z) dir = { x: Math.sin(hero.facing), z: Math.cos(hero.facing) };
    hero.dashT = R.dash.time;
    hero.dashCd = R.dash.cooldown;
    hero.dashX = dir.x; hero.dashZ = dir.z;
    spawnFoam(hero.x, hero.z, 10, 2.5);
    blip(300, 0.18, 'triangle', 0.05, 700);
  }

  /** Move with sliding: try each axis on its own, and keep a body radius clear of blocked cells. */
  function moveOnIsland(entity, dx, dz, radius) {
    var nx = entity.x + dx;
    if (walkable(nx + Math.sign(dx) * radius, entity.z) && walkable(nx, entity.z)) entity.x = nx;
    var nz = entity.z + dz;
    if (walkable(entity.x, nz + Math.sign(dz) * radius) && walkable(entity.x, nz)) entity.z = nz;
  }

  /* 10. UPDATE */
  function update(dt, now) {
    // A blueprint on offer freezes the action: the choice is the decision point.
    if (phase === 'playing' && !paused && !buildOffer && !buildOpen) {
      elapsed += dt;
      timeLeft = Math.max(0, timeLeft - dt);
      invulnerable = Math.max(0, invulnerable - dt);
      shield = Math.max(0, shield - dt);
      moveZone(dt);
      // Thirst: a gentle clock, not a death spiral. Refills are always near.
      canteen = Math.max(0, canteen - dt * SURV.thirstRate);
      if (canteen <= 0) {
        waterDry = (waterDry || 0) + dt;
        if (waterDry > 1.2) {
          waterDry = 0;
          if (invulnerable <= 0) {
            hearts -= 1; invulnerable = 1.2; hurtFlash = 1; shake = 0.6;
            addFT('口渴 -1♥', hero.x, hero.z, '#ff9a96', 1.3);
            blip(140, 0.3, 'sawtooth', 0.05, 80);
            if (hearts <= 0) { finish('thirst'); return; }
          }
        }
      } else waterDry = 0;
      // A canteen drifts in now and then, so refills are always reachable.
      waterDropT = (waterDropT || 0) + dt;
      if (waterDropT > 7 && canteen < maxWater * 0.75) { waterDropT = 0; addWaterDrop(); }
      /* --- Survival gear: once something stands on the deck it works by itself,
       *  which is what turns thirst and hunger from a panic into background. --- */
      if (hasBuilt('rainCatcher')) {
        rainClock += dt;
        if (rainClock >= SURV.rainEvery) {
          rainClock = 0;
          canteen = Math.min(maxWater, canteen + SURV.rainAmount);
          addFT('集雨 +' + SURV.rainAmount, hero.x - 1, hero.z, '#9fe0ff', 1);
        }
      } else rainClock = 0;
      if (hasBuilt('purifier')) {
        purifyClock += dt;
        if (purifyClock >= SURV.purifyEvery) {
          purifyClock = 0;
          canteen = Math.min(maxWater, canteen + SURV.purifyAmount);
          addFT('净水 +' + SURV.purifyAmount, hero.x + 1, hero.z, '#9fe0ff', 1);
        }
      } else purifyClock = 0;
      /* --- Belly: the hunger bar only appears once the fish basket is built, so
       *  stage 0 stays gentle and stage 1 adds the second clock. --- */
      if (hasBuilt('fishBasket')) {
        food = Math.max(0, food - dt * SURV.hungerRate);
        hungerClock += dt;
        if (hungerClock >= SURV.fishEvery) {
          hungerClock = 0;
          food = Math.min(maxFood, food + SURV.fishAmount);
          addFT('鱼篓 +' + SURV.fishAmount, hero.x, hero.z + 1, '#c8f0b0', 1);
        }
        foodDropT += dt;
        if (foodDropT > SURV.foodDropEvery && food < maxFood * 0.7) { foodDropT = 0; addFoodDrop(); }
        if (food <= 0) {
          starveT += dt;
          if (starveT > SURV.starveEvery) {
            starveT = 0;
            if (invulnerable <= 0) {
              hearts -= 1; invulnerable = 1.2; hurtFlash = 1; shake = 0.6;
              addFT('饥饿 -1♥', hero.x, hero.z, '#ffcf9a', 1.3);
              blip(130, 0.3, 'sawtooth', 0.05, 70);
              if (hearts <= 0) { finish('hunger'); return; }
            }
          }
        } else starveT = 0;
      } else { food = maxFood; hungerClock = 0; starveT = 0; foodDropT = 0; }
      /* --- Self-sustaining: both bars held above zero long enough that the crew
       *  could stop collecting and still live. That is the gate on the town. --- */
      if (hasBuilt('fishBasket') && canteen > 0 && food > 0) {
        selfSustainT += dt;
        if (!townReady && selfSustainT >= SURV.selfSustainSec) {
          townReady = true; townReadyBanner = 3.5;
          addFT('可以建立城镇了！', hero.x, hero.z, '#ffe2a8', 3);
          fanfare([523, 659, 784, 1047], 0.13, 'triangle', 0.07);
        }
      } else selfSustainT = 0;
      townReadyBanner = Math.max(0, townReadyBanner - dt);
      // The build choice becomes available once the stockpile covers a blueprint.
      if (!buildOffer && nextBuild < BUILDING_SPECS.length && canAfford(BUILDING_SPECS[nextBuild]) && townReady) {
        offerCooldown -= dt;
        if (offerCooldown <= 0) { offerBuild(); offerCooldown = 6; }
      }

      var dir = inputDirection();
      if (keys.boost) triggerDash();
      hero.dashT = Math.max(0, hero.dashT - dt);
      hero.dashCd = Math.max(0, hero.dashCd - dt);
      // Snappier helm: the raft answers the stick quickly, so dodging works.
      if (hero.dashT > 0) {
        hero.vx = lerp(hero.vx, hero.dashX * R.dash.speed, Math.min(1, dt * 22));
        hero.vz = lerp(hero.vz, hero.dashZ * R.dash.speed, Math.min(1, dt * 22));
      } else {
        hero.vx = lerp(hero.vx, dir.x * R.heroSpeed, Math.min(1, dt * 20));
        hero.vz = lerp(hero.vz, dir.z * R.heroSpeed, Math.min(1, dt * 20));
      }
      moveOnIsland(hero, hero.vx * dt, hero.vz * dt, 0.3);
      if (Math.abs(hero.vx) + Math.abs(hero.vz) > 0.4) hero.facing = Math.atan2(hero.vx, hero.vz);
      // Foam wake trailing a moving raft.
      var heroSpd = Math.hypot(hero.vx, hero.vz);
      wakeTimer -= dt;
      if (heroSpd > 3 && wakeTimer <= 0) {
        wakeTimer = 0.07;
        spawnFoam(hero.x - hero.vx / heroSpd * 1.2, hero.z - hero.vz / heroSpd * 1.2, 2, 0.8);
      }

      spawnTimer += dt;
      if (spawnTimer >= R.enemySpawnEvery && enemies.length < R.maxEnemies) { spawnTimer = 0; addEnemy(); }
      // Shark surge: every so often a small pack arrives at once. Keep moving.
      surgeT += dt;
      if (surgeT >= 22) {
        surgeT = 0;
        var packSize = 1 + (Math.random() < 0.35 ? 1 : 0);
        for (var sp2 = 0; sp2 < packSize && enemies.length < R.maxEnemies + 2; sp2++) addEnemy();
        surgeShowT = 2.2;
        addFT('鲨鱼潮！', hero.x + 2, hero.z, '#ff9a96', 2);
        blip(70, 0.6, 'sawtooth', 0.07, 50);
      } else surgeShowT = Math.max(0, surgeShowT - dt);
      // The deep-water zone is patrolled, but one guard at a time only.
      var zoneGuard = 0;
      for (var zg = 0; zg < enemies.length; zg++) if (inZone(enemies[zg].x, enemies[zg].z)) zoneGuard++;
      if (zoneGuard < 1 && enemies.length < R.maxEnemies + 1) {
        guardT = (guardT || 0) + dt;
        if (guardT > 10) { guardT = 0; var zp = zonePoint(); if (zp) addEnemyAt(zp.x, zp.z); }
      }
      specialTimer += dt;
      if (specialTimer >= R.specialEvery) { specialTimer = 0; addSpecial(); }
      var speed = R.enemySpeed + R.enemySpeedGrowth * elapsed;
      for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i], tx = hero.x - e.x, tz = hero.z - e.z, dist = Math.hypot(tx, tz) || 1;
        var ax = tx / dist, az = tz / dist, mv = speed * e.speedMul;
        for (var j = 0; j < enemies.length; j++) {
          if (i === j) continue;
          var ox = e.x - enemies[j].x, oz = e.z - enemies[j].z, od = Math.hypot(ox, oz);
          if (od > 0 && od < 1.6) { ax += ox / od * 0.8; az += oz / od * 0.8; }
        }
        // Shark states: cruise in slow, telegraph a lunge, dash, then cool off.
        if (e.state === 'cruise') {
          mv = speed * e.speedMul * (dist > 6 ? 1 : 0.55);
          if (dist < 3) { ax += -tz / dist * 0.9; az += tx / dist * 0.9; } // circle sideways
          e.nextLunge -= dt;
          if (e.nextLunge <= 0 && dist < 4.2) {
            e.state = 'windup'; e.st = e.hammer ? 0.58 : 0.7; e.ring.visible = true;
            e.lx = tx / dist; e.lz = tz / dist;
            blip(e.hammer ? 120 : 150, 0.15, 'square', 0.05, e.hammer ? 90 : 110);
          }
        } else if (e.state === 'windup') {
          e.st -= dt; mv = 0;
          e.ring.position.set(e.x, WATER_Y + 0.08, e.z);
          var ringPulse = 1 + Math.sin(elapsed * 18) * 0.25;
          e.ring.scale.set(ringPulse * (e.hammer ? 1.25 : 1), ringPulse * (e.hammer ? 1.25 : 1), 1);
          e.ring.material.opacity = 0.45 + Math.sin(elapsed * 18) * 0.2;
          if (e.st <= 0) { e.state = 'lunge'; e.st = e.hammer ? 0.9 : 0.8; blip(90, 0.3, 'sawtooth', 0.06, 60); }
        } else if (e.state === 'lunge') {
          e.st -= dt; mv = speed * e.speedMul * e.lungeMul;
          ax = e.lx; az = e.lz;
          if (e.st <= 0) { e.state = 'cool'; e.st = e.hammer ? 1.5 : 1.3; e.ring.visible = false; e.nextLunge = 4.5 + Math.random() * 3.5; }
        } else { // cool
          e.st -= dt; mv = speed * e.speedMul * 0.35;
          if (e.st <= 0) e.state = 'cruise';
        }
        var al = Math.hypot(ax, az) || 1;
        if (shield > 0 && dist < 3) { ax = -tx / dist; az = -tz / dist; al = 1; }
        if (mv > 0) moveOnIsland(e, ax / al * mv * dt, az / al * mv * dt, 0.3);
        if (dist < (R.heroSize + R.enemySize) * 0.30) {
          if (shield > 0) { moveOnIsland(e, -tx / dist * 1.2, -tz / dist * 1.2, 0.3); }
          else if (invulnerable <= 0) {
            hearts -= 1;
            invulnerable = 2.2;   // generous mercy window: enough to escape a pack
            hurtFlash = 1; shake = 0.5; combo = 0;
            moveOnIsland(hero, -tx / dist * 2.6, -tz / dist * 2.6, 0.3);
            blip(180, 0.25, 'square', 0.05, 90);
            if (hearts <= 0) { finish('shark'); return; }
          }
        }
      }
      for (var k = pickups.length - 1; k >= 0; k--) {
        var p = pickups[k];
        // Generous but not magnetic: the raft has to be roughly on top of a
        // piece to sweep it up. (`heroSize` alone is the hull's half-width.)
        // The scoop net widens the base reach; the formula itself is unchanged.
        var reach = (R.heroSize * 0.62 + R.pickupSize * 0.85 + magnet) * (hasBuilt('scoopNet') ? 1.5 : 1);
        if (Math.hypot(p.x - hero.x, p.z - hero.z) < reach) {
          scene.remove(p.node);
          pickups.splice(k, 1);
          var gained = p.value || 1;
          if (p.special === 'water') {
            canteen = Math.min(maxWater, canteen + 34);
            addFT('淡水 +34', p.x, p.z, '#9fe0ff', 1.2);
            fanfare([740, 988], 0.09, 'sine', 0.055);
            burst(p.x, floatY(p.x, p.z) + 0.8, p.z);
          } else if (p.special === 'food') {
            food = Math.min(maxFood, food + SURV.foodDropAmount);
            addFT('鱼干 +' + SURV.foodDropAmount, p.x, p.z, '#c8f0b0', 1.2);
            fanfare([620, 880], 0.09, 'sine', 0.055);
            burst(p.x, floatY(p.x, p.z) + 0.8, p.z);
          } else if (p.special === 'ring') {
            hearts = Math.min(R.hearts, hearts + 1);
            addFT('+1 ♥ 救生圈', p.x, p.z, '#ff9fb0');
            fanfare([587, 880], 0.1, 'sine', 0.06);
          } else if (p.special === 'chest') {
            gained = 3;
            shield = Math.max(shield, R.shield.seconds);
            addFT('宝箱！+3 护盾', p.x, p.z, '#ffd166', 1.3);
            fanfare([659, 784, 1047], 0.1, 'triangle', 0.06);
            burst(p.x, floatY(p.x, p.z) + 1, p.z);
          } else {
            combo = (elapsed - lastPick <= R.comboWindow) ? combo + 1 : 1;
            comboShowT = 2;
            if (combo >= 2) addFT('连击 x' + combo, p.x, p.z, '#ffc463');
            blip(760 + Math.min(8, combo) * 55, 0.1, 'triangle', 0.06, 1100 + combo * 80);
            // Ledger for the end-of-round breakdown, and the materials it yields.
            if (tally[p.name] === undefined) tally[p.name] = 0;
            tally[p.name] += 1;
            pieces += 1;
            if (p.res) {
              for (var rk in p.res) res[rk] += p.res[rk] * (p.mult || 1);
            }
            var resTag = [];
            if (p.res) {
              if (p.res.wood) resTag.push('木+' + p.res.wood * (p.mult || 1));
              if (p.res.plastic) resTag.push('塑+' + p.res.plastic * (p.mult || 1));
              if (p.res.metal) resTag.push('铁+' + p.res.metal * (p.mult || 1));
            }
            addFT(p.name + ' ' + (resTag.join(' ') || ''), p.x, p.z, p.glowColor, 1.1);
          }
          lastPick = elapsed;
          score += gained + (p.special ? 0 : tradeBonus);
          if (gained === 1) addFT('+1', p.x, p.z, '#bff0ff', 0.8);
          burst(p.x, floatY(p.x, p.z) + R.pickupSize * 0.6, p.z);
          post({ type: 'state', phase: phase, score: score });
          if (R.shield.enabled && R.shield.every > 0 && ++sinceShield >= R.shield.every) {
            sinceShield = 0;
            shield = R.shield.seconds;
            blip(440, 0.35, 'sine', 0.06, 1100);
          }
          // Materials in hand: offer a blueprint when the stockpile can cover one.
          // The town only opens up once the survival layer is self-sustaining
          // (design doc: survival gear ships before the town, or the player is
          // pulled two ways before they can even stand).
          if (!buildOffer && townReady && nextBuild < BUILDING_SPECS.length && canAfford(BUILDING_SPECS[nextBuild])) offerBuild();
        }
      }
      while (pickups.length < R.maxPickups) addPickup();
      if (timeLeft <= 0) finish(townCount() >= 4 ? 'partial' : 'timeout');
    }

    // Animate everything, also behind the cards.
    var t = now / 1000;
    hero.y = lerp(hero.y, floatY(hero.x, hero.z), Math.min(1, dt * 14));
    var moving = Math.hypot(hero.vx, hero.vz) > 0.5 && phase === 'playing';
    var heroBody = hero.node.userData.body;
    if (!heroBody.userData.sprite) heroBody.scale.setScalar(BASE_HERO_SCALE * (hero.dashT > 0 ? 1 + Math.sin(t * 40) * 0.08 : 1));
    hero.node.position.set(hero.x, hero.y + (moving ? Math.abs(Math.sin(t * 12)) * 0.12 : Math.sin(t * 2.4) * 0.03), hero.z);
    if (heroBody.userData.sprite) heroBody.material.rotation = moving ? Math.sin(t * 12) * 0.06 : 0;
    else heroBody.rotation.y = lerp(heroBody.rotation.y, hero.facing, Math.min(1, dt * 10));
    hero.node.visible = invulnerable <= 0 || Math.floor(t * 12) % 2 === 0;
    bubble.visible = shield > 0;
    bubble.material.opacity = 0.16 + Math.sin(t * 8) * 0.06;

    for (var m = 0; m < enemies.length; m++) {
      var en = enemies[m], body = en.node.userData.body;
      en.y = lerp(en.y, floatY(en.x, en.z), Math.min(1, dt * 10));
      en.node.position.set(en.x, en.y + Math.abs(Math.sin(t * 6 + en.wobble)) * 0.1, en.z);
      if (!body.userData.sprite) {
        var face = en.state === 'lunge' ? Math.atan2(en.lx, en.lz) : Math.atan2(hero.x - en.x, hero.z - en.z);
        body.rotation.y = face + Math.sin(t * 5 + en.wobble) * 0.12;
      }
    }
    for (var n = 0; n < pickups.length; n++) {
      var pk = pickups[n], pb = pk.node.userData.body;
      pk.x += Math.sin(t * 0.22 + pk.drift) * 0.4 * dt; // the current carries everything along
      pk.z += Math.cos(t * 0.19 + pk.drift) * 0.4 * dt;
      pk.node.position.set(pk.x, floatY(pk.x, pk.z) + 0.1 + Math.sin(t * 2.6 + pk.phase) * 0.14, pk.z);
      if (!pb.userData.sprite) pb.rotation.y = t * 0.9 + pk.phase;
      var pulse = 1 + Math.sin(t * 4 + pk.phase) * 0.12;
      var glowSize = R.pickupSize * (pk.special ? 3 : 2.4) * pulse;
      pk.glow.scale.set(glowSize, glowSize, 1);
    }
    for (var q = 0; q < SPARKS; q++) {
      var s = sparks[q];
      if (s.life > 0) {
        s.life -= dt; s.vy -= 9 * dt;
        s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      }
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(t * 3 + q, t * 2, 0);
      dummy.scale.setScalar(s.life > 0 ? 0.16 * Math.min(1, s.life * 2) : 0);
      dummy.updateMatrix();
      sparkMesh.setMatrixAt(q, dummy.matrix);
    }
    sparkMesh.instanceMatrix.needsUpdate = true;
    // Wake foam, pooled like the sparks.
    for (var q2 = 0; q2 < FOAM; q2++) {
      var fm = foam[q2];
      if (fm.life > 0) { fm.life -= dt; fm.x += fm.vx * dt; fm.y += fm.vy * dt; fm.z += fm.vz * dt; }
      dummy.position.set(fm.x, fm.y, fm.z);
      dummy.rotation.set(0, t * 2 + q2, 0);
      dummy.scale.setScalar(fm.life > 0 ? fm.s * Math.min(1, fm.life * 3) : 0);
      dummy.updateMatrix();
      foamMesh.setMatrixAt(q2, dummy.matrix);
    }
    foamMesh.instanceMatrix.needsUpdate = true;
    // New buildings spring up with a bounce; the windmill's sails turn.
    for (var bl = 0; bl < buildings.length; bl++) {
      var bd = buildings[bl];
      if (bd.userData.pop < 1) {
        bd.userData.pop = Math.min(1, bd.userData.pop + dt * 1.6);
        var c1 = 1.70158, u = bd.userData.pop - 1;
        bd.scale.setScalar(Math.max(0.01, BUILDING_SCALE * (1 + (c1 + 1) * u * u * u + c1 * u * u)));
      }
      if (bd.userData.blades) bd.userData.blades.rotation.z = t * 1.1;
    }
    // Floating pickup texts rise and fade.
    for (var fti = floatingTexts.length - 1; fti >= 0; fti--) {
      floatingTexts[fti].life -= dt;
      if (floatingTexts[fti].life <= 0) floatingTexts.splice(fti, 1);
    }
    shake = Math.max(0, shake - dt * 1.4);
    hurtFlash = Math.max(0, hurtFlash - dt * 2.2);
    comboShowT = Math.max(0, comboShowT - dt);
    // Clouds drift slowly across the sky.
    for (var cd2 = 0; cd2 < clouds.length; cd2++) {
      clouds[cd2].position.x += dt * 0.55;
      if (clouds[cd2].position.x > 80) clouds[cd2].position.x = -80;
    }
    for (var gu = 0; gu < gulls.length; gu++) {
      var gy = gulls[gu];
      gy.a += dt * gy.speed;
      gy.node.position.set(Math.cos(gy.a) * gy.r, gy.y + Math.sin(t * 2 + gu) * 0.4, Math.sin(gy.a) * gy.r);
      gy.node.rotation.y = -gy.a;
    }
    var fp = flyGeo.attributes.position;
    for (var w = 0; w < FLY_COUNT; w++) {
      var b = w * 4;
      fp.setXYZ(w, flyBase[b] + Math.sin(t * 0.4 + flyBase[b + 3]) * 1.6, flyBase[b + 1] + Math.sin(t * 1.1 + flyBase[b + 3]) * 0.5, flyBase[b + 2] + Math.cos(t * 0.35 + flyBase[b + 3]) * 1.6);
    }
    fp.needsUpdate = true;
    // Fish schools: little fish circling under the surface.
    for (var fi = 0; fi < fish.length; fi++) {
      var fh = fish[fi];
      fh.a += dt * fh.speed;
      fh.node.position.set(fh.cx + Math.cos(fh.a) * fh.r, WATER_Y - 0.5 + Math.sin(t * 1.6 + fh.a) * 0.05, fh.cz + Math.sin(fh.a) * fh.r);
      fh.node.rotation.y = -fh.a + Math.PI / 2;
      fh.node.rotation.z = Math.sin(t * 6 + fh.a) * 0.22; // tail flick
    }
    moveZoneTracking(t);
    // Rolling waves: displace the water plane's vertices every frame.
    var wp = waterGeo.attributes.position;
    for (var v = 0; v < wp.count; v++) {
      var bx3 = waterBase[v * 3], bz3 = waterBase[v * 3 + 2];
      wp.setY(v, Math.sin(bx3 * 0.3 + t * 1.7) * 0.11 + Math.cos(bz3 * 0.26 + t * 1.35) * 0.09);
    }
    wp.needsUpdate = true;
    waterGeo.computeVertexNormals();
    water.material.color.set(R.palette.water).multiplyScalar(0.94 + Math.sin(t * 0.8) * 0.04);
    // The raft rides the swell: bob and tilt with the water it sits on.
    var swell = Math.sin(hero.x * 0.3 + t * 1.7) * 0.11 + Math.cos(hero.z * 0.26 + t * 1.35) * 0.09;
    hero.node.position.y += swell;
    hero.node.rotation.z = Math.sin(t * 1.3 + hero.x * 0.2) * 0.045;
    hero.node.rotation.x = Math.cos(t * 1.1 + hero.z * 0.2) * 0.045;
    // Day wears on: the sky warms and dims as the round nears its end.
    if (phase === 'playing') {
      var prog = clamp(elapsed / R.duration, 0, 1);
      var warm = smooth(clamp((prog - 0.35) / 0.65, 0, 1));
      canvas.style.background = 'linear-gradient(to bottom,'
        + mixHex('#79c4ef', '#e8945c', warm) + ' 0%,'
        + mixHex('#79c4ef', '#d97a55', warm) + ' 18%,'
        + mixHex('#ffedc4', '#f2a86a', warm) + ' 100%)';
      sun.color.set(mixHex('#ffe9c0', '#ff9a5a', warm));
      sun.intensity = 2.2 - warm * 0.7;
      scene.fog.color.set(mixHex('#cfeaf2', '#efc0a0', warm));
    }
  }

  /** Linear blend between two #rrggbb colours, t in 0..1. */
  function mixHex(a, b, t) {
    var ca = parseInt(a.slice(1), 16), cb = parseInt(b.slice(1), 16);
    var r = Math.round(((ca >> 16) & 255) + ((((cb >> 16) & 255) - ((ca >> 16) & 255)) * t));
    var g = Math.round(((ca >> 8) & 255) + ((((cb >> 8) & 255) - ((ca >> 8) & 255)) * t));
    var bl = Math.round((ca & 255) + (((cb & 255) - (ca & 255)) * t));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }

  /* 11. CAMERA — a fixed angle that follows the hero; portrait screens pull back. */
  var PITCH = 47 * Math.PI / 180;
  var focus = new THREE.Vector3(0, floatY(0, 0), 0);
  function cameraDistance() {
    var aspect = camera.aspect;
    return aspect >= 1 ? 22 : 22 + (1 - aspect) * 26;
  }
  function placeCamera(dt) {
    // Follow the hero all the way to the shore; narrow portrait screens would otherwise lose it.
    focus.x = lerp(focus.x, hero.x, Math.min(1, dt * 5));
    focus.z = lerp(focus.z, hero.z, Math.min(1, dt * 5));
    focus.y = lerp(focus.y, hero.y, Math.min(1, dt * 4));
    var distance = cameraDistance();
    // Once the round ends, bias the view down so the finished town is not behind the card.
    var lift = phase === 'playing' ? 0.6 : -2.6;
    camera.position.set(focus.x, focus.y + Math.sin(PITCH) * distance, focus.z + Math.cos(PITCH) * distance);
    if (shake > 0) {
      camera.position.x += (Math.random() - 0.5) * shake * 0.9;
      camera.position.y += (Math.random() - 0.5) * shake * 0.6;
      camera.position.z += (Math.random() - 0.5) * shake * 0.9;
    }
    camera.lookAt(focus.x, focus.y + lift, focus.z);
    scene.fog.near = distance * 1.05;
    scene.fog.far = distance * 2.4;
    sun.position.set(focus.x - 18, focus.y + 15, focus.z + 8);
    sun.target.position.copy(focus);
    moon.position.set(camera.position.x + 55, camera.position.y + 48, camera.position.z - 150);
    stars.position.set(camera.position.x, 0, camera.position.z);
  }

  function resize() {
    var width = window.innerWidth || 1, heightPx = window.innerHeight || 1;
    renderer.setSize(width, heightPx, false);
    camera.aspect = width / heightPx;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  /* 12. LOOP */
  var last = performance.now();
  function frame(now) {
    var dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    if (dt > 0) fps = lerp(fps, 1 / dt, 0.05);
    try {
      update(dt, now);
      placeCamera(dt);
      drawHUD();
      hudTexture.needsUpdate = true;
      renderer.clear();
      renderer.render(scene, camera);
      renderer.clearDepth();
      renderer.render(hudScene, hudCam);
    } catch (error) {
      reportError(error && error.message || error);
      throw error;
    }
    requestAnimationFrame(frame);
  }
  setPhase('title');
  requestAnimationFrame(frame);

  /** Whether the hero is inside the visible frame, for the template's own checks. */
  function heroOnScreen() {
    var v = new THREE.Vector3(hero.x, hero.y + R.heroSize * 0.5, hero.z).project(camera);
    return Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
  }

  /* 12b. CHARACTER RENDERS — a transparent close-up of every code-drawn character,
   * for the studio's asset thumbnails and playtest reports. Slots holding the
   * user's own art are skipped: their file already shows how they look. */
  var renderer3 = null;
  function renderSlots(size) {
    size = size || 256;
    if (!renderer3) {
      var c = document.createElement('canvas');
      renderer3 = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer3.setClearColor(0x000000, 0);
      renderer3.toneMapping = renderer.toneMapping;
      renderer3.toneMappingExposure = renderer.toneMappingExposure;
    }
    renderer3.setPixelRatio(1);
    renderer3.setSize(size, size, false);
    var out = {};
    Object.keys(MODELS).forEach(function (slot) {
      if (!SLOTS[slot] || customArt(slot)) return; // dropped slots and the user's own art are skipped
      var stage = new THREE.Scene();
      stage.add(new THREE.HemisphereLight('#c9d2ff', '#5b4434', 1.6));
      var key = new THREE.DirectionalLight('#ffe2c4', 2.2);
      key.position.set(-3, 5, 4);
      stage.add(key);
      var model = voxelModel(MODELS[slot]);
      stage.add(model);
      var box = new THREE.Box3().setFromObject(model), center = box.getCenter(new THREE.Vector3()), extent = box.getSize(new THREE.Vector3());
      var cam = new THREE.PerspectiveCamera(30, 1, 0.1, 500);
      var distance = Math.max(extent.x, extent.y, extent.z) / (2 * Math.tan(15 * Math.PI / 180)) * 1.25;
      cam.position.copy(center).add(new THREE.Vector3(0.55, 0.45, 1).normalize().multiplyScalar(distance));
      cam.lookAt(center);
      renderer3.render(stage, cam);
      out[slot] = renderer3.domElement.toDataURL('image/png');
      model.traverse(function (node) { if (node.geometry) node.geometry.dispose(); if (node.material) node.material.dispose(); });
    });
    return out;
  }
  window.__renderSlots = renderSlots;
  // Tell the studio sidebar how the characters look in this build.
  setTimeout(function () {
    if (!parentWindow) return;
    try { post({ type: 'renders', renders: renderSlots(256) }); } catch (error) { reportError('character renders failed: ' + (error && error.message || error)); }
  }, 400);

  /* 13. STATE — read by the studio's checks and preview; x is world x, y is world z. */
  window.__gameState = function () {
    return {
      phase: phase, paused: paused, score: score, best: best, target: R.target,
      buildings: buildings.length, town: townCount(), townTarget: townTarget(), combo: combo, dashCd: Math.round(hero.dashCd * 100) / 100,
      time: Math.round(timeLeft * 100) / 100, hearts: hearts, shield: Math.round(shield * 100) / 100,
      water: Math.round(canteen), maxWater: maxWater, pop: pop,
      food: Math.round(food), maxFood: maxFood, hungerOn: hasBuilt('fishBasket'),
      survival: survival.slice(), next: (nextSurvivalStep() || {}).id || null,
      selfSustain: Math.round(selfSustainT * 10) / 10, townReady: townReady, buildOpen: buildOpen,
      offer: buildOffer ? buildOffer.map(function (i) { return BUILDING_SPECS[i].name; }) : null,
      zone: { x: Math.round(zone.x * 100) / 100, z: Math.round(zone.z * 100) / 100, r: zone.r },
      hero: { x: Math.round(hero.x * 100) / 100, y: Math.round(hero.z * 100) / 100 },
      pickups: pickups.map(function (p) { return { x: p.x, y: p.z, kind: p.name }; }),
      enemies: enemies.map(function (e) { return { x: Math.round(e.x * 100) / 100, y: Math.round(e.z * 100) / 100 }; }),
      fps: Math.round(fps), renderer: 'webgl', heroMode: heroMode, world: { size: N }, heroOnScreen: heroOnScreen()
    };
  };

  /* Playtest autopilot: answer blueprint choices and drive the survival chain,
   * so an unattended playtest shows the whole stage-0 → stage-1 loop. Steering
   * is left to the harness (it heads for the nearest pickup). Players never
   * reach this. Two entry points: __autoplay (what the harness calls) and
   * __survivalAutoplay (the same thing, under the name the task asked for). */
  function survivalAutoplay() {
    if (phase !== 'playing') return;
    // A town blueprint card is up: pick the best affordable one.
    if (buildOffer) {
      var bestIdx = 0, bestScore = -1;
      for (var i = 0; i < buildOffer.length; i++) {
        var sp = BUILDING_SPECS[buildOffer[i]];
        if (!canAfford(sp)) continue;
        var s2 = sp.pop * 2 + (sp.perk === 'maxHearts' ? 3 : 0) + (sp.perk === 'water' ? 3 : 0);
        if (s2 > bestScore) { bestScore = s2; bestIdx = i; }
      }
      pickBuild(bestIdx);
      return;
    }
    // Build the next survival step as soon as it is affordable — the chain,
    // not the clock, is what the playtest is meant to prove out.
    var step = nextSurvivalStep();
    if (step && canAffordCost(stepCost(step))) buildNextSurvival();
  }
  window.__autoplay = survivalAutoplay;
  window.__survivalAutoplay = survivalAutoplay;
  /** The playtest autopilot steers toward the nearest safe pickup, ignoring the
   *  patrolled deep-water zone so it survives long enough to show the loop. */
  window.__pickupFilter = function (p) { return !inZone(p.x, p.z); };
})();
