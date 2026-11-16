/* One-round fee-report auction.
   Pure functions: no DOM, no I/O. Used by the page and by auction.test.js. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FeeAuction = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var REVENUE_TIE = 1e-4;
  var STRICT_MARGIN = 0.01;
  var GRID_POINTS = 200;
  var HONESTY_STEPS = 1000;
  /* Anchors are the demand at this creator fee. Other fees scale query prices. */
  var REFERENCE_CREATOR_FEE = 0.01;

  var PRESETS = {
    toy: {
      name: 'Toy example',
      C: 40,
      h: 0,
      k: 0.4,
      creatorPercent: 1,
      knots: [
        { price: 10, qty: 1000 },
        { price: 20, qty: 800 },
        { price: 40, qty: 500 },
        { price: 80, qty: 200 }
      ]
    },
    polymarket: {
      name: 'Polymarket-like open interest',
      C: 40,
      h: 0.75,
      k: 0.25,
      creatorPercent: 0.07,
      knots: [
        { price: 50, qty: 28000 },
        { price: 100, qty: 17500 },
        { price: 200, qty: 10900 },
        { price: 400, qty: 6300 },
        { price: 600, qty: 4400 },
        { price: 800, qty: 3000 },
        { price: 1000, qty: 2500 },
        { price: 1600, qty: 1500 },
        { price: 2000, qty: 1200 },
        { price: 3200, qty: 670 }
      ]
    }
  };

  function cloneKnots(knots) {
    return knots.map(function (knot) {
      return { price: knot.price, qty: knot.qty };
    });
  }

  function elasticity(k) {
    if (!(k > 0)) return Infinity;
    return -Math.log(k) / Math.log(2);
  }

  /* q(p') / q(p) floor for p' > p. Equals k on an exact doubling. */
  function floorFactor(p, pHigh, k) {
    if (!(pHigh > p)) return 1;
    if (!(k > 0)) return 0;
    return Math.pow(pHigh / p, -elasticity(k));
  }

  function normalizeKnots(input) {
    if (!Array.isArray(input) || input.length < 2) {
      return { ok: false, error: 'At least two prices are required.', knots: [], clamped: false };
    }
    var negative = false;
    var rows = input.map(function (knot) {
      var qty = Number(knot.qty);
      if (qty < 0) {
        qty = 0;
        negative = true;
      }
      return { price: Number(knot.price), qty: qty };
    });
    if (rows.some(function (row) { return !(row.price > 0) || !isFinite(row.price); })) {
      return { ok: false, error: 'Prices must be greater than zero.', knots: rows, clamped: false, negative: negative };
    }
    if (rows.some(function (row) { return !isFinite(row.qty); })) {
      return { ok: false, error: 'Demand must be zero or positive.', knots: rows, clamped: false, negative: negative };
    }
    rows.sort(function (a, b) { return a.price - b.price; });
    for (var i = 1; i < rows.length; i++) {
      if (rows[i].price === rows[i - 1].price) {
        return { ok: false, error: 'Prices must be unique.', knots: rows, clamped: false, negative: negative };
      }
    }
    var clamped = false;
    for (var j = 1; j < rows.length; j++) {
      if (rows[j].qty > rows[j - 1].qty) {
        rows[j].qty = rows[j - 1].qty;
        clamped = true;
      }
    }
    return { ok: true, error: null, knots: rows, clamped: clamped, negative: negative };
  }

  /* Log-log between anchors. Linear demand on a segment that touches zero.
     Outside either end, continue that end's segment. Demand never goes negative. */
  function alongSegment(left, right, p) {
    var span = Math.log(right.price / left.price);
    if (!(span > 0) || !(p > 0)) return Math.max(0, left.qty);
    var t = Math.log(p / left.price) / span;
    var qty;
    if (!(left.qty > 0) || !(right.qty > 0)) {
      qty = left.qty + (right.qty - left.qty) * t;
    } else {
      qty = Math.exp(Math.log(left.qty) + t * (Math.log(right.qty) - Math.log(left.qty)));
    }
    return qty > 0 ? qty : 0;
  }

  function demandAt(knots, p) {
    if (!(p > 0) || !knots.length) return 0;
    if (knots.length === 1) return Math.max(0, knots[0].qty);
    if (p <= knots[0].price) return alongSegment(knots[0], knots[1], p);
    var last = knots[knots.length - 1];
    if (p >= last.price) return alongSegment(knots[knots.length - 2], last, p);
    for (var i = 0; i < knots.length - 1; i++) {
      var left = knots[i];
      var right = knots[i + 1];
      if (p >= left.price && p <= right.price) return alongSegment(left, right, p);
    }
    return Math.max(0, last.qty);
  }

  /* Multiply anchor prices by fee / reference. Quantities stay put, so the
     revenue-maximizing query fee moves in proportion to the creator fee.
     Multiplying quantities by a constant would not move it. */
  function scaleAnchors(knots, creatorFee) {
    var scale = creatorFee / REFERENCE_CREATOR_FEE;
    return knots.map(function (knot) {
      return { price: knot.price * scale, qty: knot.qty };
    });
  }

  function optimalFee(knots) {
    var pMin = knots[0].price / 16;
    var pMax = knots[knots.length - 1].price * 16;
    var candidates = knots.map(function (knot) { return knot.price; });
    var steps = GRID_POINTS - 1;
    for (var i = 0; i < GRID_POINTS; i++) {
      candidates.push(pMin * Math.pow(pMax / pMin, i / steps));
    }
    var best = null;
    for (var c = 0; c < candidates.length; c++) {
      var price = candidates[c];
      var qty = demandAt(knots, price);
      var burn = price * qty;
      if (!best || burn > best.burn + REVENUE_TIE) {
        best = { price: price, quantity: qty, burn: burn };
      } else if (Math.abs(burn - best.burn) <= REVENUE_TIE && price < best.price) {
        best = { price: price, quantity: qty, burn: burn };
      }
    }
    return best;
  }

  function armList(C) {
    return [
      { id: 'half', label: 'Half', price: 0.5 * C },
      { id: 'nearLow', label: 'Near-low', price: C / 1.1 },
      { id: 'nearHigh', label: 'Near-high', price: 1.1 * C },
      { id: 'double', label: 'Double', price: 2 * C }
    ].sort(function (a, b) { return a.price - b.price; });
  }

  function revenuesTie(a, b) {
    return Math.abs(a - b) <= REVENUE_TIE;
  }

  function pickWinner(arms, C) {
    var best = arms[0];
    for (var i = 1; i < arms.length; i++) {
      var arm = arms[i];
      if (arm.revenue > best.revenue && !revenuesTie(arm.revenue, best.revenue)) {
        best = arm;
      } else if (revenuesTie(arm.revenue, best.revenue)) {
        var armDist = Math.abs(arm.price - C);
        var bestDist = Math.abs(best.price - C);
        if (armDist < bestDist - 1e-9 || (Math.abs(armDist - bestDist) <= 1e-9 && arm.price < best.price)) {
          best = arm;
        }
      }
    }
    return best;
  }

  function solveRound(C, h, k, knots) {
    var arms = armList(C);
    var pLow = arms[0].price;
    var shadeLow = (1 - h) * demandAt(knots, pLow);
    var rawHonest = arms.map(function (arm) {
      return h * demandAt(knots, arm.price);
    });
    var honest = rawHonest.slice();
    var honestCapped = rawHonest.map(function () { return false; });
    if (k > 0 && arms.length > 1) {
      for (var i = arms.length - 2; i >= 0; i--) {
        var cap = Infinity;
        for (var j = i + 1; j < arms.length; j++) {
          var allowed = honest[j] / floorFactor(arms[i].price, arms[j].price, k);
          if (allowed < cap) cap = allowed;
        }
        if (honest[i] > cap) {
          honest[i] = cap;
          honestCapped[i] = true;
        }
      }
    }
    var rows = arms.map(function (arm, index) {
      var shade = index === 0 ? shadeLow : (k > 0 ? shadeLow * floorFactor(pLow, arm.price, k) : 0);
      var honestQty = honest[index];
      var total = honestQty + shade;
      return {
        id: arm.id,
        label: arm.label,
        price: arm.price,
        honest: honestQty,
        honestRaw: rawHonest[index],
        honestCapped: honestCapped[index],
        shade: shade,
        bluff: 0,
        total: total,
        revenue: arm.price * total
      };
    });
    return {
      C: C,
      h: h,
      k: k,
      arms: rows,
      winner: pickWinner(rows, C)
    };
  }

  function isCloser(price, C, pStar) {
    return Math.abs(price - pStar) < Math.abs(C - pStar);
  }

  /* The controller must move to one of the four arms. The best it can do is the
     arm closest to the optimal fee, even when that arm is farther from the
     optimum than the current fee. */
  function closestDistance(arms, pStar) {
    var best = Infinity;
    for (var i = 0; i < arms.length; i++) best = Math.min(best, Math.abs(arms[i].price - pStar));
    return best;
  }

  function isClosestAvailable(price, arms, pStar) {
    return Math.abs(Math.abs(price - pStar) - closestDistance(arms, pStar)) <= 1e-6;
  }

  function scanHonesty(C, k, knots, pStar) {
    var baseline = solveRound(C, 0, k, knots).winner;
    /* The price a perfect month selects: the arm with the greatest reported
       revenue when every bidder is honest. It wins at h = 1, so the threshold
       that reaches it cannot be missing. */
    var perfect = solveRound(C, 1, k, knots).winner;
    var hStar = null;
    var hStarPick = null;
    var flip = null;
    var assisted = [];
    for (var i = 0; i <= HONESTY_STEPS; i++) {
      var h = i / HONESTY_STEPS;
      var round = solveRound(C, h, k, knots);
      var winner = round.winner;
      if (!flip && winner.id !== baseline.id) {
        flip = { h: h, id: winner.id, label: winner.label, price: winner.price, fromLabel: baseline.label, fromPrice: baseline.price };
      }
      if (hStar === null && winner.id === perfect.id) {
        hStar = h;
        hStarPick = { h: h, id: winner.id, label: winner.label, price: winner.price };
      }
      var helped = winnerWithBluff(round, C, pStar, knots);
      assisted.push(helped.id === perfect.id ? helped : null);
    }
    /* Lowest honest share at or above which a bluff-caller, when one is
       profitable, still leaves the fully honest winner in the lead. */
    var hBluff = null;
    var hBluffPick = null;
    for (var j = HONESTY_STEPS; j >= 0; j--) {
      if (!assisted[j]) break;
      hBluff = j / HONESTY_STEPS;
      hBluffPick = { h: hBluff, id: assisted[j].id, label: assisted[j].label, price: assisted[j].price };
    }
    return { hStar: hStar, hStarPick: hStarPick, hBluff: hBluff, hBluffPick: hBluffPick, flip: flip };
  }

  /* Other bidders spend their tokens on the highest-value markets first.
     The caller is left with the less valuable ones, and does not resell above
     the revenue-maximizing fee. Leftover at an offered fee p is max(0, D(p) − created).
     They buy at least `delta` tokens so the arm wins. At a posted fee above the
     purchase price, every extra token that still sells earns the spread, so they
     buy the whole leftover whenever it covers that minimum. */
  function bestOffer(knots, buyPrice, created, delta, ceiling) {
    var none = {
      price: buyPrice,
      quantity: delta,
      sold: 0,
      leftover: 0,
      revenue: 0,
      profit: -(buyPrice > 0 ? buyPrice * delta : 0)
    };
    if (!(delta > 0) || !(buyPrice > 0) || !(ceiling > buyPrice)) return none;
    function residual(p) {
      if (!(p <= ceiling)) return 0;
      return Math.max(0, demandAt(knots, p) - created);
    }
    function offerAt(p) {
      var r = residual(p);
      if (r >= delta) {
        return { quantity: r, sold: r, leftover: r, revenue: p * r, profit: (p - buyPrice) * r };
      }
      return { quantity: delta, sold: r, leftover: r, revenue: p * r, profit: p * r - buyPrice * delta };
    }
    var best = null;
    function consider(p) {
      if (!(p > buyPrice) || p > ceiling + 1e-9) return;
      if (p > ceiling) p = ceiling;
      var offer = offerAt(p);
      if (!best || offer.profit > best.profit + 1e-6 ||
          (Math.abs(offer.profit - best.profit) <= 1e-6 && offer.quantity < best.quantity)) {
        best = {
          price: p,
          quantity: offer.quantity,
          sold: offer.sold,
          leftover: offer.leftover,
          revenue: offer.revenue,
          profit: offer.profit
        };
      }
    }
    var cuts = [buyPrice, ceiling];
    for (var k = 0; k < knots.length; k++) {
      if (knots[k].price > buyPrice && knots[k].price < ceiling) cuts.push(knots[k].price);
    }
    if (residual(buyPrice) >= delta && residual(ceiling) < delta) {
      var lo = buyPrice;
      var hi = ceiling;
      for (var i = 0; i < 60; i++) {
        var mid = (lo + hi) / 2;
        if (residual(mid) >= delta) lo = mid;
        else hi = mid;
      }
      cuts.push(lo);
    }
    cuts.sort(function (a, b) { return a - b; });
    var phi = (Math.sqrt(5) - 1) / 2;
    for (var c = 0; c < cuts.length - 1; c++) {
      var left = cuts[c];
      var right = cuts[c + 1];
      if (!(right > left)) continue;
      var a = left;
      var b = right;
      var x1 = b - phi * (b - a);
      var x2 = a + phi * (b - a);
      var f1 = offerAt(x1).profit;
      var f2 = offerAt(x2).profit;
      for (var g = 0; g < 50; g++) {
        if (f1 > f2) {
          b = x2;
          x2 = x1;
          f2 = f1;
          x1 = b - phi * (b - a);
          f1 = offerAt(x1).profit;
        } else {
          a = x1;
          x1 = x2;
          f1 = f2;
          x2 = a + phi * (b - a);
          f2 = offerAt(x2).profit;
        }
      }
      consider((a + b) / 2);
    }
    consider(ceiling);
    var steps = GRID_POINTS;
    for (var s = 1; s <= steps; s++) {
      consider(buyPrice * Math.pow(ceiling / buyPrice, s / steps));
    }
    return best || none;
  }

  /* The caller bids nothing on cheaper prices. On one higher price they buy at
     least enough to lead by $0.01, and as many more as still resell above cost.
     They take the arm, quantity, and resale price with the greatest profit. */
  function quoteBluff(arm, arms, C, pStar, knots) {
    var others = arms.filter(function (row) { return row.id !== arm.id; });
    var beat = others.reduce(function (max, row) { return Math.max(max, row.revenue); }, 0);
    var delta = Math.max(0, (beat + STRICT_MARGIN - arm.revenue) / arm.price);
    var created = arm.honest + arm.shade;
    var sale = bestOffer(knots, arm.price, created, delta, pStar);
    var quantity = sale.quantity;
    var spend = arm.price * quantity;
    var shadedWinner = pickWinner(arms, C);
    var callsShade = arm.price > shadedWinner.price + 1e-9;
    return {
      armId: arm.id,
      label: arm.label,
      price: arm.price,
      delta: delta,
      quantity: quantity,
      spend: spend,
      sellPrice: sale.price,
      sold: sale.sold,
      leftover: sale.leftover,
      saleRevenue: sale.revenue,
      profit: sale.profit,
      roi: spend > 0 ? sale.profit / spend : 0,
      eligible: isCloser(arm.price, C, pStar),
      rational: callsShade && sale.profit > 0 && spend > 0
    };
  }

  function rationalBluffs(arms, C, pStar, knots) {
    var quotes = arms.map(function (arm) {
      return quoteBluff(arm, arms, C, pStar, knots);
    });
    var rational = quotes.filter(function (quote) { return quote.rational; });
    rational.sort(function (a, b) {
      return (b.profit - a.profit) || (b.roi - a.roi) || (a.spend - b.spend) || (a.price - b.price);
    });
    return rational;
  }

  /* The caller's bid, when they have one, is part of the book the controller sees. */
  function winnerWithBluff(round, C, pStar, knots) {
    var rational = rationalBluffs(round.arms, C, pStar, knots);
    if (!rational.length) return round.winner;
    var quote = rational[0];
    var arms = round.arms.map(function (arm) {
      if (arm.id !== quote.armId) return arm;
      var bid = quote.quantity > 0 ? quote.quantity : quote.delta;
      var total = arm.total + bid;
      return Object.assign({}, arm, {
        bluff: bid,
        total: total,
        revenue: arm.price * total
      });
    });
    return pickWinner(arms, C);
  }

  function floorWarning(knots, arms, k) {
    if (!(k > 0)) return false;
    for (var i = 0; i < arms.length; i++) {
      var price = arms[i].price;
      var here = demandAt(knots, price);
      if (!(here > 0)) continue;
      if (demandAt(knots, 2 * price) / here < k - 1e-9) return true;
    }
    return false;
  }

  function applyBluff(model, quote) {
    var arms = model.arms.map(function (arm) {
      if (arm.id !== quote.armId) return Object.assign({}, arm, { bluff: 0 });
      var bid = quote.quantity > 0 ? quote.quantity : quote.delta;
      var total = arm.total + bid;
      return Object.assign({}, arm, {
        bluff: bid,
        total: total,
        revenue: arm.price * total
      });
    });
    return Object.assign({}, model, {
      arms: arms,
      winner: pickWinner(arms, model.C),
      bluffApplied: quote
    });
  }

  function evaluate(input) {
    var C = Number(input.C);
    var h = Number(input.h);
    var k = Number(input.k);
    var norm = normalizeKnots(input.knots);
    var creatorFee = input.creatorFee == null ? REFERENCE_CREATOR_FEE : Number(input.creatorFee);
    if (!(C > 0) || !isFinite(C)) return { ok: false, error: 'Current fee must be positive.' };
    if (!(h >= 0 && h <= 1) || !isFinite(h)) return { ok: false, error: 'Honest fraction must be between 0 and 1.' };
    if (!(k >= 0 && k <= 0.4999 + 1e-12) || !isFinite(k)) {
      return { ok: false, error: 'Floor k must be between 0 and 0.4999.' };
    }
    if (!(creatorFee > 0) || !isFinite(creatorFee)) {
      return { ok: false, error: 'Market creator fee must be positive.' };
    }
    if (!norm.ok) return { ok: false, error: norm.error };
    var knots = scaleAnchors(norm.knots, creatorFee);
    var round = solveRound(C, h, k, knots);
    var pStar = optimalFee(knots);
    var scan = scanHonesty(C, k, knots, pStar.price);
    var rational = rationalBluffs(round.arms, C, pStar.price, knots);
    var quotes = round.arms.map(function (arm) {
      return quoteBluff(arm, round.arms, C, pStar.price, knots);
    });
    return {
      ok: true,
      error: null,
      C: C,
      h: h,
      k: k,
      creatorFee: creatorFee,
      knots: knots,
      referenceKnots: norm.knots,
      elasticity: elasticity(k),
      arms: round.arms,
      winner: round.winner,
      pStar: pStar,
      hStar: scan.hStar,
      hStarPick: scan.hStarPick,
      hBluff: scan.hBluff,
      hBluffPick: scan.hBluffPick,
      flip: scan.flip,
      quotes: quotes,
      rationalBluffs: rational,
      bestBluff: rational.length ? rational[0] : null,
      floorWarning: floorWarning(knots, round.arms, k) || round.arms.some(function (arm) { return arm.honestCapped; }),
      distanceCurrent: Math.abs(C - pStar.price),
      distanceSelected: Math.abs(round.winner.price - pStar.price)
    };
  }

  return {
    PRESETS: PRESETS,
    GRID_POINTS: GRID_POINTS,
    REFERENCE_CREATOR_FEE: REFERENCE_CREATOR_FEE,
    STRICT_MARGIN: STRICT_MARGIN,
    cloneKnots: cloneKnots,
    elasticity: elasticity,
    normalizeKnots: normalizeKnots,
    demandAt: demandAt,
    optimalFee: optimalFee,
    isCloser: isCloser,
    isClosestAvailable: isClosestAvailable,
    closestDistance: closestDistance,
    evaluate: evaluate,
    applyBluff: applyBluff,
    quoteBluff: quoteBluff,
    pickWinner: pickWinner,
    rationalBluffs: rationalBluffs
  };
});
