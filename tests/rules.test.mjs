import assert from "node:assert/strict";
import { identifyPattern, canBeat, findCandidatePlays, __test__ } from "../src/game.js";

const { createDeck } = __test__;
const deck = createDeck();
const byRank = (rank, count = 1) => deck.filter((card) => card.rank === rank).slice(0, count);
const jokers = () => deck.filter((card) => card.rank.includes("王"));

assert.equal(createDeck().length, 54);
assert.equal(new Set(createDeck().map((card) => card.id)).size, 54);

assert.equal(identifyPattern(byRank("7")).type, "single");
assert.equal(identifyPattern(byRank("8", 2)).type, "pair");
assert.equal(identifyPattern(byRank("9", 3)).type, "triple");
assert.equal(identifyPattern(byRank("9", 3).concat(byRank("4"))).type, "triple_single");
assert.equal(identifyPattern(byRank("9", 3).concat(byRank("4", 2))).type, "triple_pair");
assert.equal(identifyPattern(["3", "4", "5", "6", "7"].flatMap((rank) => byRank(rank))).type, "straight");
assert.equal(identifyPattern(["3", "4", "5"].flatMap((rank) => byRank(rank, 2))).type, "consecutive_pairs");
assert.equal(identifyPattern(byRank("3", 3).concat(byRank("4", 3))).type, "airplane");
assert.equal(identifyPattern(byRank("6", 4)).type, "bomb");
assert.equal(identifyPattern(jokers()).type, "rocket");
assert.equal(identifyPattern(["10", "J", "Q", "K", "A", "2"].flatMap((rank) => byRank(rank))).type, "invalid");

const pair8 = identifyPattern(byRank("8", 2));
const pair9 = identifyPattern(byRank("9", 2));
const bomb3 = identifyPattern(byRank("3", 4));
const rocket = identifyPattern(jokers());
assert.equal(canBeat(pair9, pair8), true);
assert.equal(canBeat(pair8, pair9), false);
assert.equal(canBeat(bomb3, pair9), true);
assert.equal(canBeat(rocket, bomb3), true);
assert.equal(canBeat(bomb3, rocket), false);

const hand = byRank("3").concat(byRank("4")).concat(byRank("5")).concat(byRank("6")).concat(byRank("7")).concat(byRank("K", 2));
const candidates = findCandidatePlays(hand, identifyPattern(byRank("Q")));
assert.ok(candidates.some((cards) => cards.length === 1 && cards[0].rank === "K"));

const pairHintHand = byRank("9", 2).concat(byRank("10", 2), byRank("K", 2));
const pairHints = findCandidatePlays(pairHintHand, identifyPattern(byRank("5", 2)));
assert.deepEqual(pairHints[0].map((card) => card.rank), ["9", "9"]);

console.log("rules.test.mjs passed");
