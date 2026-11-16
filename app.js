(function () {
  'use strict';

  var A = window.FeeAuction;
  if (!A) {
    var resultsEl = document.getElementById('results');
    if (resultsEl) {
      resultsEl.innerHTML = '<article class="card"><p class="note error">The auction engine failed to load. Hard-refresh the page.</p></article>';
    }
    return;
  }
  var preset = A.PRESETS.polymarket;
  var baseKnots = A.cloneKnots(preset.knots);
  var demandPercent = 10;
  var sensitivityAbove = 50;
  var sensitivityBelow = 50;
  var C = preset.C;
  var h = preset.h;
  var k = preset.k;
  var creatorFee = preset.creatorPercent / 100;

  var CREATOR_MIN = 0.01;
  var CREATOR_MAX = 5;
  var CREATOR_STEPS = 1000;

  function demandFactor() {
    return demandPercent / 100;
  }

  function priceScale() {
    return creatorFee / A.REFERENCE_CREATOR_FEE;
  }

  function creatorPercentFromSlider(position) {
    var t = Math.min(CREATOR_STEPS, Math.max(0, Number(position))) / CREATOR_STEPS;
    var logMin = Math.log(CREATOR_MIN);
    var logMax = Math.log(CREATOR_MAX);
    return Math.exp(logMin + t * (logMax - logMin));
  }

  function sliderFromCreatorPercent(percent) {
    var logMin = Math.log(CREATOR_MIN);
    var logMax = Math.log(CREATOR_MAX);
    var t = (Math.log(percent) - logMin) / (logMax - logMin);
    return Math.round(Math.min(1, Math.max(0, t)) * CREATOR_STEPS);
  }

  function formatCreator(percent) {
    var rounded = Math.round(percent * 1000) / 1000;
    return rounded >= 0.1 ? rounded.toFixed(2) : rounded.toFixed(3);
  }

  /* 50 is neutral. Each slider maps to u in [-1, 1]. */
  function sensitivityUnit(position) {
    var t = (Number(position) - 50) / 50;
    if (!isFinite(t)) return 0;
    return Math.max(-1, Math.min(1, t));
  }

  function sensitivityLabel(position) {
    var value = Math.round(Number(position));
    if (value === 50) return 'neutral';
    if (value < 50) return 'lower';
    return 'higher';
  }

  /* Log-distance weight from p*. Cutting uses the cumulative weight; raising
     demand multiplies by a far fade so the expensive/cheap tails do not run away.
     Tuned so default Polymarket @ 0.07%/10%: min-above ≈400 at $56, max-below ≈500 at $28. */
  var SENSITIVITY_SIGMA = 0.18;
  var SENSITIVITY_FAR = 0.85;
  var SENSITIVITY_E_ABOVE_LO = 0.05;
  var SENSITIVITY_E_ABOVE_HI = 3.2;
  var SENSITIVITY_E_BELOW_LO = 1.5;
  var SENSITIVITY_E_BELOW_HI = 0.15;

  function logDistanceWeight(price, pStar) {
    if (!(price > 0) || !(pStar > 0)) return 0;
    var x = Math.abs(Math.log(price / pStar));
    return 1 - Math.exp(-x / SENSITIVITY_SIGMA);
  }

  function raiseDistanceWeight(price, pStar) {
    if (!(price > 0) || !(pStar > 0)) return 0;
    var x = Math.abs(Math.log(price / pStar));
    return logDistanceWeight(price, pStar) * Math.exp(-(x * x) / (SENSITIVITY_FAR * SENSITIVITY_FAR));
  }

  function sensitivityTargetQty(price, pStar, qStar, elasticity) {
    return qStar * Math.pow(pStar / Math.max(price, 1e-9), elasticity);
  }

  function sideElasticity(unit, lo, hi) {
    return unit >= 0 ? hi : lo;
  }

  function blendToward(qty, target, mix) {
    var m = Math.min(0.98, Math.max(0, mix));
    return (1 - m) * qty + m * target;
  }

  function unblendToward(qty, target, mix) {
    var m = Math.min(0.98, Math.max(0, mix));
    if (m >= 0.999) return qty;
    return (qty - m * target) / (1 - m);
  }

  function reshapeQty(qty, price, pStar, qStar, unitBelow, unitAbove) {
    if (!(price > 0) || !(pStar > 0)) return qty;
    if (price > pStar && Math.abs(unitAbove) >= 1e-12) {
      var eAbove = sideElasticity(unitAbove, SENSITIVITY_E_ABOVE_LO, SENSITIVITY_E_ABOVE_HI);
      var wAbove = unitAbove > 0 ? logDistanceWeight(price, pStar) : raiseDistanceWeight(price, pStar);
      return blendToward(
        qty,
        sensitivityTargetQty(price, pStar, qStar, eAbove),
        Math.abs(unitAbove) * wAbove
      );
    }
    if (price < pStar && Math.abs(unitBelow) >= 1e-12) {
      var eBelow = sideElasticity(unitBelow, SENSITIVITY_E_BELOW_LO, SENSITIVITY_E_BELOW_HI);
      var wBelow = unitBelow > 0 ? logDistanceWeight(price, pStar) : raiseDistanceWeight(price, pStar);
      return blendToward(
        qty,
        sensitivityTargetQty(price, pStar, qStar, eBelow),
        Math.abs(unitBelow) * wBelow
      );
    }
    return qty;
  }

  function unshapeQty(qty, price, pStar, qStar, unitBelow, unitAbove) {
    if (!(price > 0) || !(pStar > 0)) return qty;
    if (price > pStar && Math.abs(unitAbove) >= 1e-12) {
      var eAbove = sideElasticity(unitAbove, SENSITIVITY_E_ABOVE_LO, SENSITIVITY_E_ABOVE_HI);
      var wAbove = unitAbove > 0 ? logDistanceWeight(price, pStar) : raiseDistanceWeight(price, pStar);
      return unblendToward(
        qty,
        sensitivityTargetQty(price, pStar, qStar, eAbove),
        Math.abs(unitAbove) * wAbove
      );
    }
    if (price < pStar && Math.abs(unitBelow) >= 1e-12) {
      var eBelow = sideElasticity(unitBelow, SENSITIVITY_E_BELOW_LO, SENSITIVITY_E_BELOW_HI);
      var wBelow = unitBelow > 0 ? logDistanceWeight(price, pStar) : raiseDistanceWeight(price, pStar);
      return unblendToward(
        qty,
        sensitivityTargetQty(price, pStar, qStar, eBelow),
        Math.abs(unitBelow) * wBelow
      );
    }
    return qty;
  }

  /* Reshape around the revenue-maximizing fee. Demand there stays put.
     Each slider blends only its side, weighted by distance from the peak. */
  function reshapeAroundPeak(rows, unitBelow, unitAbove) {
    if (!rows.length) return [];
    var shaped = rows.map(function (knot) {
      return { price: knot.price, qty: knot.qty };
    });
    if (Math.abs(unitBelow) < 1e-12 && Math.abs(unitAbove) < 1e-12) return shaped;
    var peak = A.optimalFee(shaped);
    if (!peak || !(peak.price > 0)) return shaped;
    var pStar = peak.price;
    var qStar = Math.max(0, peak.quantity);
    shaped = shaped.map(function (knot) {
      var qty = reshapeQty(knot.qty, knot.price, pStar, qStar, unitBelow, unitAbove);
      return { price: knot.price, qty: Math.max(0, qty) };
    });
    shaped = shaped.map(function (knot) {
      return { price: knot.price, qty: Math.max(0, Math.round(knot.qty)) };
    });
    for (var i = 0; i < shaped.length - 1; i++) {
      if (shaped[i + 1].qty >= shaped[i].qty) {
        shaped[i + 1].qty = Math.max(0, shaped[i].qty - 1);
      }
    }
    return shaped;
  }

  function unshapeDisplayed(displayed) {
    var unitBelow = sensitivityUnit(sensitivityBelow);
    var unitAbove = sensitivityUnit(sensitivityAbove);
    if (!displayed.length || (Math.abs(unitBelow) < 1e-12 && Math.abs(unitAbove) < 1e-12)) {
      return displayed.map(function (knot) {
        return { price: knot.price, qty: knot.qty };
      });
    }
    var neutral = scaleOnlyKnots();
    var peak = A.optimalFee(neutral);
    if (!peak || !(peak.price > 0)) {
      return displayed.map(function (knot) {
        return { price: knot.price, qty: knot.qty };
      });
    }
    var pStar = peak.price;
    var qStar = Math.max(0, peak.quantity);
    return displayed.map(function (knot) {
      var qty = unshapeQty(knot.qty, knot.price, pStar, qStar, unitBelow, unitAbove);
      return { price: knot.price, qty: Math.max(0, qty) };
    });
  }

  /* Prices in the table are the prices the auction uses. The stored curve is
     the 1% creator-fee book; the slider scales those prices onto the page. */
  function scaleOnlyKnots() {
    var ps = priceScale();
    var qs = demandFactor();
    var rows = [];
    baseKnots.forEach(function (knot) {
      var price = Math.max(1, Math.round(knot.price * ps));
      var qty = Math.max(0, Math.round(knot.qty * qs));
      if (rows.length && price <= rows[rows.length - 1].price) price = rows[rows.length - 1].price + 1;
      if (rows.length && qty > rows[rows.length - 1].qty) qty = rows[rows.length - 1].qty;
      rows.push({ price: price, qty: qty });
    });
    return rows;
  }

  function projectKnots() {
    return reshapeAroundPeak(
      scaleOnlyKnots(),
      sensitivityUnit(sensitivityBelow),
      sensitivityUnit(sensitivityAbove)
    );
  }

  function adoptDisplayed(displayed) {
    var ps = priceScale();
    var qs = demandFactor();
    var neutral = unshapeDisplayed(displayed);
    baseKnots = neutral.map(function (knot) {
      return {
        price: ps > 0 ? knot.price / ps : knot.price,
        qty: qs > 0 ? knot.qty / qs : knot.qty
      };
    });
    knots = projectKnots();
  }

  var knots = projectKnots();
  var bluffDisabled = false;
  var winningPrice = Math.max(1, Math.round(C));
  var noteTimer = 0;
  var priceCommit = 0;

  var fee = document.getElementById('fee');
  var honestRange = document.getElementById('honest-range');
  var honestNumber = document.getElementById('honest-number');
  var floorRange = document.getElementById('floor-range');
  var floorNumber = document.getElementById('floor-number');
  var creatorRange = document.getElementById('creator-range');
  var creatorNumber = document.getElementById('creator-number');
  var demandRange = document.getElementById('demand-range');
  var demandNumber = document.getElementById('demand-number');
  var sensitivityAboveRange = document.getElementById('sensitivity-above-range');
  var sensitivityBelowRange = document.getElementById('sensitivity-below-range');
  var knotTable = document.getElementById('knots');

  document.getElementById('controls').addEventListener('submit', function (event) {
    event.preventDefault();
  });

  function money(n) {
    if (!isFinite(n)) n = 0;
    var abs = Math.abs(n);
    if (abs > 0 && abs < 1) {
      var dimes = Math.round(n * 10) / 10;
      if (Math.abs(dimes) >= 1) {
        return Math.round(dimes).toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 0
        });
      }
      return dimes.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
    }
    return Math.round(n).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0
    });
  }

  function qty(n) {
    return Math.round(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  function percent(fraction) {
    return Math.round(fraction * 100).toLocaleString('en-US') + '%';
  }

  function formatPlain(n) {
    if (!isFinite(n)) return '';
    if (Math.abs(n - Math.round(n)) < 1e-8) return String(Math.round(n));
    return String(Math.round(n * 1e6) / 1e6);
  }

  function formatWhole(n) {
    if (!isFinite(n)) return '';
    return String(Math.round(n));
  }

  function formatE(value) {
    if (!(value > 0)) return 'no floor';
    var e = -Math.log(value) / Math.log(2);
    return e.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  }

  function compact(n) {
    var sign = n < 0 ? '-' : '';
    var v = Math.abs(n);
    function unit(div, suffix) {
      var text = (Math.round(v / div * 10) / 10).toFixed(1).replace(/\.0$/, '');
      return sign + text + suffix;
    }
    if (v >= 1e6) return unit(1e6, 'M');
    if (v >= 1e3) return unit(1e3, 'k');
    if (v > 0 && v < 1) {
      var dimes = Math.round(v * 10) / 10;
      if (dimes >= 1) return sign + '1';
      return sign + dimes.toFixed(2);
    }
    return sign + String(Math.round(v));
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function flash(text) {
    var el = document.getElementById('knot-note');
    el.hidden = false;
    el.textContent = text;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { el.hidden = true; }, 4200);
  }

  function clearNote() {
    clearTimeout(noteTimer);
    document.getElementById('knot-note').hidden = true;
  }

  function showKnotError(text) {
    var el = document.getElementById('knot-error');
    el.hidden = false;
    el.textContent = text;
  }

  function hideKnotError() {
    document.getElementById('knot-error').hidden = true;
  }

  function readRows() {
    var rows = [];
    var incomplete = false;
    knotTable.querySelectorAll('tbody tr').forEach(function (tr) {
      var priceRaw = tr.querySelector('.knot-price').value.trim();
      var qtyRaw = tr.querySelector('.knot-qty').value.trim();
      if (priceRaw === '' || qtyRaw === '') incomplete = true;
      rows.push({ price: Number(priceRaw), qty: Number(qtyRaw) });
    });
    return { rows: rows, incomplete: incomplete };
  }

  function renderKnots() {
    var body = knotTable.querySelector('tbody');
    var locked = knots.length <= 2;
    body.innerHTML = knots.map(function (knot, index) {
      return '<tr>' +
        '<td><input class="knot-price" data-index="' + index + '" type="number" min="0" step="any" value="' + formatWhole(knot.price) + '" aria-label="Price ' + (index + 1) + '"></td>' +
        '<td><input class="knot-qty" data-index="' + index + '" type="number" min="0" step="1" value="' + formatWhole(knot.qty) + '" aria-label="Demand ' + (index + 1) + '"></td>' +
        '<td><button type="button" class="ghost" data-remove="' + index + '"' + (locked ? ' disabled' : '') + '>Remove</button></td>' +
        '</tr>';
    }).join('');
  }

  function writeQty(list) {
    knotTable.querySelectorAll('.knot-qty').forEach(function (input, index) {
      var next = formatWhole(list[index].qty);
      var typed = Number(input.value);
      if (typed !== list[index].qty) input.value = next;
    });
  }

  function bluffReason() {
    return 'Bluff-calling is not profitable this month. A bluff-caller bids nothing on the cheaper prices and enough at a higher price to cause it to win, then resells for a profit.';
  }

  function honestyHtml(model) {
    var value = percent(model.hStar);
    var optimal = money(model.hStarPick.price);
    var detail = 'If this percent of bidders are honest, the auction successfully selects the optimal price (' + optimal + ') even without a bluff-caller.';
    var floor = '';
    if (model.hBluff == null) {
      floor = 'Even with a bluff-caller helping, no honest share selects the optimal price.';
    } else if (model.hBluff === 0) {
      floor = 'With a bluff-caller helping, the auction will select the optimal price (' +
        money(model.hBluffPick.price) + ') even if all bidders lie.';
    } else if (model.hBluff !== model.hStar) {
      floor = 'The percent honest would have to be below ' + percent(model.hBluff) +
        ' to not select the optimal price even with a bluff-caller helping.';
    }
    return '<article class="card"><h2 class="sentence">Honesty threshold where controller works perfectly even without a bluff-caller</h2>' +
      '<p class="hero-value" style="font-size:40px" data-testid="hstar">' + esc(value) + '</p>' +
      '<p class="sub" data-testid="hstar-note">' + esc(detail) + '</p>' +
      (floor
        ? '<p class="sub" data-testid="bluff-floor">' + esc(floor) + '</p>'
        : '') +
      '</article>';
  }

  function bluffToggle() {
    return '<label class="check"><input type="checkbox" id="disable-bluff" data-testid="disable-bluff"' +
      (bluffDisabled ? ' checked' : '') + '> Disable Bluff-Caller</label>';
  }

  function bluffHead() {
    return '<div class="card-head"><h2>Bluff-caller</h2>' + bluffToggle() + '</div>';
  }

  function bluffHtml(model) {
    var best = model.bestBluff;
    var head = bluffHead();
    if (!best) {
      return '<article class="card" data-testid="bluff-card">' + head +
        '<p data-testid="bluff-reason">' + esc(bluffReason(model)) + '</p></article>';
    }
    if (bluffDisabled) {
      return '<article class="card" data-testid="bluff-card">' + head +
        '<p data-testid="bluff-disabled">A bluff-caller will not show up even though its profitable to do so</p></article>';
    }
    var others = model.rationalBluffs.length - 1;
    var more = others > 0
      ? ' ' + others + (others === 1 ? ' other price earns less profit.' : ' other prices earn less profit.')
      : '';
    var bidQty = best.quantity > 0 ? best.quantity : best.delta;
    var tokens = Math.round(bidQty);
    var markets = Math.round(best.leftover);
    var tokenWord = tokens === 1 ? 'query token' : 'query tokens';
    var marketWord = markets === 1 ? 'market' : 'markets';
    return '<article class="card" data-testid="bluff-card">' + head +
      '<p data-testid="bluff-call">Bids enough (' + qty(bidQty) + ' ' + tokenWord + ') on the ' + money(best.price) +
      ' price to cause that price to win, then resells at ' + money(best.sellPrice) +
      '. They are able to sell at this price because other bidders lied about demand and there are still ' +
      qty(best.leftover) + ' ' + marketWord + ' that are profitable to create at this price.' + more + '</p>' +
      '<div class="stats">' +
      '<div class="stat"><span>Spend</span><b data-testid="bluff-spend">' + money(best.spend) + '</b></div>' +
      '<div class="stat"><span>Resale price</span><b data-testid="bluff-sell">' + money(best.sellPrice) + '</b></div>' +
      '<div class="stat"><span>Profit</span><b data-testid="bluff-profit">' + money(best.profit) + '</b></div>' +
      '<div class="stat"><span>ROI</span><b data-testid="bluff-roi">' + percent(best.roi) + '</b></div>' +
      '</div></article>';
  }

  function floorWarningNote(model) {
    if (!model.floorWarning) return '';
    var nowEff = controllerEfficiency(model.winner.price, model);
    var freeEff = efficiencyWithoutHonestCap(model);
    if (!(freeEff - nowEff >= 0.01 - 1e-15)) return '';
    return '<p class="note" data-testid="floor-warning">The minimum demand rule is causing honest bidders to have to bid more quantity than they prefer for higher prices. They are reacting by reporting their demand honestly on the highest price and bidding the max amount allowed on all lower prices. As a result overall demand is artifically reduced causing efficiency to be ' +
      percent(nowEff) + ' instead of ' + percent(freeEff) + '</p>';
  }

  function tableHtml(model) {
    var maxRev = model.arms.reduce(function (max, arm) { return Math.max(max, arm.revenue); }, 0) || 1;
    var showCall = model.arms.some(function (arm) { return arm.bluff > 0; });
    var head = '<tr><th>Arm</th><th>Price</th><th>Honest qty</th><th>Shade qty</th>' +
      (showCall ? '<th>Caller qty</th>' : '') +
      '<th>Total qty</th><th>Revenue</th></tr>';
    var perfect = model.hStarPick && model.winner.id === model.hStarPick.id;
    var body = model.arms.map(function (arm) {
      var width = Math.max(0, Math.min(100, 100 * arm.revenue / maxRev));
      var rowClass = arm.id === model.winner.id ? (perfect ? 'winner good' : 'winner') : '';
      return '<tr class="' + rowClass + '" data-testid="arm-' + arm.id + '">' +
        '<td>' + esc(arm.label) + '</td>' +
        '<td>' + money(arm.price) + '</td>' +
        '<td>' + qty(arm.honest) + '</td>' +
        '<td>' + qty(arm.shade) + '</td>' +
        (showCall ? '<td>' + qty(arm.bluff || 0) + '</td>' : '') +
        '<td>' + qty(arm.total) + '</td>' +
        '<td>' + money(arm.revenue) + '<div class="bar" aria-hidden="true"><span style="width:' + width.toFixed(1) + '%"></span></div></td>' +
        '</tr>';
    }).join('');
    var caption = showCall ? 'Reported book, with the bluff-caller' : 'Reported book';
    return '<article class="card"><h2>' + caption + '</h2><div class="table-wrap"><table class="book">' +
      head + body + '</table></div>' + floorWarningNote(model) + '</article>';
  }

  function chartSvg(model) {
    var curveKnots = model.knots;
    var prices = [curveKnots[0].price, curveKnots[curveKnots.length - 1].price, model.C, model.pStar.price];
    model.arms.forEach(function (arm) { prices.push(arm.price); });
    var pMin = Math.min.apply(null, prices);
    var pMax = Math.max.apply(null, prices);
    if (!(pMax > pMin * 1.000001)) pMax = pMin * 1.01;
    var width = 720;
    var padL = 58;
    var padR = 16;
    var padT = 28;
    var plotH = 132;
    var padB = 28;
    var panelH = padT + plotH + padB;
    var height = panelH * 2;
    var samplePs = [];
    for (var i = 0; i <= 140; i++) samplePs.push(pMin * Math.pow(pMax / pMin, i / 140));
    curveKnots.forEach(function (knot) { samplePs.push(knot.price); });
    samplePs.push(model.C, model.pStar.price, model.winner.price);
    samplePs = samplePs.filter(function (p) { return p > 0; }).sort(function (a, b) { return a - b; });
    var samples = [];
    samplePs.forEach(function (p) {
      if (samples.length && Math.abs(p - samples[samples.length - 1].p) / p < 1e-8) return;
      var q = A.demandAt(curveKnots, p);
      samples.push({ p: p, q: q, burn: p * q });
    });
    var qMax = samples.reduce(function (max, s) { return Math.max(max, s.q); }, 1) * 1.14;
    var bMax = samples.reduce(function (max, s) { return Math.max(max, s.burn); }, 1) * 1.14;

    function xOf(p) {
      var t = Math.log(p / pMin) / Math.log(pMax / pMin);
      return padL + t * (width - padL - padR);
    }
    function yOf(value, max, top) {
      return top + padT + (1 - value / max) * plotH;
    }
    function linePath(key, max, top) {
      return samples.map(function (s, index) {
        return (index ? 'L' : 'M') + xOf(s.p).toFixed(2) + ' ' + yOf(s[key], max, top).toFixed(2);
      }).join('');
    }
    function areaPath(key, max, top) {
      var base = (top + padT + plotH).toFixed(2);
      var start = xOf(samples[0].p).toFixed(2);
      var end = xOf(samples[samples.length - 1].p).toFixed(2);
      return linePath(key, max, top) + 'L' + end + ' ' + base + 'L' + start + ' ' + base + 'Z';
    }

    var parts = [];
    parts.push('<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Profit and demand curves. Optimal fee ' +
      money(model.pStar.price) + ', selected fee ' + money(model.winner.price) + '.">');
    parts.push('<rect width="' + width + '" height="' + height + '" fill="#faf6ee"/>');

    function panel(top, key, max, title, yFormat) {
      var axisTop = top + padT;
      var axisBot = top + padT + plotH;
      parts.push('<line x1="' + padL + '" y1="' + axisTop + '" x2="' + padL + '" y2="' + axisBot + '" stroke="#1b1612" stroke-width="1"/>');
      parts.push('<line x1="' + padL + '" y1="' + axisBot + '" x2="' + (width - padR) + '" y2="' + axisBot + '" stroke="#1b1612" stroke-width="1"/>');
      [0.5, 1].forEach(function (frac) {
        var y = yOf(max * frac, max, top);
        parts.push('<line x1="' + padL + '" y1="' + y.toFixed(2) + '" x2="' + (width - padR) + '" y2="' + y.toFixed(2) + '" stroke="#e6ddd0" stroke-width="1"/>');
        parts.push('<text x="' + (padL - 8) + '" y="' + (y + 4).toFixed(2) + '" text-anchor="end" font-size="11" fill="#5e564c">' + yFormat(max * frac) + '</text>');
      });
      parts.push('<text x="' + (padL - 8) + '" y="' + (axisBot + 4) + '" text-anchor="end" font-size="11" fill="#5e564c">0</text>');
      parts.push('<text x="' + padL + '" y="' + (top + 16) + '" font-size="13" font-weight="600" fill="#1b1612">' + title + '</text>');
      model.arms.forEach(function (arm) {
        var x = xOf(arm.price);
        parts.push('<line x1="' + x.toFixed(2) + '" y1="' + axisTop + '" x2="' + x.toFixed(2) + '" y2="' + axisBot + '" stroke="#e4d9cc" stroke-width="1"/>');
      });
      var cx = xOf(model.C);
      parts.push('<line x1="' + cx.toFixed(2) + '" y1="' + axisTop + '" x2="' + cx.toFixed(2) + '" y2="' + axisBot + '" stroke="#1b1612" stroke-width="1" stroke-dasharray="3 3"/>');
    }

    panel(0, 'q', qMax, 'Demand', compact);
    panel(panelH, 'burn', bMax, 'REP burn', function (n) { return '$' + compact(n); });
    parts.push('<path d="' + areaPath('q', qMax, 0) + '" fill="#1b1612" opacity="0.06"/>');
    parts.push('<path d="' + linePath('q', qMax, 0) + '" fill="none" stroke="#1b1612" stroke-width="2"/>');
    parts.push('<path d="' + areaPath('burn', bMax, panelH) + '" fill="#b45324" opacity="0.1"/>');
    parts.push('<path d="' + linePath('burn', bMax, panelH) + '" fill="none" stroke="#b45324" stroke-width="2"/>');

    function dot(price, value, max, top, kind) {
      var x = xOf(price);
      var y = yOf(value, max, top);
      if (kind === 'optimal') {
        var d = 5;
        parts.push('<polygon points="' + x.toFixed(2) + ',' + (y - d).toFixed(2) + ' ' + (x + d).toFixed(2) + ',' + y.toFixed(2) + ' ' +
          x.toFixed(2) + ',' + (y + d).toFixed(2) + ' ' + (x - d).toFixed(2) + ',' + y.toFixed(2) + '" fill="#1f6a45" stroke="#faf6ee" stroke-width="1.5"/>');
      } else {
        parts.push('<circle cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="4.5" fill="#b45324" stroke="#faf6ee" stroke-width="1.5"/>');
      }
    }
    dot(model.pStar.price, model.pStar.quantity, qMax, 0, 'optimal');
    dot(model.winner.price, A.demandAt(curveKnots, model.winner.price), qMax, 0, 'selected');
    dot(model.pStar.price, model.pStar.burn, bMax, panelH, 'optimal');
    dot(model.winner.price, model.winner.price * A.demandAt(curveKnots, model.winner.price), bMax, panelH, 'selected');

    var tags = [
      { x: xOf(model.pStar.price), text: 'Optimal', color: '#1f6a45', role: 'optimal' },
      { x: xOf(model.winner.price), text: 'Selected', color: '#b45324', role: 'selected' },
      { x: xOf(model.C), text: 'Current', color: '#1b1612', role: 'current' }
    ].sort(function (a, b) { return a.x - b.x; });
    var merged = [];
    tags.forEach(function (tag) {
      var prev = merged[merged.length - 1];
      if (prev && Math.abs(tag.x - prev.x) < 12) {
        prev.text += ' · ' + tag.text;
        if (tag.role === 'optimal') prev.color = tag.color;
      } else {
        merged.push({ x: tag.x, text: tag.text, color: tag.color });
      }
    });
    var lanes = [-1e9, -1e9];
    merged.forEach(function (tag) {
      var lane = tag.x - lanes[0] >= 72 ? 0 : 1;
      if (tag.x - lanes[lane] < 72) lane = lane === 0 ? 1 : 0;
      tag.lane = lane;
      lanes[lane] = tag.x;
      var anchor = 'middle';
      var x = tag.x;
      if (x < padL + 36) { anchor = 'start'; x = Math.max(x, padL); }
      if (x > width - padR - 36) { anchor = 'end'; x = Math.min(x, width - padR); }
      parts.push('<text x="' + x.toFixed(2) + '" y="' + (42 + tag.lane * 13) + '" text-anchor="' + anchor + '" font-size="11" fill="' + tag.color + '" stroke="#faf6ee" stroke-width="3" paint-order="stroke">' + esc(tag.text) + '</text>');
    });

    [0, 0.5, 1].forEach(function (t) {
      var p = pMin * Math.pow(pMax / pMin, t);
      var x = xOf(p);
      parts.push('<text x="' + x.toFixed(2) + '" y="' + (height - 8) + '" text-anchor="middle" font-size="11" fill="#5e564c">$' + compact(p) + '</text>');
    });
    parts.push('</svg>');
    return parts.join('');
  }

  function resultsHtml(model) {
    var burnNow = model.winner.price * A.demandAt(model.knots, model.winner.price);
    var burnMax = model.pStar.burn;
    var efficiency = burnMax > 0 ? burnNow / burnMax : 0;
    return '<div class="hero">' +
      '<article><h2>Selected fee</h2><p class="hero-value" data-testid="selected-fee">' + money(model.winner.price) + '</p>' +
      '<p class="sub" data-testid="selected-revenue">' + money(model.winner.revenue) + ' revenue</p></article>' +
      '<article><h2>Optimal fee</h2><p class="hero-value" data-testid="optimal-fee">' + money(model.pStar.price) + '</p>' +
      '<p class="sub">Causes the max possible revenue of <span data-testid="optimal-burn">' + money(model.pStar.burn) + '</span></p></article>' +
      '<article><h2>Controller efficiency</h2><p class="hero-value" data-testid="efficiency">' + percent(efficiency) + '</p></article>' +
      '</div>' +
      tableHtml(model) +
      bluffHtml(model) +
      honestyHtml(model) +
      '<article class="card chart-card"><h2>Profit and Demand Curves</h2>' + chartSvg(model) +
      '<ul class="legend"><li><i class="swatch"></i> Demand</li><li><i class="swatch burn"></i> REP burn</li>' +
      '<li><i class="swatch arm"></i> Arms</li><li><i class="swatch current"></i> Current fee</li>' +
      '<li><i class="swatch dot"></i> Selected</li><li><i class="swatch diamond"></i> Optimal</li></ul></article>';
  }

  function knotsForCalc() {
    if (!knotTable.querySelector('tbody tr')) return knots;
    var draft = readRows();
    if (draft.incomplete) return knots;
    var norm = A.normalizeKnots(draft.rows);
    return norm.ok ? norm.knots : knots;
  }

  function controllerEfficiency(price, model) {
    var burnMax = model.pStar.burn;
    if (!(burnMax > 0) || !(price > 0)) return 0;
    return price * A.demandAt(model.knots, price) / burnMax;
  }

  /* Efficiency if honest bids stayed at h·D(p) instead of being floor-capped. */
  function efficiencyWithoutHonestCap(model) {
    var arms = model.arms.map(function (arm) {
      var honest = arm.honestRaw;
      var total = honest + arm.shade;
      return {
        id: arm.id,
        label: arm.label,
        price: arm.price,
        honest: honest,
        honestRaw: honest,
        honestCapped: false,
        shade: arm.shade,
        bluff: 0,
        total: total,
        revenue: arm.price * total
      };
    });
    var freeModel = Object.assign({}, model, {
      arms: arms,
      winner: A.pickWinner(arms, model.C)
    });
    var settled = freeModel;
    if (!bluffDisabled) {
      var rational = A.rationalBluffs(arms, model.C, model.pStar.price, model.knots);
      if (rational.length) settled = A.applyBluff(freeModel, rational[0]);
    }
    return controllerEfficiency(settled.winner.price, model);
  }

  function render() {
    var model = A.evaluate({ C: C, h: h, k: k, knots: knotsForCalc() });
    var results = document.getElementById('results');
    document.getElementById('elasticity').textContent = 'e = ' + formatE(k);
    if (!model.ok) {
      results.innerHTML = '<article class="card"><p class="note error">' + esc(model.error) + '</p></article>';
      return;
    }
    model.unbluffedWinner = model.winner;
    var settled = model.bestBluff && !bluffDisabled ? A.applyBluff(model, model.bestBluff) : model;
    winningPrice = Math.max(1, Math.round(settled.winner.price));
    results.innerHTML = resultsHtml(settled);
  }

  function commitQuantities() {
    var draft = readRows();
    if (draft.incomplete) return;
    var norm = A.normalizeKnots(draft.rows);
    if (!norm.ok) {
      showKnotError(norm.error);
      return;
    }
    hideKnotError();
    adoptDisplayed(norm.knots);
    if (norm.clamped) flash('Demand must not rise with price.');
    else if (norm.negative) flash('Demand cannot be negative.');
    else clearNote();
    writeQty(knots);
    render();
  }

  function commitPrices() {
    var draft = readRows();
    if (draft.incomplete) return;
    var norm = A.normalizeKnots(draft.rows);
    if (!norm.ok) {
      showKnotError(norm.error);
      return;
    }
    hideKnotError();
    var active = document.activeElement;
    var activeIndex = active && active.getAttribute ? active.getAttribute('data-index') : null;
    var activeClass = '';
    if (active && active.classList) {
      if (active.classList.contains('knot-qty')) activeClass = 'knot-qty';
      else if (active.classList.contains('knot-price')) activeClass = 'knot-price';
    }
    var orderChanged = norm.knots.length !== knots.length || norm.knots.some(function (knot, index) {
      return !knots[index] || knot.price !== knots[index].price;
    });
    adoptDisplayed(norm.knots);
    if (norm.clamped) flash('Demand must not rise with price.');
    else if (norm.negative) flash('Demand cannot be negative.');
    if (orderChanged || norm.clamped) {
      renderKnots();
      if (activeClass && activeIndex !== null) {
        var field = knotTable.querySelector('.' + activeClass + '[data-index="' + activeIndex + '"]');
        if (field) field.focus();
      }
    }
    render();
  }

  fee.addEventListener('input', function () {
    var value = Number(fee.value);
    if (!(value > 0)) return;
    C = value;
    render();
  });
  document.getElementById('next-month').addEventListener('click', function () {
    C = winningPrice;
    fee.value = formatWhole(C);
    render();
  });

  fee.addEventListener('blur', function () {
    var roundedFee = Math.round(Number(fee.value));
    if (!(roundedFee > 0)) roundedFee = Math.max(1, Math.round(C));
    C = roundedFee;
    fee.value = formatWhole(C);
    render();
  });

  honestRange.addEventListener('input', function () {
    h = Number(honestRange.value) / 100;
    honestNumber.value = honestRange.value;
    render();
  });
  honestNumber.addEventListener('input', function () {
    if (honestNumber.value.trim() === '') return;
    var value = Number(honestNumber.value);
    if (!isFinite(value)) return;
    value = Math.round(Math.min(100, Math.max(0, value)));
    honestNumber.value = String(value);
    h = value / 100;
    honestRange.value = String(value);
    render();
  });

  floorRange.addEventListener('input', function () {
    k = Math.min(0.4999, Math.max(0, Number(floorRange.value)));
    if (document.activeElement !== floorNumber) floorNumber.value = formatPlain(k);
    render();
  });
  floorNumber.addEventListener('input', function () {
    if (floorNumber.value.trim() === '') return;
    var value = Number(floorNumber.value);
    if (!isFinite(value)) return;
    k = Math.min(0.4999, Math.max(0, value));
    floorRange.value = String(k);
    render();
  });
  floorNumber.addEventListener('blur', function () {
    floorNumber.value = formatPlain(k);
  });

  function applyCreatorPercent(percent, fromSlider) {
    percent = Math.min(CREATOR_MAX, Math.max(CREATOR_MIN, percent));
    percent = Math.round(percent * 1000) / 1000;
    var nextFee = percent / 100;
    if (creatorFee > 0 && nextFee > 0 && Math.abs(nextFee - creatorFee) > 1e-15) {
      C = C * (nextFee / creatorFee);
      if (!(C > 0) || !isFinite(C)) C = 1;
      if (document.activeElement !== fee) fee.value = formatWhole(C);
    }
    creatorFee = nextFee;
    if (!fromSlider) creatorRange.value = String(sliderFromCreatorPercent(percent));
    if (document.activeElement !== creatorNumber) creatorNumber.value = formatCreator(percent);
    knots = projectKnots();
    renderKnots();
  }
  creatorRange.addEventListener('input', function () {
    applyCreatorPercent(creatorPercentFromSlider(creatorRange.value), true);
    render();
  });
  creatorNumber.addEventListener('input', function () {
    if (creatorNumber.value.trim() === '') return;
    var value = Number(creatorNumber.value);
    if (!isFinite(value)) return;
    applyCreatorPercent(value, false);
    render();
  });
  creatorNumber.addEventListener('blur', function () {
    creatorNumber.value = formatCreator(creatorFee * 100);
  });

  function setDemandPercent(percent) {
    percent = Math.min(200, Math.max(1, percent));
    demandPercent = percent;
    demandRange.value = String(percent);
    if (document.activeElement !== demandNumber) demandNumber.value = formatWhole(percent);
    knots = projectKnots();
    renderKnots();
  }
  demandRange.addEventListener('input', function () {
    setDemandPercent(Number(demandRange.value));
    render();
  });
  demandNumber.addEventListener('input', function () {
    if (demandNumber.value.trim() === '') return;
    var value = Number(demandNumber.value);
    if (!isFinite(value)) return;
    setDemandPercent(value);
    render();
  });
  demandNumber.addEventListener('blur', function () {
    demandNumber.value = formatWhole(demandPercent);
  });

  function setSensitivityAbove(position) {
    sensitivityAbove = Math.min(100, Math.max(0, Math.round(Number(position))));
    if (!isFinite(sensitivityAbove)) sensitivityAbove = 50;
    sensitivityAboveRange.value = String(sensitivityAbove);
    sensitivityAboveRange.setAttribute('aria-valuetext', sensitivityLabel(sensitivityAbove));
    knots = projectKnots();
    renderKnots();
  }
  function setSensitivityBelow(position) {
    sensitivityBelow = Math.min(100, Math.max(0, Math.round(Number(position))));
    if (!isFinite(sensitivityBelow)) sensitivityBelow = 50;
    sensitivityBelowRange.value = String(sensitivityBelow);
    sensitivityBelowRange.setAttribute('aria-valuetext', sensitivityLabel(sensitivityBelow));
    knots = projectKnots();
    renderKnots();
  }
  sensitivityAboveRange.addEventListener('input', function () {
    setSensitivityAbove(sensitivityAboveRange.value);
    render();
  });
  sensitivityBelowRange.addEventListener('input', function () {
    setSensitivityBelow(sensitivityBelowRange.value);
    render();
  });

  function steppedWhole(value, up, minimum) {
    var current = Math.round(Number(value));
    if (!isFinite(current)) current = minimum;
    var next = Math.round(current * (up ? 1.1 : 1 / 1.1));
    if (next === current) next = current + (up ? 1 : -1);
    if (next < minimum) next = minimum;
    return next;
  }

  function stepKnotField(input, up) {
    var minimum = input.classList.contains('knot-price') ? 1 : 0;
    input.value = String(steppedWhole(input.value, up, minimum));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  knotTable.addEventListener('keydown', function (event) {
    var input = event.target;
    if (!input.classList) return;
    if (!input.classList.contains('knot-price') && !input.classList.contains('knot-qty')) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    stepKnotField(input, event.key === 'ArrowUp');
  });

  knotTable.addEventListener('mousedown', function (event) {
    var input = event.target;
    if (!input.classList) return;
    if (!input.classList.contains('knot-price') && !input.classList.contains('knot-qty')) return;
    if (event.offsetX < input.clientWidth - 20) return;
    event.preventDefault();
    stepKnotField(input, event.offsetY < input.clientHeight / 2);
    input.focus();
  });

  knotTable.addEventListener('input', function (event) {
    var input = event.target;
    if (input.classList.contains('knot-qty')) {
      commitQuantities();
      return;
    }
    if (input.classList.contains('knot-price')) {
      var draft = readRows();
      if (draft.incomplete) return;
      var norm = A.normalizeKnots(draft.rows);
      if (!norm.ok) {
        showKnotError(norm.error);
        return;
      }
      hideKnotError();
      render();
    }
  });

  knotTable.addEventListener('focusout', function (event) {
    var input = event.target;
    if (!input.classList) return;
    if (input.classList.contains('knot-qty')) {
      var index = Number(input.getAttribute('data-index'));
      if ((input.value.trim() === '' || !isFinite(Number(input.value))) && knots[index]) {
        input.value = formatWhole(knots[index].qty);
        hideKnotError();
      }
      return;
    }
    if (!input.classList.contains('knot-price')) return;
    clearTimeout(priceCommit);
    priceCommit = setTimeout(commitPrices, 0);
  });

  knotTable.addEventListener('click', function (event) {
    var button = event.target.closest('[data-remove]');
    if (!button || button.disabled) return;
    clearTimeout(priceCommit);
    var draft = readRows();
    var norm = draft.incomplete ? null : A.normalizeKnots(draft.rows);
    var list = norm && norm.ok ? norm.knots : knots.map(function (knot) { return { price: knot.price, qty: knot.qty }; });
    if (list.length <= 2) return;
    list.splice(Number(button.getAttribute('data-remove')), 1);
    var again = A.normalizeKnots(list);
    adoptDisplayed(again.ok ? again.knots : list);
    hideKnotError();
    if (again.clamped) flash('Demand must not rise with price.');
    else clearNote();
    renderKnots();
    render();
  });

  document.getElementById('add-knot').addEventListener('click', function () {
    clearTimeout(priceCommit);
    commitPrices();
    var last = baseKnots[baseKnots.length - 1];
    var price = last.price * 1.5;
    var guard = 0;
    while (baseKnots.some(function (knot) { return knot.price === price; }) && guard < 8) {
      price *= 1.5;
      guard += 1;
    }
    var norm = A.normalizeKnots(baseKnots.concat([{ price: price, qty: last.qty }]));
    baseKnots = norm.knots;
    knots = projectKnots();
    hideKnotError();
    renderKnots();
    render();
  });

  document.getElementById('sort-knots').addEventListener('click', function () {
    clearTimeout(priceCommit);
    var draft = readRows();
    if (draft.incomplete) return;
    var norm = A.normalizeKnots(draft.rows);
    if (!norm.ok) {
      showKnotError(norm.error);
      return;
    }
    hideKnotError();
    adoptDisplayed(norm.knots);
    if (norm.clamped) flash('Demand must not rise with price.');
    else clearNote();
    renderKnots();
    render();
  });

  function loadPreset(next) {
    clearTimeout(priceCommit);
    C = next.C;
    h = next.h;
    k = next.k;
    var creatorPercent = next.creatorPercent == null ? 1 : next.creatorPercent;
    creatorFee = creatorPercent / 100;
    demandPercent = 10;
    sensitivityAbove = 50;
    sensitivityBelow = 50;
    bluffDisabled = false;
    baseKnots = A.cloneKnots(next.knots);
    knots = projectKnots();
    fee.value = formatWhole(C);
    honestRange.value = String(Math.round(h * 100));
    honestNumber.value = String(Math.round(h * 100));
    floorRange.value = String(k);
    floorNumber.value = k.toFixed(2);
    creatorRange.value = String(sliderFromCreatorPercent(creatorPercent));
    creatorNumber.value = formatCreator(creatorPercent);
    demandRange.value = '10';
    demandNumber.value = '10';
    sensitivityAboveRange.value = '50';
    sensitivityAboveRange.setAttribute('aria-valuetext', 'neutral');
    sensitivityBelowRange.value = '50';
    sensitivityBelowRange.setAttribute('aria-valuetext', 'neutral');
    clearNote();
    hideKnotError();
    renderKnots();
    render();
  }

  document.getElementById('preset-poly').addEventListener('click', function () {
    clearTimeout(priceCommit);
    sensitivityAbove = 50;
    sensitivityBelow = 50;
    sensitivityAboveRange.value = '50';
    sensitivityAboveRange.setAttribute('aria-valuetext', 'neutral');
    sensitivityBelowRange.value = '50';
    sensitivityBelowRange.setAttribute('aria-valuetext', 'neutral');
    baseKnots = A.cloneKnots(A.PRESETS.polymarket.knots);
    knots = projectKnots();
    clearNote();
    hideKnotError();
    renderKnots();
    render();
  });
  document.getElementById('preset-toy').addEventListener('click', function () {
    loadPreset(A.PRESETS.polymarket);
  });

  document.getElementById('results').addEventListener('change', function (event) {
    if (event.target.id !== 'disable-bluff') return;
    bluffDisabled = event.target.checked;
    render();
  });

  creatorRange.value = String(sliderFromCreatorPercent(creatorFee * 100));
  creatorNumber.value = formatCreator(creatorFee * 100);
  renderKnots();
  render();
})();
