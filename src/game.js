const RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2", "小王", "大王"];
const WEIGHTS = Object.fromEntries(RANKS.map((rank, index) => [rank, index + 3]));
const SUITS = [
  ["spade", "♠", false],
  ["heart", "♥", true],
  ["club", "♣", false],
  ["diamond", "♦", true],
];
const SAVE_KEY = "landlords-prd-game-state-v1";
const AI_DELAY = 650;
const PATTERN_NAMES = {
  pass: "不出",
  single: "单张",
  pair: "对子",
  triple: "三张",
  triple_single: "三带一",
  triple_pair: "三带二",
  straight: "顺子",
  consecutive_pairs: "连对",
  airplane: "飞机",
  airplane_single: "飞机带单",
  airplane_pair: "飞机带对",
  four_two_single: "四带二单",
  four_two_pair: "四带二对",
  bomb: "炸弹",
  rocket: "王炸",
  invalid: "无效",
};

let state = loadState() || createInitialState();
let selectedIds = new Set();
let aiTimer = null;
let countdownTimer = null;
let toastTimer = null;

function createDeck() {
  const deck = [];
  for (const rank of RANKS.slice(0, 13)) {
    for (const [suit, symbol, red] of SUITS) {
      deck.push({
        id: `${suit}_${rank}`,
        rank,
        suit,
        suitSymbol: symbol,
        red,
        weight: WEIGHTS[rank],
        displayName: rank,
      });
    }
  }
  deck.push({ id: "joker_small", rank: "小王", suit: "joker", suitSymbol: "", red: false, weight: WEIGHTS["小王"], displayName: "小王" });
  deck.push({ id: "joker_big", rank: "大王", suit: "joker", suitSymbol: "", red: true, weight: WEIGHTS["大王"], displayName: "大王" });
  return deck;
}

function shuffle(cards) {
  const copy = cards.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function sortCards(cards) {
  return cards.slice().sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}

function createInitialState() {
  const settings = loadSettings();
  return {
    phase: "home",
    difficulty: settings.difficulty,
    theme: settings.theme,
    sound: settings.sound,
    scores: { human: 0, left: 0, right: 0 },
  };
}

function newGame(difficulty = state.difficulty || "normal") {
  const deck = shuffle(createDeck());
  const players = [
    createPlayer("left", "左侧电脑", "ai"),
    createPlayer("human", "你", "human"),
    createPlayer("right", "右侧电脑", "ai"),
  ];
  players[0].handCards = sortCards(deck.slice(0, 17));
  players[1].handCards = sortCards(deck.slice(17, 34));
  players[2].handCards = sortCards(deck.slice(34, 51));
  const firstBidder = Math.floor(Math.random() * 3);
  state = {
    gameId: `game_${Date.now()}`,
    phase: "bidding",
    bidMode: "call",
    difficulty,
    theme: state.theme || "dark",
    sound: Boolean(state.sound),
    players,
    scores: state.scores || { human: 0, left: 0, right: 0 },
    landlordCards: deck.slice(51),
    currentPlayerIndex: firstBidder,
    firstBidder,
    bidTurns: 0,
    calledPlayerIndex: null,
    lastRobberIndex: null,
    robTurns: 0,
    lastPlay: null,
    currentTableCards: [],
    passCount: 0,
    multiplier: 1,
    baseScore: 1,
    bombCount: 0,
    history: [],
    selectedHintIndex: 0,
    playedHandCounts: { human: 0, left: 0, right: 0 },
    message: `${players[firstBidder].name} 先叫地主`,
    countdown: 20,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  selectedIds = new Set();
  persist();
  render();
  scheduleAutomation();
}

function createPlayer(id, name, type) {
  return {
    id,
    name,
    type,
    role: "unknown",
    handCards: [],
    playedCards: [],
    isAutoPlay: false,
    thinking: false,
  };
}

function countByWeight(cards) {
  const map = new Map();
  for (const card of cards) map.set(card.weight, (map.get(card.weight) || 0) + 1);
  return map;
}

function isConsecutive(weights) {
  const sorted = weights.slice().sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] !== sorted[i - 1] + 1) return false;
  }
  return true;
}

function noHighSequence(weights) {
  return weights.every((weight) => weight < WEIGHTS["2"]);
}

export function identifyPattern(cards) {
  const sorted = sortCards(cards);
  const len = sorted.length;
  if (!len) return { type: "pass", name: PATTERN_NAMES.pass, length: 0, mainWeight: 0 };
  const counts = countByWeight(sorted);
  const groups = Array.from(counts.entries()).map(([weight, count]) => ({ weight, count }));
  const countValues = groups.map((group) => group.count).sort((a, b) => b - a);
  const weights = groups.map((group) => group.weight);
  const invalid = { type: "invalid", name: PATTERN_NAMES.invalid, length: len, mainWeight: 0 };

  if (len === 1) return { type: "single", name: PATTERN_NAMES.single, length: len, mainWeight: sorted[0].weight };
  if (len === 2 && weights.includes(WEIGHTS["小王"]) && weights.includes(WEIGHTS["大王"])) return { type: "rocket", name: PATTERN_NAMES.rocket, length: len, mainWeight: WEIGHTS["大王"] };
  if (len === 2 && groups.length === 1) return { type: "pair", name: PATTERN_NAMES.pair, length: len, mainWeight: groups[0].weight };
  if (len === 3 && groups.length === 1) return { type: "triple", name: PATTERN_NAMES.triple, length: len, mainWeight: groups[0].weight };
  if (len === 4 && groups.length === 1) return { type: "bomb", name: PATTERN_NAMES.bomb, length: len, mainWeight: groups[0].weight };
  if (len === 4 && countValues[0] === 3) return { type: "triple_single", name: PATTERN_NAMES.triple_single, length: len, mainWeight: groups.find((g) => g.count === 3).weight };
  if (len === 5 && countValues[0] === 3 && countValues[1] === 2) return { type: "triple_pair", name: PATTERN_NAMES.triple_pair, length: len, mainWeight: groups.find((g) => g.count === 3).weight };
  if (len >= 5 && groups.length === len && noHighSequence(weights) && isConsecutive(weights)) return { type: "straight", name: PATTERN_NAMES.straight, length: len, mainWeight: Math.max(...weights) };
  if (len >= 6 && len % 2 === 0 && groups.every((g) => g.count === 2) && noHighSequence(weights) && isConsecutive(weights)) return { type: "consecutive_pairs", name: PATTERN_NAMES.consecutive_pairs, length: len, mainWeight: Math.max(...weights) };
  const triples = groups.filter((g) => g.count === 3).map((g) => g.weight);
  if (triples.length >= 2 && noHighSequence(triples) && isConsecutive(triples)) {
    if (len === triples.length * 3) return { type: "airplane", name: PATTERN_NAMES.airplane, length: len, mainWeight: Math.max(...triples), chain: triples.length };
    if (len === triples.length * 4 && groups.filter((g) => g.count !== 3).reduce((sum, g) => sum + g.count, 0) === triples.length) return { type: "airplane_single", name: PATTERN_NAMES.airplane_single, length: len, mainWeight: Math.max(...triples), chain: triples.length };
    const pairWings = groups.filter((g) => g.count === 2).length;
    if (len === triples.length * 5 && pairWings === triples.length) return { type: "airplane_pair", name: PATTERN_NAMES.airplane_pair, length: len, mainWeight: Math.max(...triples), chain: triples.length };
  }
  if (len === 6 && countValues[0] === 4) return { type: "four_two_single", name: PATTERN_NAMES.four_two_single, length: len, mainWeight: groups.find((g) => g.count === 4).weight };
  if (len === 8 && countValues[0] === 4 && groups.filter((g) => g.count === 2).length === 2) return { type: "four_two_pair", name: PATTERN_NAMES.four_two_pair, length: len, mainWeight: groups.find((g) => g.count === 4).weight };
  return invalid;
}

export function canBeat(play, target) {
  if (!play || play.type === "invalid" || play.type === "pass") return false;
  if (!target || target.type === "pass") return true;
  if (play.type === "rocket") return target.type !== "rocket";
  if (target.type === "rocket") return false;
  if (play.type === "bomb" && target.type !== "bomb") return true;
  if (play.type !== target.type || play.length !== target.length) return false;
  return play.mainWeight > target.mainWeight;
}

function currentPlayer() {
  return state.players[state.currentPlayerIndex];
}

function nextIndex(index) {
  return (index + 1) % 3;
}

function humanCanAct() {
  return state.phase !== "home" && currentPlayer()?.id === "human" && !currentPlayer().thinking;
}

function handleBid(wants) {
  if (!humanCanAct() || state.phase !== "bidding") return;
  applyBidDecision(state.currentPlayerIndex, wants);
}

function applyBidDecision(playerIndex, wants) {
  const player = state.players[playerIndex];
  if (state.bidMode === "call") {
    state.bidTurns += 1;
    addHistory(player, wants ? "叫地主" : "不叫");
    if (wants) {
      state.calledPlayerIndex = playerIndex;
      state.lastRobberIndex = playerIndex;
      state.bidMode = "rob";
      state.robTurns = 0;
      state.message = `${player.name} 叫地主，其他玩家可抢`;
    }
    if (!wants && state.bidTurns >= 3 && state.calledPlayerIndex == null) {
      state.message = "无人叫地主，重新发牌";
      setTimeout(() => newGame(state.difficulty), 550);
      persist();
      render();
      return;
    }
  } else {
    state.robTurns += 1;
    addHistory(player, wants ? "抢地主" : "不抢");
    if (wants) {
      state.lastRobberIndex = playerIndex;
      state.multiplier *= 2;
      state.message = `${player.name} 抢地主，倍数 x${state.multiplier}`;
    }
  }

  const next = nextIndex(playerIndex);
  const robDone = state.bidMode === "rob" && state.robTurns >= 2;
  if (robDone) {
    confirmLandlord(state.lastRobberIndex ?? state.calledPlayerIndex);
    return;
  }
  state.currentPlayerIndex = next;
  state.countdown = 20;
  state.updatedAt = Date.now();
  persist();
  render();
  scheduleAutomation();
}

function confirmLandlord(index) {
  state.players.forEach((player, playerIndex) => {
    player.role = playerIndex === index ? "landlord" : "farmer";
  });
  const landlord = state.players[index];
  landlord.handCards = sortCards(landlord.handCards.concat(state.landlordCards));
  state.phase = "playing";
  state.currentPlayerIndex = index;
  state.lastPlay = null;
  state.currentTableCards = [];
  state.passCount = 0;
  state.message = `${landlord.name} 成为地主并首出`;
  state.countdown = 30;
  addHistory(landlord, `成为地主，拿到底牌 ${state.landlordCards.map((c) => c.displayName).join(" ")}`);
  persist();
  render();
  scheduleAutomation();
}

function playSelected() {
  if (!humanCanAct() || state.phase !== "playing") return;
  const cards = currentPlayer().handCards.filter((card) => selectedIds.has(card.id));
  const result = validatePlay(cards);
  if (!result.ok) {
    showToast(result.reason);
    return;
  }
  commitPlay(state.currentPlayerIndex, cards, result.pattern);
}

function validatePlay(cards) {
  if (!cards.length) return { ok: false, reason: "请选择要出的牌" };
  const pattern = identifyPattern(cards);
  if (pattern.type === "invalid") return { ok: false, reason: "这组牌不是合法牌型" };
  if (state.lastPlay && !canBeat(pattern, state.lastPlay.pattern)) return { ok: false, reason: `需要用同牌型更大牌，或炸弹/王炸压过 ${state.lastPlay.pattern.name}` };
  return { ok: true, pattern };
}

function passTurn() {
  if (!humanCanAct() || state.phase !== "playing") return;
  if (!state.lastPlay) {
    showToast("本轮首出不能不出");
    return;
  }
  commitPass(state.currentPlayerIndex);
}

function commitPlay(playerIndex, cards, pattern) {
  const player = state.players[playerIndex];
  const ids = new Set(cards.map((card) => card.id));
  player.handCards = player.handCards.filter((card) => !ids.has(card.id));
  player.playedCards = player.playedCards.concat(cards);
  state.playedHandCounts[player.id] += 1;
  state.currentTableCards = cards;
  state.lastPlay = { playerIndex, playerId: player.id, cards, pattern };
  state.passCount = 0;
  selectedIds = new Set();
  if (pattern.type === "bomb" || pattern.type === "rocket") {
    state.multiplier *= 2;
    state.bombCount += 1;
  }
  addHistory(player, `${pattern.name} ${cards.map((card) => card.displayName).join(" ")}`);
  if (player.handCards.length === 0) {
    settle(player);
    return;
  }
  state.currentPlayerIndex = nextIndex(playerIndex);
  state.message = `${state.players[state.currentPlayerIndex].name} 行动`;
  state.countdown = currentPlayer().type === "human" ? 30 : 12;
  persist();
  render();
  scheduleAutomation();
}

function commitPass(playerIndex) {
  const player = state.players[playerIndex];
  state.passCount += 1;
  addHistory(player, "不出");
  selectedIds = new Set();
  if (state.passCount >= 2 && state.lastPlay) {
    state.currentTableCards = [];
    state.currentPlayerIndex = state.lastPlay.playerIndex;
    state.lastPlay = null;
    state.passCount = 0;
    state.message = `${state.players[state.currentPlayerIndex].name} 获得新一轮首出`;
  } else {
    state.currentPlayerIndex = nextIndex(playerIndex);
    state.message = `${state.players[state.currentPlayerIndex].name} 行动`;
  }
  state.countdown = currentPlayer().type === "human" ? 30 : 12;
  persist();
  render();
  scheduleAutomation();
}

function settle(winner) {
  const landlord = state.players.find((player) => player.role === "landlord");
  const winnerRole = winner.role === "landlord" ? "landlord" : "farmer";
  let spring = false;
  if (winnerRole === "landlord") {
    spring = state.players.filter((player) => player.role === "farmer").every((player) => state.playedHandCounts[player.id] === 0);
  } else {
    spring = state.playedHandCounts[landlord.id] <= 1;
  }
  if (spring) state.multiplier *= 2;
  const unit = state.baseScore * state.multiplier;
  const scoreDelta = {};
  for (const player of state.players) {
    if (winnerRole === "landlord") {
      scoreDelta[player.id] = player.role === "landlord" ? 2 * unit : -unit;
    } else {
      scoreDelta[player.id] = player.role === "landlord" ? -2 * unit : unit;
    }
    state.scores[player.id] += scoreDelta[player.id];
  }
  state.phase = "settlement";
  state.winnerRole = winnerRole;
  state.settlement = { winnerId: winner.id, winnerRole, spring, scoreDelta, finalMultiplier: state.multiplier };
  state.message = winnerRole === "landlord" ? "地主胜利" : "农民胜利";
  persist();
  render();
}

function addHistory(player, text) {
  state.history.unshift({
    id: `act_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    playerId: player.id,
    playerName: player.name,
    text,
    at: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  });
  state.history = state.history.slice(0, 24);
}

function aiBidDecision(player) {
  const strength = evaluateHandStrength(player.handCards);
  const base = state.difficulty === "easy" ? 64 : state.difficulty === "hard" ? 50 : 57;
  const randomSlack = state.difficulty === "easy" ? Math.random() * 25 : Math.random() * 12;
  if (state.bidMode === "rob") return strength + randomSlack > base + 7;
  return strength + randomSlack > base;
}

function evaluateHandStrength(cards) {
  const counts = countByWeight(cards);
  let score = 0;
  for (const card of cards) {
    if (card.weight >= WEIGHTS["A"]) score += 4;
    else if (card.weight >= WEIGHTS["J"]) score += 2;
    else score += 0.6;
  }
  for (const [weight, count] of counts) {
    if (count === 4) score += 18;
    if (count === 3) score += 8;
    if (weight >= WEIGHTS["小王"]) score += 8;
  }
  if (counts.has(WEIGHTS["小王"]) && counts.has(WEIGHTS["大王"])) score += 22;
  return score;
}

function aiPlayDecision(player) {
  const candidates = findCandidatePlays(player.handCards, state.lastPlay?.pattern);
  if (!candidates.length) return null;
  if (state.difficulty === "easy") {
    return candidates[Math.floor(Math.random() * Math.min(candidates.length, 5))];
  }
  const scored = candidates.map((candidate) => ({ candidate, score: scoreCandidate(candidate, player) })).sort((a, b) => b.score - a.score);
  return scored[0].candidate;
}

function scoreCandidate(candidate, player) {
  const pattern = identifyPattern(candidate);
  let score = 100 - candidate.length * 2 - pattern.mainWeight * 0.25;
  if (!state.lastPlay && pattern.type !== "single") score += 18;
  if (pattern.type === "bomb" || pattern.type === "rocket") score -= state.difficulty === "hard" && player.handCards.length <= 6 ? -20 : 60;
  if (candidate.length === player.handCards.length) score += 1000;
  if (state.lastPlay && state.players[state.lastPlay.playerIndex].handCards.length <= 3) score += 25;
  return score;
}

export function findCandidatePlays(handCards, targetPattern = null) {
  const cards = sortCards(handCards);
  const byWeight = new Map();
  for (const card of cards) {
    if (!byWeight.has(card.weight)) byWeight.set(card.weight, []);
    byWeight.get(card.weight).push(card);
  }
  const candidates = [];
  const add = (chosen) => {
    const pattern = identifyPattern(chosen);
    if (pattern.type !== "invalid" && canBeat(pattern, targetPattern)) candidates.push(chosen);
  };
  for (const group of byWeight.values()) {
    add(group.slice(0, 1));
    if (group.length >= 2) add(group.slice(0, 2));
    if (group.length >= 3) add(group.slice(0, 3));
    if (group.length === 4) add(group.slice(0, 4));
  }
  const small = cards.filter((card) => card.weight < WEIGHTS["2"]).sort((a, b) => a.weight - b.weight);
  for (let start = 0; start < small.length; start += 1) {
    const unique = [];
    const seen = new Set();
    for (let i = start; i < small.length; i += 1) {
      if (!seen.has(small[i].weight)) {
        unique.push(small[i]);
        seen.add(small[i].weight);
      }
      if (unique.length >= 5) add(unique.slice());
    }
  }
  const triples = Array.from(byWeight.values()).filter((group) => group.length >= 3);
  const singles = cards.filter((card) => byWeight.get(card.weight).length === 1);
  const pairs = Array.from(byWeight.values()).filter((group) => group.length >= 2);
  for (const triple of triples) {
    for (const single of singles) if (single.weight !== triple[0].weight) add(triple.slice(0, 3).concat(single));
    for (const pair of pairs) if (pair[0].weight !== triple[0].weight) add(triple.slice(0, 3).concat(pair.slice(0, 2)));
  }
  const jokers = [byWeight.get(WEIGHTS["小王"])?.[0], byWeight.get(WEIGHTS["大王"])?.[0]].filter(Boolean);
  if (jokers.length === 2) add(jokers);
  return dedupeCandidates(candidates).sort((a, b) => a.length - b.length || identifyPattern(a).mainWeight - identifyPattern(b).mainWeight);
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.map((card) => card.id).sort().join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function suggestCards() {
  if (!humanCanAct() || state.phase !== "playing") return;
  const candidates = findCandidatePlays(currentPlayer().handCards, state.lastPlay?.pattern);
  if (!candidates.length) {
    showToast("没有可压过的牌，可以不出");
    return;
  }
  const choice = candidates[state.selectedHintIndex % candidates.length];
  state.selectedHintIndex += 1;
  selectedIds = new Set(choice.map((card) => card.id));
  render();
}

function toggleCard(cardId) {
  if (!humanCanAct() || state.phase !== "playing") return;
  if (selectedIds.has(cardId)) selectedIds.delete(cardId);
  else selectedIds.add(cardId);
  render();
}

function toggleAutoplay() {
  const human = state.players.find((player) => player.id === "human");
  human.isAutoPlay = !human.isAutoPlay;
  state.message = human.isAutoPlay ? "你已开启托管" : "你已取消托管";
  persist();
  render();
  scheduleAutomation();
}

function scheduleAutomation() {
  clearTimeout(aiTimer);
  clearInterval(countdownTimer);
  if (state.phase !== "bidding" && state.phase !== "playing") return;
  const player = currentPlayer();
  if (!player) return;
  countdownTimer = setInterval(() => {
    if (!state.countdown || state.phase === "settlement") return;
    state.countdown -= 1;
    if (state.countdown <= 0) {
      clearInterval(countdownTimer);
      if (player.type === "human") autoHumanAction();
    }
    render();
  }, 1000);
  if (player.type === "ai" || player.isAutoPlay) {
    player.thinking = true;
    render();
    aiTimer = setTimeout(() => {
      player.thinking = false;
      if (state.phase === "bidding") applyBidDecision(state.currentPlayerIndex, player.type === "human" ? false : aiBidDecision(player));
      else if (state.phase === "playing") {
        const play = player.type === "human" ? findCandidatePlays(player.handCards, state.lastPlay?.pattern)[0] : aiPlayDecision(player);
        if (play) commitPlay(state.currentPlayerIndex, play, identifyPattern(play));
        else commitPass(state.currentPlayerIndex);
      }
    }, player.type === "human" ? 400 : AI_DELAY + Math.random() * 650);
  }
}

function autoHumanAction() {
  if (state.phase === "bidding") applyBidDecision(state.currentPlayerIndex, false);
  else if (state.phase === "playing") {
    const play = findCandidatePlays(currentPlayer().handCards, state.lastPlay?.pattern)[0];
    if (play && !state.lastPlay) commitPlay(state.currentPlayerIndex, play, identifyPattern(play));
    else if (state.lastPlay) commitPass(state.currentPlayerIndex);
    else if (play) commitPlay(state.currentPlayerIndex, play, identifyPattern(play));
  }
}

function persist() {
  state.updatedAt = Date.now();
  localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  localStorage.setItem("landlords-settings-v1", JSON.stringify({ difficulty: state.difficulty, theme: state.theme, sound: state.sound }));
}

function loadState() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return saved.phase === "settlement" ? null : saved;
  } catch {
    return null;
  }
}

function loadSettings() {
  try {
    return { difficulty: "normal", theme: "dark", sound: false, ...JSON.parse(localStorage.getItem("landlords-settings-v1") || "{}") };
  } catch {
    return { difficulty: "normal", theme: "dark", sound: false };
  }
}

function clearSave() {
  localStorage.removeItem(SAVE_KEY);
  state = createInitialState();
  render();
}

function renderCard(card, options = {}) {
  const tag = options.static || options.back ? "div" : "button";
  const classes = [
    "card",
    card?.red ? "red" : "",
    selectedIds.has(card?.id) ? "selected" : "",
    options.small ? "small" : "",
    options.back ? "back" : "",
    card?.suit === "joker" ? "joker" : "",
  ].filter(Boolean).join(" ");
  if (options.back) {
    return `<div class="${classes}" aria-label="牌背"><span class="back-mark">DDZ</span></div>`;
  }
  const attrs = tag === "button" ? `data-card-id="${card.id}"` : "";
  const suit = card.suitSymbol || (card.rank === "大王" ? "★" : "☆");
  const jokerImage = card.rank === "大王" ? "./assets/cards/joker-big.svg" : "./assets/cards/joker-small.svg";
  const center = card.suit === "joker"
    ? `<img class="joker-art" src="${jokerImage}" alt="${card.displayName}">`
    : `<span class="pip large">${suit}</span><span class="pip ghost">${suit}</span>`;
  return `
    <${tag} class="${classes}" ${attrs} title="${card.displayName}" aria-label="${card.displayName}">
      <span class="corner top"><strong>${card.displayName}</strong><em>${suit}</em></span>
      <span class="card-center">${center}</span>
      <span class="corner bottom"><strong>${card.displayName}</strong><em>${suit}</em></span>
    </${tag}>
  `;
}

function render() {
  document.body.classList.toggle("light", state.theme === "light");
  const app = document.querySelector("#app");
  if (state.phase === "home") {
    app.innerHTML = renderHome();
  } else {
    app.innerHTML = renderTable();
  }
  bindEvents();
}

function renderHome() {
  const hasSave = Boolean(localStorage.getItem(SAVE_KEY));
  return `
    <section class="home">
      <div class="brand">
        <div class="eyebrow">三人单机牌桌</div>
        <h1>斗<span>地主</span></h1>
        <p>完整叫抢地主、压牌、炸弹倍数、春天结算和本地恢复。底部真人玩家对两名电脑，开局后直接进入沉浸式牌桌。</p>
      </div>
      <div class="start-panel">
        <div class="field">
          <label>电脑难度</label>
          <div class="segmented">
            ${["easy", "normal", "hard"].map((level) => `<button class="chip ${state.difficulty === level ? "active" : ""}" data-difficulty="${level}">${difficultyName(level)}</button>`).join("")}
          </div>
        </div>
        <button class="primary wide" data-action="start">开始游戏</button>
        ${hasSave ? '<button class="secondary wide" data-action="resume">恢复未完成对局</button>' : ""}
        <ul class="rule-list">
          <li>牌型覆盖单张、对子、三带、顺子、连对、飞机、四带二、炸弹和王炸。</li>
          <li>刷新后自动保存当前局面，结算后可再来一局。</li>
          <li>提示、倒计时和托管用于降低新手操作成本。</li>
        </ul>
      </div>
    </section>
  `;
}

function renderTable() {
  const human = state.players.find((player) => player.id === "human");
  const left = state.players.find((player) => player.id === "left");
  const right = state.players.find((player) => player.id === "right");
  const current = currentPlayer();
  return `
    <section class="table">
      <header class="topbar">
        <div class="status">
          <span class="pill gold">阶段：${phaseName(state.phase, state.bidMode)}</span>
          <span class="pill">当前：${current?.name || "-"}</span>
          <span class="pill">倍数：x${state.multiplier}</span>
          <span class="pill">倒计时：${state.countdown || "-"}s</span>
        </div>
        <div class="landlord-cards">
          ${state.landlordCards.map((card) => renderCard(card, { small: true, back: state.phase === "bidding" })).join("")}
        </div>
        <div class="settings">
          <button class="icon-button" data-action="theme" title="切换主题">◐</button>
          <button class="danger" data-action="restart">重开</button>
          <button class="secondary" data-action="home">首页</button>
        </div>
      </header>
      <section class="board">
        ${renderPlayer(left)}
        <div class="center">
          <h2>${state.message || "准备开始"}</h2>
          <div class="play-area">
            ${state.currentTableCards.length ? state.currentTableCards.map((card) => renderCard(card, { static: true })).join("") : '<span class="pill empty-table">桌面暂无牌</span>'}
          </div>
          <div class="table-note">${state.lastPlay ? `${state.players[state.lastPlay.playerIndex].name}：${state.lastPlay.pattern.name}` : "新一轮首出"}</div>
        </div>
        ${renderPlayer(right)}
      </section>
      <section class="bottom">
        <div class="hand-zone">
          ${renderPlayerSummary(human)}
          <div class="hand">${human.handCards.map((card) => renderCard(card)).join("")}</div>
        </div>
        <aside>
          ${renderControls()}
          ${renderHistory()}
        </aside>
      </section>
      ${state.phase === "settlement" ? renderSettlement() : ""}
    </section>
  `;
}

function renderPlayer(player) {
  const last = state.history.find((item) => item.playerId === player.id);
  return `
    <div class="player ${currentPlayer()?.id === player.id ? "current" : ""}">
      <div class="player-name"><span class="avatar">${player.name.slice(0, 1)}</span><span>${player.name}</span><span class="role">${roleName(player.role)}</span></div>
      <div class="opponent-stack" aria-label="剩余 ${player.handCards.length} 张">
        <span class="mini-back"></span><span class="mini-back"></span><span class="mini-back"></span>
        <strong>${player.handCards.length}</strong>
      </div>
      <div class="pill">剩余 ${player.handCards.length} 张 ${player.thinking ? '<span class="thinking">思考中</span>' : ""}</div>
      <div class="last-small">${last ? last.text : "尚未行动"}</div>
    </div>
  `;
}

function renderPlayerSummary(player) {
  return `
    <div class="status">
      <span class="pill">${player.name}</span>
      <span class="pill">${roleName(player.role)}</span>
      <span class="pill">剩余 ${player.handCards.length} 张</span>
      <span class="pill">积分 ${state.scores.human}</span>
      ${player.isAutoPlay ? '<span class="pill">托管中</span>' : ""}
    </div>
  `;
}

function renderControls() {
  const isHumanTurn = humanCanAct();
  if (state.phase === "bidding") {
    const call = state.bidMode === "call";
    return `
      <div class="controls">
        <button class="primary" data-action="bid-yes" ${!isHumanTurn ? "disabled" : ""}>${call ? "叫地主" : "抢地主"}</button>
        <button class="secondary" data-action="bid-no" ${!isHumanTurn ? "disabled" : ""}>${call ? "不叫" : "不抢"}</button>
        <button class="secondary" data-action="autoplay">托管</button>
      </div>
    `;
  }
  return `
    <div class="controls">
      <button class="secondary" data-action="hint" ${!isHumanTurn ? "disabled" : ""}>提示</button>
      <button class="primary" data-action="play" ${!isHumanTurn ? "disabled" : ""}>出牌</button>
      <button class="secondary" data-action="pass" ${!isHumanTurn || !state.lastPlay ? "disabled" : ""}>不出</button>
      <button class="secondary wide" data-action="autoplay">${state.players.find((p) => p.id === "human").isAutoPlay ? "取消托管" : "托管"}</button>
    </div>
  `;
}

function renderHistory() {
  return `
    <div class="history">
      <div class="mini-label">出牌记录</div>
      <div class="history-list">
        ${state.history.slice(0, 8).map((item) => `<div class="history-item"><span>${item.playerName}</span><span>${item.text}</span><span>${item.at}</span></div>`).join("") || '<div class="history-item">暂无记录</div>'}
      </div>
    </div>
  `;
}

function renderSettlement() {
  const s = state.settlement;
  const humanWon = (s.winnerRole === "landlord" && state.players.find((p) => p.id === "human").role === "landlord") || (s.winnerRole === "farmer" && state.players.find((p) => p.id === "human").role === "farmer");
  return `
    <div class="modal-backdrop">
      <div class="modal">
        <h2>${humanWon ? "你赢了" : "你输了"}</h2>
        <p>${s.winnerRole === "landlord" ? "地主胜利" : "农民胜利"}，最终倍数 x${s.finalMultiplier}${s.spring ? "，触发春天/反春天" : ""}。</p>
        <div class="score-grid">
          ${state.players.map((player) => `<div class="score-row"><span>${player.name} ${roleName(player.role)}</span><strong>${formatDelta(s.scoreDelta[player.id])}</strong></div>`).join("")}
        </div>
        <div class="segmented">
          <button class="primary" data-action="again">再来一局</button>
          <button class="secondary" data-action="home">返回首页</button>
        </div>
      </div>
    </div>
  `;
}

function bindEvents() {
  document.querySelectorAll("[data-difficulty]").forEach((button) => {
    button.addEventListener("click", () => {
      state.difficulty = button.dataset.difficulty;
      persist();
      render();
    });
  });
  document.querySelectorAll("[data-card-id]").forEach((button) => {
    button.addEventListener("click", () => toggleCard(button.dataset.cardId));
  });
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      if (action === "start" || action === "again" || action === "restart") newGame(state.difficulty);
      if (action === "resume") {
        state = loadState() || state;
        render();
        scheduleAutomation();
      }
      if (action === "home") clearSave();
      if (action === "bid-yes") handleBid(true);
      if (action === "bid-no") handleBid(false);
      if (action === "play") playSelected();
      if (action === "pass") passTurn();
      if (action === "hint") suggestCards();
      if (action === "autoplay") toggleAutoplay();
      if (action === "theme") {
        state.theme = state.theme === "dark" ? "light" : "dark";
        persist();
        render();
      }
    });
  });
}

function showToast(text) {
  clearTimeout(toastTimer);
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toastTimer = setTimeout(() => toast.remove(), 2200);
}

function difficultyName(level) {
  return { easy: "简单", normal: "普通", hard: "困难" }[level] || "普通";
}

function roleName(role) {
  return { landlord: "地主", farmer: "农民", unknown: "待定" }[role] || "待定";
}

function phaseName(phase, bidMode) {
  if (phase === "bidding") return bidMode === "call" ? "叫地主" : "抢地主";
  return { home: "首页", playing: "出牌", settlement: "结算" }[phase] || phase;
}

function formatDelta(value) {
  return value > 0 ? `+${value}` : String(value);
}

if (typeof document !== "undefined") {
  render();
  scheduleAutomation();
}

export const __test__ = { createDeck, sortCards, WEIGHTS };
