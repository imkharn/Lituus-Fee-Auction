# Query Token auction

A one-round calculator for a four-arm Query Token auction. It is a static page: HTML, CSS, and vanilla JavaScript. There is no backend, no account, and no tracking. The auction does not move the center into a second round; it only previews what that next center would be.

## Run it

Open `index.html` in a browser, or serve the folder:

```bash
node auction.test.js
python -m http.server 5173
```

The test command checks the toy example. The server command is only for local preview. GitHub Pages serves the same files with no build step.

## GitHub Pages

1. Push this folder to a GitHub repository.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select the `main` branch and the `/ (root)` folder, then save.
5. The site is published at `https://<user>.github.io/<repo>/`.

`.nojekyll` is included so GitHub Pages serves the files as-is.

## The round

The state is a current query fee `C > 0`. Bidders may report only at four prices:

| Arm | Price |
| --- | --- |
| Half | `0.5 C` |
| Near-low | `C / 1.1` |
| Near-high | `1.1 C` |
| Double | `2 C` |

True demand `D(p)` is a price table, not a formula. Between prices the curve is log-linear in both price and demand (constant elasticity). A segment that touches zero demand is linear in demand along log price, because log demand is undefined at zero. Outside either end price, the curve continues that end segment, and demand is never negative.

The optimal fee, shown for comparison, maximizes burn `p · D(p)` on a 200-price log grid from one sixteenth of the lowest listed price to sixteen times the highest, with every listed price included so a kink is not missed. A constant reporter cost would not change the maximizing price, so the page leaves it out.

The stored curve is the demand at a market creator fee of 1% of open interest per month. The slider is logarithmic and rewrites every price in the table in proportion to the chosen fee, and the auction uses those prices, so the optimal query fee moves with the slider. Scaling every quantity by the same constant would leave the optimal fee where it is.

A fraction `h` of demand is honest and reports `h · D(p)` at each arm. The rest shades: all of that demand is placed on the cheapest arm, and higher arms sit on the floor below. The reported book is the sum. The selected fee is the arm with the largest revenue `p · Q`. Revenues within $0.0001 are a tie. Ties go to the arm closer to `C`, then to the lower price.

The controller has to leave the current fee and land on one of the four arms. A round works when the selected arm is the one closest to the optimal fee, even when every arm is farther from that fee than the current price is. The honesty threshold is the smallest honest share, on a 0.1% grid and with no bluff-caller, at which that closest arm wins.

## Floor

`k` in `[0, 0.4999]` is the minimum share of quantity a report may keep when price doubles. For `k > 0` the elasticity is

```text
e = −ln(k) / ln(2)
```

For any prices `p < p′` a legal report satisfies

```text
q(p′) ≥ q(p) · (p′ / p)^(−e)
```

On an exact doubling that lower bound is `k · q(p)`. The protocol lifts an illegal high-arm report up to the floor, separately for the honest type and the shading type. Reports may rise with price. `k = 0` means there is no floor, so a shader may report zero on every arm above the cheapest.

If true demand falls faster than this floor, the page warns that honest reports will be lifted.

## Shade

With cheapest arm `pL`:

```text
q_s(pL) = (1 − h) · D(pL)
q_s(p)  = q_s(pL) · (p / pL)^(−e)    for p > pL
```

When `k = 0`, `q_s(p) = 0` for `p > pL`.

## Bluff-caller

The bluff-caller stands outside the book and may add quantity on one target arm, with zero on every cheaper arm. Only an arm strictly closer to `p*` than `C` is eligible. The extra quantity is the least that puts the target at least $0.01 of revenue ahead of every other arm. An arm that already leads by that margin needs no extra quantity.

They resell at `p*` when that fee is above the arm. Profit is `(resale − arm price) · quantity`. A call is taken only when the arm is above the shaded winner and below `p*`, and both profit and spend are positive. The caller picks the price with the most profit. That bid is added to the book, so the selected fee moves.

## Toy example

The page opens on the Polymarket open-interest curve, current fee `$40`, honest share `50%`, minimum demand per doubling `0.40`, creator fee `0.07%` of open interest per month, and `100%` of the Polymarket quantities. At a 1% creator fee that curve peaks at `$600`. At `0.07%` the peak is `$42`.

The toy book is still available from Reset toy example: `C = $40`, honest share `0`, creator fee `1%`, and prices `$10 → 1000`, `$20 → 800`, `$40 → 500`, `$80 → 200` queries per month. That book peaks at `$40`.

At full shade the arm revenues are `$16,000.00`, `$13,198.83`, `$12,413.22`, and `$10,240.00`. Half (`$20`) wins. Peak burn is `$20,000` at `$40`. The current fee is already the optimum, so every arm is farther from it, and the closest arm the controller can reach is Near-low (`$36.36`). That arm wins at **45.3%** honest. A rough 42% figure is that same threshold.

A caller who forces Near-low to win at full shade needs about **77.03** queries, spends about **$2,801.18**, and resells at `$40` for a 10% ROI and about `$280` of profit. That call shows up even though the current fee is already `$40`: the shaded book would otherwise select `$20`.

## Polymarket-like preset

The preset button loads a decreasing open-interest shape, sets `C = $800`, `h = 0`, and `k = 0.40`. Peak burn on that curve is `$2,640,000` at `$600`.

## Tests

```bash
node auction.test.js
```
