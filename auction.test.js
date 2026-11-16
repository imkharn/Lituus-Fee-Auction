'use strict';

var assert = require('assert');
var A = require('./auction.js');

var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('ok  ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

function toyInput(over) {
  var base = {
    C: A.PRESETS.toy.C,
    h: A.PRESETS.toy.h,
    k: A.PRESETS.toy.k,
    knots: A.cloneKnots(A.PRESETS.toy.knots)
  };
  if (!over) return base;
  Object.keys(over).forEach(function (key) { base[key] = over[key]; });
  if (over.knots) base.knots = over.knots;
  return base;
}

test('toy full shade selects Half at $20 with the writeup revenues', function () {
  var model = A.evaluate(toyInput());
  assert.strictEqual(model.ok, true);
  assert.strictEqual(model.winner.id, 'half');
  assert.strictEqual(model.winner.price, 20);
  var revenue = model.arms.map(function (arm) { return arm.revenue; });
  assert.ok(Math.abs(revenue[0] - 16000) < 0.01, 'half ' + revenue[0]);
  assert.ok(Math.abs(revenue[1] - 13200) < 80, 'near-low ' + revenue[1]);
  assert.ok(revenue[1] > 13100 && revenue[1] < 13300, revenue[1]);
  assert.ok(Math.abs(revenue[2] - 12400) < 80, 'near-high ' + revenue[2]);
  assert.ok(revenue[2] > 12300 && revenue[2] < 12500, revenue[2]);
  assert.ok(Math.abs(revenue[3] - 10240) < 0.01, 'double ' + revenue[3]);
  console.log('    revenues ' + revenue.map(function (n) { return n.toFixed(2); }).join(' / '));
});

test('toy optimum is the $40 knot and the center is already there', function () {
  var model = A.evaluate(toyInput());
  assert.ok(Math.abs(model.pStar.price - 40) < 1e-9, model.pStar.price);
  assert.ok(Math.abs(model.pStar.burn - 20000) < 1e-6, model.pStar.burn);
  assert.ok(Math.abs(model.distanceCurrent) < 1e-9);
  assert.strictEqual(A.isCloser(model.winner.price, model.C, model.pStar.price), false);
});

test('toy h* is the honest share where the fully honest winner takes the lead', function () {
  var model = A.evaluate(toyInput());
  var honest = A.evaluate(toyInput({ h: 1 }));
  assert.ok(model.flip, 'expected the winner to change');
  assert.strictEqual(model.flip.id, 'nearLow');
  assert.ok(model.flip.h > 0.42 && model.flip.h < 0.48, 'flip ' + model.flip.h);
  assert.strictEqual(model.hStar, model.flip.h);
  assert.strictEqual(model.bestBluff.armId, 'nearLow');
  assert.strictEqual(model.hBluff, 0);
  assert.strictEqual(model.hBluffPick.id, 'nearLow');
  assert.strictEqual(model.hStarPick.id, honest.winner.id);
  assert.strictEqual(model.hStarPick.id, 'nearLow');
  console.log('    h* ' + model.hStar + ' (price that wins when every bidder is honest)');
  var before = A.evaluate(toyInput({ h: 0.42 }));
  var after = A.evaluate(toyInput({ h: model.hStar }));
  assert.strictEqual(before.winner.id, 'half');
  assert.strictEqual(after.winner.id, 'nearLow');
  assert.notStrictEqual(before.winner.id, model.hStarPick.id);
});

test('cheapest arm revenue does not depend on the honest share', function () {
  [0, 0.25, 0.5, 0.9, 1].forEach(function (h) {
    var model = A.evaluate(toyInput({ h: h }));
    assert.ok(Math.abs(model.arms[0].revenue - 16000) < 1e-6, h + ' ' + model.arms[0].revenue);
  });
});

test('full honesty ties Near-low and Near-high and keeps the arm closer to the center', function () {
  var model = A.evaluate(toyInput({ h: 1 }));
  assert.ok(Math.abs(model.arms[1].revenue - model.arms[2].revenue) < 1e-6);
  assert.strictEqual(model.winner.id, 'nearLow');
});

test('bluff on the $36 arm resells at the optimal fee, not above it', function () {
  var model = A.evaluate(toyInput());
  var quote = model.quotes.find(function (row) { return row.armId === 'nearLow'; });
  assert.ok(quote.delta > 77 && quote.delta < 83, 'delta ' + quote.delta);
  assert.ok(quote.quantity > quote.delta + 50, 'quantity ' + quote.quantity);
  assert.ok(Math.abs(quote.quantity - quote.leftover) < 1e-6, quote.quantity);
  assert.ok(Math.abs(quote.sold - quote.quantity) < 1e-6, quote.sold);
  assert.ok(Math.abs(quote.leftover - 137.03) < 0.1, quote.leftover);
  assert.ok(quote.spend > 4500 && quote.spend < 5500, 'spend ' + quote.spend);
  assert.strictEqual(quote.sellPrice, model.pStar.price);
  assert.ok(quote.profit > (quote.sellPrice - quote.price) * quote.delta, 'profit ' + quote.profit);
  assert.ok(Math.abs(quote.roi - 0.1) < 1e-9, 'roi ' + quote.roi);
  assert.strictEqual(quote.rational, true);
  assert.strictEqual(model.bestBluff.armId, 'nearLow');
  model.quotes.forEach(function (row) {
    if (row.price > model.pStar.price + 1e-9) assert.ok(row.profit <= 0, row.armId + ' ' + row.profit);
  });
  console.log('    delta ' + quote.delta.toFixed(2) + ' quantity ' + quote.quantity.toFixed(2) + ' spend ' + quote.spend.toFixed(2) + ' profit ' + quote.profit.toFixed(2));
});

test('a caller who can sell more than the minimum bid buys the extra tokens', function () {
  var knots = [
    { price: 4, qty: 2800 }, { price: 7, qty: 1750 }, { price: 14, qty: 1090 },
    { price: 28, qty: 630 }, { price: 42, qty: 440 }, { price: 56, qty: 300 },
    { price: 70, qty: 250 }, { price: 112, qty: 150 }, { price: 140, qty: 120 },
    { price: 224, qty: 67 }
  ];
  var model = A.evaluate({ C: 33, h: 0, k: 0.4, knots: knots });
  var quote = model.bestBluff;
  assert.strictEqual(quote.armId, 'nearHigh');
  assert.ok(Math.round(quote.delta) === 98, 'delta ' + quote.delta);
  assert.ok(Math.round(quote.quantity) === 102, 'quantity ' + quote.quantity);
  assert.ok(quote.quantity > quote.delta + 3, quote.quantity);
  assert.strictEqual(quote.sellPrice, model.pStar.price);
  assert.ok(Math.abs(quote.quantity - quote.leftover) < 1e-6, quote.leftover);
  assert.ok(Math.abs(quote.sold - quote.quantity) < 1e-6, quote.sold);
  var minimumProfit = (quote.sellPrice - quote.price) * quote.delta;
  assert.ok(quote.profit > minimumProfit + 20, quote.profit + ' vs ' + minimumProfit);
  console.log('    buy ' + quote.quantity.toFixed(2) + ' instead of ' + quote.delta.toFixed(2) + ' profit ' + quote.profit.toFixed(2));
});

test('a center just above the optimum makes the near-low bluff rational', function () {
  var model = A.evaluate(toyInput({ C: 42 }));
  assert.ok(model.bestBluff, 'expected a rational bluff');
  assert.strictEqual(model.bestBluff.armId, 'nearLow');
  assert.ok(model.bestBluff.price < model.pStar.price);
  assert.ok(model.bestBluff.sellPrice <= model.pStar.price + 1e-9);
  assert.ok(model.bestBluff.profit > 0);
  var applied = A.applyBluff(model, model.bestBluff);
  assert.strictEqual(applied.winner.id, 'nearLow');
});

test('h* is the honest share that reaches the fully honest winner', function () {
  var model = A.evaluate(toyInput({ C: 36 }));
  var honest = A.evaluate(toyInput({ C: 36, h: 1 }));
  assert.ok(model.hStar !== null);
  assert.strictEqual(model.hStarPick.id, honest.winner.id);
  var at = A.evaluate(toyInput({ C: 36, h: model.hStar }));
  assert.strictEqual(at.winner.id, model.hStarPick.id);
  if (model.hStar > 0) {
    var below = A.evaluate(toyInput({ C: 36, h: Math.max(0, model.hStar - 0.001) }));
    assert.notStrictEqual(below.winner.id, model.hStarPick.id);
  }
  console.log('    C=36 h* ' + model.hStar + ' arm ' + model.hStarPick.id);
});

test('a steep curve still has an honesty threshold when the nearest arm never wins', function () {
  var knots = [
    { price: 10, qty: 1000 },
    { price: 30, qty: 800 },
    { price: 40, qty: 700 },
    { price: 50, qty: 50 },
    { price: 100, qty: 10 }
  ];
  var model = A.evaluate({ C: 36, h: 0, k: 0.4, knots: knots });
  var honest = A.evaluate({ C: 36, h: 1, k: 0.4, knots: knots });
  var nearest = model.arms.filter(function (arm) {
    return A.isClosestAvailable(arm.price, model.arms, model.pStar.price);
  })[0];
  assert.notStrictEqual(honest.winner.id, nearest.id);
  assert.strictEqual(model.hStar, 0);
  assert.strictEqual(model.hStarPick.id, honest.winner.id);
  assert.strictEqual(model.hStarPick.id, 'half');
  console.log('    nearest ' + nearest.id + ' never wins; h* is ' + model.hStar + ' ' + model.hStarPick.id);
});

test('k = 0 puts the entire shaded book on the cheapest arm', function () {
  var model = A.evaluate(toyInput({ k: 0 }));
  assert.ok(model.arms[0].shade > 0);
  assert.strictEqual(model.arms[1].shade, 0);
  assert.strictEqual(model.arms[2].shade, 0);
  assert.strictEqual(model.arms[3].shade, 0);
  assert.strictEqual(model.winner.id, 'half');
  assert.strictEqual(model.elasticity, Infinity);
});

test('a tight floor keeps the highest honest bid and caps the lower prices', function () {
  var model = A.evaluate({
    C: 20,
    h: 1,
    k: 0.4,
    knots: [
      { price: 10, qty: 100 },
      { price: 20, qty: 10 }
    ]
  });
  var double = model.arms.find(function (arm) { return arm.id === 'double'; });
  var half = model.arms.find(function (arm) { return arm.id === 'half'; });
  assert.ok(Math.abs(double.honest - double.honestRaw) < 1e-6, double.honest);
  assert.ok(half.honestCapped, 'expected the low price to be capped');
  assert.ok(Math.abs(half.honest - 6.25) < 0.05, half.honest);
  assert.ok(half.honest < half.honestRaw);
  model.arms.forEach(function (arm) {
    assert.ok(arm.honest <= arm.honestRaw + 1e-6, arm.id);
  });
  assert.strictEqual(model.floorWarning, true);
});

test('zero demand ties break toward the arm closer to the center', function () {
  var model = A.evaluate({
    C: 40,
    h: 0,
    k: 0.4,
    knots: [
      { price: 10, qty: 0 },
      { price: 80, qty: 0 }
    ]
  });
  assert.ok(model.arms.every(function (arm) { return arm.revenue === 0; }));
  assert.strictEqual(model.winner.id, 'nearLow');
});

test('outside the end prices the curve continues the end segment', function () {
  var knots = A.cloneKnots(A.PRESETS.toy.knots);
  /* Low end is inelastic, so exterior continuation uses unit elasticity from $10. */
  assert.ok(Math.abs(A.demandAt(knots, 5) - 2000) < 1e-6, A.demandAt(knots, 5));
  assert.ok(Math.abs(A.demandAt(knots, 160) - 80) < 1e-6, A.demandAt(knots, 160));
  assert.ok(Math.abs(A.demandAt(knots, 20) - 800) < 1e-9);
  assert.ok(Math.abs(A.demandAt(knots, 40) - 500) < 1e-9);
  var mid = A.demandAt(knots, 40 / 1.1);
  assert.ok(mid < 800 && mid > 500, mid);
});

test('an inelastic high end does not push the optimal fee to the search boundary', function () {
  var knots = [
    { price: 4, qty: 2800 },
    { price: 42, qty: 440 },
    { price: 224, qty: 67 },
    { price: 336, qty: 55 },
    { price: 504, qty: 50 }
  ];
  var pStar = A.optimalFee(knots);
  assert.ok(pStar.price <= 504 + 1e-6, pStar.price);
  assert.ok(pStar.price < 504 * 8, pStar.price);
});

test('creator fee scales the optimal query fee and a quantity scale would not', function () {
  var full = A.evaluate(toyInput({ creatorFee: 0.01 }));
  var half = A.evaluate(toyInput({ creatorFee: 0.005 }));
  var doubled = A.evaluate(toyInput({ creatorFee: 0.02 }));
  assert.ok(Math.abs(full.pStar.price - 40) < 1e-6, full.pStar.price);
  assert.ok(Math.abs(half.pStar.price - 20) < 1e-6, half.pStar.price);
  assert.ok(Math.abs(doubled.pStar.price - 80) < 1e-6, doubled.pStar.price);
  var scaledQty = A.cloneKnots(A.PRESETS.toy.knots).map(function (knot) {
    return { price: knot.price, qty: knot.qty * 0.25 };
  });
  var shrunk = A.evaluate(toyInput({ knots: scaledQty }));
  assert.ok(Math.abs(shrunk.pStar.price - 40) < 1e-6, shrunk.pStar.price);
});

test('normalize sorts by price and clamps rising quantities', function () {
  var result = A.normalizeKnots([
    { price: 40, qty: 10 },
    { price: 10, qty: 5 },
    { price: 20, qty: 100 }
  ]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.clamped, true);
  assert.deepStrictEqual(result.knots, [
    { price: 10, qty: 5 },
    { price: 20, qty: 5 },
    { price: 40, qty: 5 }
  ]);
  var duplicate = A.normalizeKnots([
    { price: 10, qty: 2 },
    { price: 10, qty: 1 }
  ]);
  assert.strictEqual(duplicate.ok, false);
  var negative = A.normalizeKnots([
    { price: 10, qty: -4 },
    { price: 20, qty: 3 }
  ]);
  assert.strictEqual(negative.ok, true);
  assert.strictEqual(negative.negative, true);
  assert.deepStrictEqual(negative.knots, [
    { price: 10, qty: 0 },
    { price: 20, qty: 0 }
  ]);
});

test('Polymarket curve peaks at $600 when the creator fee is 1%', function () {
  var preset = A.PRESETS.polymarket;
  var model = A.evaluate({
    C: 800,
    h: 0,
    k: preset.k,
    creatorFee: 0.01,
    knots: A.cloneKnots(preset.knots)
  });
  assert.ok(Math.abs(model.pStar.price - 600) < 1e-6, model.pStar.price);
  assert.ok(Math.abs(model.pStar.burn - 2640000) < 1e-4, model.pStar.burn);
  assert.strictEqual(model.winner.id, 'half');
  assert.strictEqual(model.winner.price, 400);
  assert.ok(model.knots.length >= 10);
  for (var i = 1; i < model.knots.length; i++) {
    assert.ok(model.knots[i].qty <= model.knots[i - 1].qty);
    assert.ok(model.knots[i].price > model.knots[i - 1].price);
  }
  console.log('    polymarket p* ' + model.pStar.price + ' burn ' + model.pStar.burn);
});

test('a 0.07% creator fee moves the Polymarket peak to about $42', function () {
  var model = A.evaluate({
    C: 40,
    h: 0.5,
    k: 0.4,
    creatorFee: 0.0007,
    knots: A.cloneKnots(A.PRESETS.polymarket.knots)
  });
  assert.ok(Math.abs(model.pStar.price - 42) < 1e-6, model.pStar.price);
  var halved = A.evaluate({
    C: 40,
    h: 0.5,
    k: 0.4,
    creatorFee: 0.0007,
    knots: A.cloneKnots(A.PRESETS.polymarket.knots).map(function (knot) {
      return { price: knot.price, qty: knot.qty * 0.5 };
    })
  });
  assert.ok(Math.abs(halved.pStar.price - model.pStar.price) < 1e-6);
});

if (failed) {
  console.error(failed + ' failed, ' + passed + ' passed');
  process.exit(1);
}
console.log(passed + ' passed');
