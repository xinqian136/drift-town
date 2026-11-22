/* Auto-generated WeChat WASubContext sandbox bridge — edit root game.js instead */
var __wxRoot = (typeof GameGlobal !== "undefined") ? GameGlobal : ((typeof globalThis !== "undefined") ? globalThis : this);
var window = __wxRoot.window || __wxRoot;
var self = __wxRoot.self || window;
var document = __wxRoot.document;
var navigator = __wxRoot.navigator;
var performance = __wxRoot.performance;
var localStorage = __wxRoot.__wxStorage;
try { if (!localStorage) localStorage = __wxRoot.localStorage; } catch (_e) {}
var Image = __wxRoot.Image;
var AudioContext = __wxRoot.AudioContext || window.AudioContext;
var webkitAudioContext = __wxRoot.webkitAudioContext || window.webkitAudioContext || AudioContext;
var HTMLCanvasElement = __wxRoot.HTMLCanvasElement;
var FinalizationRegistry = __wxRoot.FinalizationRegistry;
var CustomEvent = __wxRoot.CustomEvent;
var requestAnimationFrame = function (cb) { return (__wxRoot.requestAnimationFrame || window.requestAnimationFrame).call(window, cb); };
var cancelAnimationFrame = function (id) { return (__wxRoot.cancelAnimationFrame || window.cancelAnimationFrame).call(window, id); };

window.GAME = Object.assign(window.GAME || {}, {
  "title": "漂流小镇",
  "rules": {
    "duration": 240,
    "hearts": 4,
    "heroSpeed": 8,
    "enemySpeed": 1.6,
    "enemySpeedGrowth": 0.02,
    "enemySpawnEvery": 14,
    "maxEnemies": 2,
    "maxPickups": 16,
    "heroSize": 4.6,
    "enemySize": 1.15,
    "pickupSize": 1.7,
    "shield": {
      "enabled": true,
      "every": 5,
      "seconds": 4
    },
    "target": 26,
    "buildEvery": 5,
    "dash": {
      "cooldown": 3,
      "speed": 15,
      "time": 0.4
    },
    "comboWindow": 5,
    "specialEvery": 10,
    "autoBuild": false,
    "survival": {
      "thirstRate": 1.5,
      "hungerRate": 0.6,
      "starveEvery": 1.6,
      "selfSustainSec": 60,
      "shelterCountsAsTown": true,
      "rainEvery": 8,
      "rainAmount": 8,
      "fishEvery": 10,
      "fishAmount": 6,
      "purifyEvery": 5,
      "purifyAmount": 12,
      "foodDropEvery": 9,
      "foodDropAmount": 26,
      "workbench": {
        "wood": 4,
        "plastic": 0,
        "metal": 0
      },
      "shelter": {
        "wood": 8,
        "plastic": 2,
        "metal": 0
      },
      "rainCatcher": {
        "wood": 3,
        "plastic": 2,
        "metal": 0
      },
      "fishBasket": {
        "wood": 4,
        "plastic": 0,
        "metal": 0
      },
      "scoopNet": {
        "wood": 3,
        "plastic": 0,
        "metal": 0
      },
      "purifier": {
        "wood": 4,
        "plastic": 0,
        "metal": 2
      }
    },
    "worldSize": 34,
    "seed": 7,
    "debugPanel": "",
    "debugGallery": false,
    "palette": {
      "skyTop": "#79c4ef",
      "skyBottom": "#ffedc4",
      "fog": "#cfeaf2",
      "grass": "#7cc46a",
      "dirt": "#a8814f",
      "sand": "#f2e2ae",
      "water": "#2fb9cf",
      "accent": "#ffd166"
    }
  },
  "slots": {
    "hero": {
      "tile": false,
      "custom": false
    },
    "enemy": {
      "tile": false,
      "custom": false
    },
    "pickup": {
      "tile": false,
      "custom": false
    }
  },
  "assets": {}
});
__wxRoot.GAME = window.GAME;
