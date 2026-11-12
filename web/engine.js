/*
 * TechMart Product Assistant — retrieval & reasoning engine (browser + Node).
 * Faithful JS port of the design in docs/SPEC.md:
 *   query parsing -> QueryPlan -> hard filters (with relaxation) -> BM25 + use-case spec scoring
 *   -> ranked products with `why` reasons -> prompt builder / offline templated answer.
 * No dependencies. Works as a browser global (window.TechMartEngine) and as CommonJS.
 */
(function (root) {
  'use strict';

  var CATEGORIES = ['Laptop', 'Smartphone', 'Tablet', 'Earbuds', 'Headset', 'Smartwatch', 'Speaker', 'Monitor'];
  var STARTER_IDS = ['P01', 'P02', 'P03', 'P04'];
  var DEFAULT_MODEL = 'claude-haiku-5-5';

  var STOPWORDS = new Set((
    'a an the and or of for to in on with without is are be was were it its this that these those i me my we you your ' +
    'do does did have has had can could should would will what which who whom how why when where any some there their ' +
    'than then them they at by from as about into get got need want looking look find show tell give me please good best ' +
    'great enough under below less within upto up max maximum budget above over more between rs inr price cost costs ' +
    'around much many most also just like really very one ones something anything thing things sell carry stock available buy ' +
    'recommend suggest whats'
  ).split(/\s+/));

  // ---------------------------------------------------------------- helpers
  function inr(n) {
    if (n == null || isNaN(n)) return '';
    var s = String(Math.round(n));
    var neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    var last3 = s.slice(-3);
    var rest = s.slice(0, -3);
    if (rest) rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return (neg ? '-' : '') + '₹' + (rest ? rest + ',' + last3 : last3);
  }

  function stem(t) {
    if (t.length > 3 && /s$/.test(t) && !/ss$/.test(t)) return t.slice(0, -1);
    return t;
  }

  function tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(function (t) { return t && !STOPWORDS.has(t); })
      .map(stem);
  }

  function round(x, d) { var m = Math.pow(10, d == null ? 3 : d); return Math.round(x * m) / m; }

  function uniq(arr) { return arr.filter(function (x, i) { return arr.indexOf(x) === i; }); }

  function joinNatural(items) {
    if (items.length <= 1) return items.join('');
    if (items.length === 2) return items[0] + ' and ' + items[1];
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  function attr(p, key) { return p.attributes ? p.attributes[key] : undefined; }

  function docText(p) { return [p.name, p.category, p.brand, p.specs, p.description].join(' '); }

  function cpuScore(cpu) {
    if (!cpu) return null;
    var c = String(cpu).toLowerCase();
    if (/\bi9\b|ryzen 9|ultra 9|\bm\d+ (max|ultra)\b/.test(c)) return 1.0;
    if (/\bi7\b|ryzen 7|ultra 7|\bm\d+ pro\b/.test(c)) return 0.85;
    if (/\bi5\b|ryzen 5|ultra 5|\bm\d+\b/.test(c)) return 0.6;
    if (/\bi3\b|ryzen 3/.test(c)) return 0.3;
    return 0.5;
  }

  function waterScore(w) {
    if (!w) return 0;
    var s = String(w).toLowerCase();
    var m = s.match(/ip[x\d](\d)/);
    if (m) return parseInt(m[1], 10);
    m = s.match(/(\d+)\s*atm/);
    if (m) return Math.min(9, 5 + parseInt(m[1], 10) / 5); // 5ATM ~ 6, 10ATM ~ 7
    return 1;
  }

  function resolutionScore(r) {
    if (!r) return null;
    var m = String(r).match(/(\d+)\s*x\s*(\d+)/);
    return m ? parseInt(m[1], 10) * parseInt(m[2], 10) : null;
  }

  function storageLabel(gb) { return gb >= 1024 ? (gb / 1024) + 'TB' : gb + 'GB'; }

  // ---------------------------------------------------------------- attributes used by spec scoring
  // dir: +1 higher is better, -1 lower is better. fmt: human label used in `why`.
  var ATTRS = {
    ram:     { label: 'RAM', dir: 1, get: function (p) { return attr(p, 'ram_gb'); }, fmt: function (p) { return attr(p, 'ram_gb') + 'GB RAM'; } },
    gpu:     { label: 'GPU', dir: 1, get: function (p) { var t = attr(p, 'gpu_tier'); return t == null ? (attr(p, 'gpu') ? 1 : (p.category === 'Laptop' ? 0 : null)) : t; },
               fmt: function (p) { return attr(p, 'gpu') ? attr(p, 'gpu') + ' GPU' : 'integrated graphics'; } },
    storage: { label: 'storage', dir: 1, get: function (p) { return attr(p, 'storage_gb'); }, fmt: function (p) { return storageLabel(attr(p, 'storage_gb')) + (p.category === 'Laptop' ? ' SSD' : ' storage'); } },
    cpu:     { label: 'CPU', dir: 1, get: function (p) { return cpuScore(attr(p, 'cpu')); }, fmt: function (p) { return attr(p, 'cpu'); } },
    refresh: { label: 'refresh rate', dir: 1, get: function (p) { return attr(p, 'refresh_hz'); }, fmt: function (p) { return attr(p, 'refresh_hz') + 'Hz display'; } },
    battery: { label: 'battery life', dir: 1, get: function (p) { return attr(p, 'battery_hr'); }, fmt: function (p) {
                 var h = attr(p, 'battery_hr'); return (h >= 72 && p.category === 'Smartwatch') ? Math.round(h / 24) + '-day battery' : h + 'hr battery'; } },
    weight:  { label: 'weight', dir: -1, best: 'lightest', get: function (p) { return attr(p, 'weight_kg'); }, fmt: function (p) { return attr(p, 'weight_kg') + ' kg'; } },
    price:   { label: 'price', dir: -1, best: 'lowest', get: function (p) { return p.price; }, fmt: function (p) { return inr(p.price); } },
    anc:     { label: 'noise cancellation', dir: 1, get: function (p) { var a = attr(p, 'anc'); return a == null ? null : (a ? 1 : 0); }, fmt: function (p) { return attr(p, 'anc') ? 'ANC' : 'no ANC'; } },
    water:   { label: 'water resistance', dir: 1, get: function (p) {
                 var a = p.attributes || {}; if (!('water_resistance' in a)) return null; return waterScore(a.water_resistance); },
               fmt: function (p) { var w = attr(p, 'water_resistance'); return w ? w + ' water resistance' : 'no water rating'; } },
    resolution: { label: 'resolution', dir: 1, get: function (p) { return resolutionScore(attr(p, 'resolution')); }, fmt: function (p) {
                 var r = attr(p, 'resolution'); return ({ '3840x2160': '4K', '2560x1440': 'QHD', '1920x1080': 'Full HD' })[r] || r; } },
    color:   { label: 'colour accuracy', dir: 1, get: function (p) { return attr(p, 'color_gamut_srgb'); }, fmt: function (p) { return attr(p, 'color_gamut_srgb') + '% sRGB'; } }
  };

  // ---------------------------------------------------------------- use cases
  // Laptop weights are straight from the SPEC. Monitor-only attributes (resolution/color) are
  // dropped automatically for laptops because no laptop has them (weights renormalised).
  var USE_CASES = [
    { id: 'video_editing', label: 'video editing', re: /video[\s-]*edit|\bediting\b|\bedit videos?\b|premiere|\brender|content creat|davinci|final cut|colou?r grad/,
      weights: { ram: 0.35, gpu: 0.35, storage: 0.15, cpu: 0.15, resolution: 0.3, color: 0.3 } },
    { id: 'gaming', label: 'gaming', re: /gaming|\bgames?\b|\bgamer|\baaa\b|\besports?\b/,
      weights: { gpu: 0.45, ram: 0.25, refresh: 0.15, cpu: 0.15 } },
    { id: 'coding', label: 'coding', re: /coding|\bcode\b|programm|developer|software dev|\bdev work\b/,
      weights: { ram: 0.45, cpu: 0.30, storage: 0.10, battery: 0.15 } },
    { id: 'student', label: 'students', re: /student|college|\bstudy|\bstudies|school|universit|\bclasses\b/,
      weights: { price: 0.35, battery: 0.30, weight: 0.20, ram: 0.15 } },
    { id: 'travel', label: 'travel', re: /travel|commut|flight|\btrips?\b|on the go/,
      weights: { battery: 0.45, weight: 0.30, anc: 0.25 } },
    { id: 'workout', label: 'workouts', re: /workout|\bgym\b|running|\bruns?\b|sports?\b|exercise|fitness|swim/,
      weights: { water: 0.5, battery: 0.3, price: 0.2 } }
  ];

  var CATEGORY_SYNONYMS = [
    { re: /\blaptops?\b|\bnotebooks?\b|\bultrabooks?\b/, cats: ['Laptop'] },
    { re: /\bsmart\s?phones?\b|\bphones?\b|\bmobiles?\b|\bcell\s?phones?\b/, cats: ['Smartphone'] },
    { re: /\btablets?\b|\bipads?\b|\btabs?\b/, cats: ['Tablet'] },
    { re: /\bear\s?buds?\b|\bearphones?\b|\btws\b|\bin[\s-]ear\b|\bbuds\b/, cats: ['Earbuds'] },
    { re: /\bheadsets?\b|\bover[\s-]ear\b|\bon[\s-]ear\b/, cats: ['Headset'] },
    { re: /\bhead\s?phones?\b/, cats: ['Headset', 'Earbuds'] },
    { re: /\bspeakers?\b|\bsound\s?bars?\b/, cats: ['Speaker'] },
    { re: /\bsmart\s?watch(es)?\b|\bwatch(es)?\b(?!\s+(videos?|movies?|shows?|netflix|films?))|\bfitness bands?\b|\bbands?\b/, cats: ['Smartwatch'] },
    { re: /\bmonitors?\b/, cats: ['Monitor'] }
  ];
  var WEAK_MONITOR_RE = /\bdisplays?\b|\bscreens?\b/; // only counts if nothing else matched
  // Tokens already consumed by structured parsing (category / feature / boost words) are not re-scored by BM25,
  // otherwise e.g. "wireless" would reward products that merely repeat the word in their copy.
  var STRUCTURAL_TOKENS = new Set(('laptop notebook ultrabook phone smartphone smart mobile cell tablet ipad tab earbud earphone tws ' +
    'in ear headset over on headphone speaker soundbar sound bar watch smartwatch fitness monitor wireless bluetooth cordless ' +
    'battery life long longest lasting anc noise cancelling canceling cancellation cheap cheapest affordable inexpensive').split(' ').map(stem));

  // ---------------------------------------------------------------- query parsing
  var CUR = '(₹|rs\\.?|inr)?';
  var AMT = CUR + '\\s*(\\d+(?:,\\d+)*(?:\\.\\d+)?)\\s*(k|lakhs?|lacs?|l)?(?![a-z0-9])';

  function toAmount(cur, num, suf) {
    var n = parseFloat(String(num).replace(/,/g, ''));
    if (isNaN(n)) return null;
    if (suf) {
      suf = suf.toLowerCase();
      if (suf === 'k') n *= 1000; else n *= 100000;
    } else if (!cur && n < 500) {
      return null; // "under 2" / "15 inch" are not prices
    }
    return Math.round(n);
  }

  function parsePrice(q) {
    var out = { price_min: null, price_max: null, spans: [] };
    var m, re;
    re = new RegExp('\\bbetween\\s+' + AMT + '\\s+(?:and|to|-)\\s+' + AMT, 'i');
    if ((m = q.match(re))) {
      var a = toAmount(m[1], m[2], m[3] || m[6]), b = toAmount(m[4] || m[1], m[5], m[6]);
      if (a != null && b != null) {
        out.price_min = Math.min(a, b); out.price_max = Math.max(a, b); out.spans.push(m[0]);
        return out;
      }
    }
    re = new RegExp('(?:\\b(?:under|below|less than|lesser than|within|upto|up to|max(?:imum)?|budget(?:\\s+(?:of|is))?|cheaper than|not more than|no more than|at most|in the range of)|<=?)\\s*(?:of\\s+|is\\s+|around\\s+|about\\s+)?' + AMT, 'i');
    if ((m = q.match(re))) {
      var mx = toAmount(m[1], m[2], m[3]);
      if (mx != null) { out.price_max = mx; out.spans.push(m[0]); }
    }
    re = new RegExp('(?:\\b(?:above|over|more than|at least|minimum|min|starting(?:\\s+(?:at|from))?)|>=?)\\s*' + AMT, 'i');
    if ((m = q.match(re))) {
      var mn = toAmount(m[1], m[2], m[3]);
      if (mn != null) { out.price_min = mn; out.spans.push(m[0]); }
    }
    if (out.price_max == null && out.price_min == null) {
      // bare currency amount, e.g. "laptop ₹70,000" or "70k laptop" -> treat as budget ceiling
      re = new RegExp('(₹|rs\\.?|inr)\\s*(\\d+(?:,\\d+)*(?:\\.\\d+)?)\\s*(k|lakhs?|lacs?|l)?(?![a-z0-9])|\\b(\\d+(?:\\.\\d+)?)\\s*(k|lakhs?|lacs?)(?![a-z0-9])', 'i');
      if ((m = q.match(re))) {
        var v = m[2] ? toAmount(m[1], m[2], m[3]) : toAmount(null, m[4], m[5]);
        if (v != null) { out.price_max = v; out.spans.push(m[0]); }
      }
    }
    return out;
  }

  function findPinned(qLower, products) {
    var hits = [];
    var bestLen = 0;
    products.forEach(function (p) {
      var name = p.name.toLowerCase();
      var len = 0;
      if (qLower.indexOf(name) !== -1) {
        len = name.split(/\s+/).length + 10; // exact full name match beats any partial
      } else {
        var toks = name.split(/\s+/);
        // drop trailing tokens one by one; a prefix needs >= 2 tokens to count as a mention
        for (var n = toks.length - 1; n >= 2; n--) {
          var prefix = toks.slice(0, n).join(' ');
          var re = new RegExp('\\b' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
          if (re.test(qLower)) { len = n; break; }
        }
      }
      if (len > 0) {
        if (len > bestLen) { bestLen = len; hits = [p]; }
        else if (len === bestLen) hits.push(p);
      }
    });
    return hits.map(function (p) { return p.id; });
  }

  function parseQuery(question, products) {
    var q = String(question || '');
    var ql = q.toLowerCase().replace(/\s+/g, ' ').trim();
    var price = parsePrice(ql);

    var categories = [];
    CATEGORY_SYNONYMS.forEach(function (s) {
      if (s.re.test(ql)) s.cats.forEach(function (c) { if (categories.indexOf(c) === -1) categories.push(c); });
    });
    if (!categories.length && WEAK_MONITOR_RE.test(ql)) categories.push('Monitor');

    var useCase = null;
    for (var i = 0; i < USE_CASES.length; i++) {
      if (USE_CASES[i].re.test(ql)) { useCase = USE_CASES[i]; break; }
    }

    var boosts = {};
    if (/\bbattery\b|battery life|long[\s-]lasting|backup/.test(ql)) boosts.battery = 0.4;
    if (/\bcheap(est)?\b|\baffordable\b|\bbudget\b(?!\s*(of|is)?\s*(₹|rs|\d))|\binexpensive\b|\bvalue for money\b/.test(ql) && price.price_max == null) boosts.price = 0.4;
    if (/\blight(weight|est)?\b|\bportable\b/.test(ql)) boosts.weight = 0.3;
    if (/\bnoise[\s-]cancel|\banc\b/.test(ql)) boosts.anc = 0.3;
    if (/\bwaterproof|water[\s-]resistant|sweat/.test(ql)) boosts.water = 0.4;

    var weights = {};
    if (useCase) Object.keys(useCase.weights).forEach(function (k) { weights[k] = useCase.weights[k]; });
    Object.keys(boosts).forEach(function (k) { weights[k] = (weights[k] || 0) + boosts[k]; });

    var stripped = ql;
    price.spans.forEach(function (s) { stripped = stripped.replace(s, ' '); });
    // use-case trigger words are consumed by the spec profile; leaving them in BM25 lets marketing copy
    // ("great for watching videos") outrank actual specs, so strip them like the price span.
    if (useCase) stripped = stripped.replace(new RegExp('(?:' + useCase.re.source + ')[a-z]*', 'g'), ' ');
    var keywords = uniq(tokenize(stripped).filter(function (t) { return !/^\d+$/.test(t) && !STRUCTURAL_TOKENS.has(t); }));

    return {
      categories: categories,
      price_max: price.price_max,
      price_min: price.price_min,
      use_case: useCase ? useCase.id : null,
      use_case_label: useCase ? useCase.label : null,
      need_wireless: /\bwireless\b|\bbluetooth\b|\btws\b|\bcordless\b/.test(ql),
      need_anc: /\bnoise[\s-]cancel(l)?(ing|ation)?\b|\banc\b/.test(ql),
      keywords: keywords,
      pinned_ids: findPinned(ql, products || []),
      boosts: boosts,
      weights: weights
    };
  }

  // ---------------------------------------------------------------- BM25
  function buildIndex(products) {
    var docs = products.map(function (p) { return tokenize(docText(p)); });
    var df = {};
    docs.forEach(function (d) { uniq(d).forEach(function (t) { df[t] = (df[t] || 0) + 1; }); });
    var avgdl = docs.reduce(function (s, d) { return s + d.length; }, 0) / Math.max(1, docs.length);
    var byId = {};
    products.forEach(function (p, i) { byId[p.id] = docs[i]; });
    return { byId: byId, df: df, N: docs.length, avgdl: avgdl };
  }

  function bm25(index, qTokens, p, k1, b) {
    k1 = k1 == null ? 1.5 : k1; b = b == null ? 0.75 : b;
    var doc = index.byId[p.id] || [];
    var tf = {};
    doc.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
    var score = 0, matched = [];
    qTokens.forEach(function (t) {
      var f = tf[t];
      if (!f) return;
      var n = index.df[t] || 0;
      var idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * doc.length / index.avgdl));
      matched.push(t);
    });
    return { score: score, matched: matched };
  }

  // ---------------------------------------------------------------- spec scoring
  function activeProfile(weights, cands) {
    var prof = [];
    var total = 0;
    Object.keys(weights).forEach(function (k) {
      var A = ATTRS[k];
      if (!A) return;
      var vals = cands.map(A.get).filter(function (v) { return v != null && !isNaN(v); });
      if (!vals.length) return;
      prof.push({ key: k, weight: weights[k], min: Math.min.apply(null, vals), max: Math.max.apply(null, vals), n: vals.length });
      total += weights[k];
    });
    prof.forEach(function (a) { a.weight = total ? a.weight / total : 0; });
    prof.sort(function (a, b) { return b.weight - a.weight; });
    return prof;
  }

  function normAttr(a, p) {
    var v = ATTRS[a.key].get(p);
    if (v == null || isNaN(v)) return 0;
    var x = a.max === a.min ? 1 : (v - a.min) / (a.max - a.min);
    return ATTRS[a.key].dir < 0 ? (a.max === a.min ? 1 : 1 - x) : x;
  }

  function isBest(a, p) {
    var v = ATTRS[a.key].get(p);
    if (v == null || a.max === a.min || a.n < 2) return false;
    return ATTRS[a.key].dir < 0 ? v === a.min : v === a.max;
  }

  function specScore(profile, p) {
    return profile.reduce(function (s, a) { return s + a.weight * normAttr(a, p); }, 0);
  }

  // ---------------------------------------------------------------- retrieval
  function catLabel(cats) { return cats.length ? cats.join(' / ') : 'all'; }

  function retrieve(question, products, opts) {
    opts = opts || {};
    var k = opts.k || 5;
    var plan = parseQuery(question, products);
    var index = buildIndex(products);
    var funnel = [{ label: 'Catalog', count: products.length }];
    var pinned = products.filter(function (p) { return plan.pinned_ids.indexOf(p.id) !== -1; });

    var cats = plan.categories.slice();
    var inferredCats = false;
    if (!cats.length && pinned.length) {
      cats = uniq(pinned.map(function (p) { return p.category; }));
      inferredCats = true;
    }
    var hasProfile = Object.keys(plan.weights).length > 0;
    var mode = (cats.length || plan.use_case || pinned.length || hasProfile) ? 'structured' : 'bm25_fallback';

    var cands = products.slice();
    if (cats.length) {
      cands = cands.filter(function (p) { return cats.indexOf(p.category) !== -1; });
      funnel.push({ label: 'Category: ' + catLabel(cats) + (inferredCats ? ' (from named product)' : ''), count: cands.length });
    }
    var afterCat = cands;

    function priceOk(p) {
      return (plan.price_max == null || p.price <= plan.price_max) && (plan.price_min == null || p.price >= plan.price_min);
    }
    var excluded = [];
    if (plan.price_max != null || plan.price_min != null) {
      excluded = afterCat.filter(function (p) { return !priceOk(p); });
      cands = cands.filter(priceOk);
      var lbl = plan.price_min != null && plan.price_max != null ? 'Price ' + inr(plan.price_min) + '–' + inr(plan.price_max)
        : plan.price_max != null ? 'Price ≤ ' + inr(plan.price_max) : 'Price ≥ ' + inr(plan.price_min);
      funnel.push({ label: lbl, count: cands.length });
    }
    function featureOk(p) {
      if (plan.need_wireless && attr(p, 'wireless') === false) return false;
      if (plan.need_anc && attr(p, 'anc') !== true) return false;
      return true;
    }
    if (plan.need_wireless || plan.need_anc) {
      cands = cands.filter(featureOk);
      funnel.push({ label: [plan.need_wireless ? 'Wireless' : null, plan.need_anc ? 'ANC' : null].filter(Boolean).join(' + '), count: cands.length });
    }

    var relaxed = false;
    if (!cands.length && afterCat.length && (plan.price_max != null || plan.price_min != null)) {
      relaxed = true;
      cands = afterCat.filter(featureOk);
      if (!cands.length) cands = afterCat.slice();
      excluded = [];
      funnel.push({ label: 'Relaxed: price filter dropped', count: cands.length, relaxed: true });
    }

    var qTokens = plan.keywords;
    var raw = {};
    cands.forEach(function (p) { raw[p.id] = bm25(index, qTokens, p); });

    if (mode === 'bm25_fallback') {
      if (qTokens.length) cands = cands.filter(function (p) { return raw[p.id].score > 0; });
      funnel.push({ label: 'BM25 keyword match', count: cands.length });
    }

    var maxBm = 0;
    cands.forEach(function (p) { maxBm = Math.max(maxBm, raw[p.id].score); });
    var weights = plan.weights;
    if (relaxed && plan.price_max != null) { // nothing fits the budget: lean towards the closest (cheapest) options
      weights = {};
      Object.keys(plan.weights).forEach(function (k2) { weights[k2] = plan.weights[k2]; });
      weights.price = (weights.price || 0) + 0.6;
    }
    var profile = activeProfile(weights, cands);

    var scored = cands.map(function (p) {
      var bmNorm = maxBm > 0 ? raw[p.id].score / maxBm : 0;
      var spec = profile.length ? specScore(profile, p) : null;
      var score = profile.length ? 0.6 * spec + 0.4 * bmNorm : bmNorm;
      var isPinned = plan.pinned_ids.indexOf(p.id) !== -1;
      return {
        product: p,
        score: round(score),
        spec_score: spec == null ? null : round(spec),
        bm25: round(raw[p.id].score),
        bm25_norm: round(bmNorm),
        matched: raw[p.id].matched,
        pinned: isPinned,
        why: buildWhy(p, profile, plan, raw[p.id].matched, isPinned, relaxed)
      };
    });
    scored.sort(function (a, b) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.product.price - b.product.price;
    });
    var top = scored.slice(0, k);
    funnel.push({ label: 'Top-k (k=' + k + ')', count: top.length });

    // Over-budget products in the requested category, closest to the budget first.
    var excl = excluded.slice().sort(function (a, b) { return a.price - b.price; }).map(function (p) {
      var reason = plan.price_max != null && p.price > plan.price_max ? 'over budget (' + inr(p.price) + ' > ' + inr(plan.price_max) + ')'
        : 'below minimum price (' + inr(p.price) + ' < ' + inr(plan.price_min) + ')';
      return { product: p, reason: reason };
    });

    return {
      plan: plan,
      categories_used: cats,
      mode: mode,
      relaxed: relaxed,
      funnel: funnel,
      profile: profile.map(function (a) { return { key: a.key, label: ATTRS[a.key].label, weight: round(a.weight, 2) }; }),
      candidates_count: cands.length,
      results: top,
      all_ranked: scored,
      excluded: excl
    };
  }

  function buildWhy(p, profile, plan, matched, isPinned, relaxed) {
    var why = [];
    if (isPinned) why.push('Named in your question');
    profile.forEach(function (a) {
      if (a.weight < 0.1) return;
      var A = ATTRS[a.key];
      if (A.get(p) == null) return;
      var s = A.fmt(p);
      if (isBest(a, p)) s += ' (' + (A.best || 'best') + ' in set)';
      why.push(s);
    });
    if (!relaxed) {
      if (plan.price_max != null && p.price <= plan.price_max) why.push(inr(p.price) + ' ≤ ' + inr(plan.price_max));
      else if (plan.price_min != null && p.price >= plan.price_min) why.push(inr(p.price) + ' ≥ ' + inr(plan.price_min));
    }
    if (plan.need_wireless && attr(p, 'wireless')) why.push('Wireless');
    if (plan.need_anc && attr(p, 'anc') && !profile.some(function (a) { return a.key === 'anc'; })) why.push('ANC');
    var kw = matched.filter(function (t) { return !/^(laptop|smartphone|phone|tablet|earbud|headset|smartwatch|speaker|monitor|wireles|headphone|battery|life)$/.test(t); });
    if (kw.length) why.push('Matches “' + kw.slice(0, 3).join('”, “') + '”');
    if (!profile.length && why.length < 3) {
      String(p.specs).split(',').slice(0, 2).forEach(function (s) { why.push(s.trim()); });
    }
    if (p.in_stock === false) why.push('Out of stock');
    return why;
  }

  // ---------------------------------------------------------------- prompt builder
  var SYSTEM_PROMPT_BASE = [
    'You are the TechMart Product Assistant for an electronics retailer in India.',
    'Rules:',
    '- Answer ONLY from the products in CATALOG CONTEXT. Never invent products, specs, prices, stock or features.',
    '- Always cite product names with their price in INR (e.g. ₹68,990).',
    '- If the question cannot be answered from the context, say it is not in our catalog.',
    '- Respect the customer\'s constraints (budget, category, features).',
    '- For recommendation questions give ONE clear pick with the reason (tie it to the specs that matter for the use case), plus an optional runner-up. Do not just list everything.',
    '- If better-spec products were excluded by the budget, mention that briefly.',
    '- Be concise: under 150 words, simple markdown (bold, short bullet lists).'
  ].join('\n');

  function productLine(p, r) {
    var line = p.id + ' | ' + p.name + ' | ' + p.category + ' | ' + inr(p.price) + ' | ' + p.specs + ' | ' + p.description +
      ' | ' + (p.in_stock === false ? 'out of stock' : 'in stock');
    if (r) line += ' [score ' + r.score.toFixed(2) + '; why: ' + r.why.join('; ') + ']';
    return line;
  }

  function planSummary(plan, cats) {
    var parts = [];
    parts.push('category=' + (cats && cats.length ? cats.join('|') : 'any'));
    if (plan.price_max != null) parts.push('price<=' + plan.price_max);
    if (plan.price_min != null) parts.push('price>=' + plan.price_min);
    if (plan.use_case) parts.push('use_case=' + plan.use_case);
    if (plan.need_wireless) parts.push('wireless');
    if (plan.need_anc) parts.push('anc');
    if (Object.keys(plan.boosts).length) parts.push('boost=' + Object.keys(plan.boosts).join(','));
    return parts.join('; ');
  }

  function buildPrompt(question, opts) {
    opts = opts || {};
    var stage = opts.stage || 2;
    var system = SYSTEM_PROMPT_BASE;
    var lines = [];
    if (opts.fullCatalog) {
      system += '\n- CATALOG CONTEXT is the entire TechMart catalog.';
      lines.push('CATALOG CONTEXT (entire catalog, ' + opts.fullCatalog.length + ' products):');
      opts.fullCatalog.forEach(function (p) { lines.push(productLine(p)); });
    } else {
      var ret = opts.retrieval;
      system += '\n- CATALOG CONTEXT contains only the products retrieved for this question, already filtered by the hard constraints and ranked; `score` and `why` are retrieval signals you may use.';
      if (stage === 3) system += '\n- Think about which specs matter most for the stated use case (e.g. RAM + GPU + storage for video editing), then answer with a decisive recommendation.';
      if (ret.relaxed) system += '\n- NOTE: nothing matched all constraints exactly; the price filter was relaxed. Say so up front.';
      lines.push('CATALOG CONTEXT (' + ret.results.length + ' retrieved of ' + ret.funnel[0].count + ' products):');
      if (!ret.results.length) lines.push('(no matching products)');
      ret.results.forEach(function (r) { lines.push(productLine(r.product, r)); });
      if (ret.excluded.length) {
        lines.push('');
        lines.push('EXCLUDED BY FILTERS: ' + ret.excluded.slice(0, 4).map(function (e) { return e.product.name + ' (' + inr(e.product.price) + ') — ' + e.reason; }).join('; '));
      }
      lines.push('');
      lines.push('QUERY PLAN: ' + planSummary(ret.plan, ret.categories_used));
    }
    lines.push('');
    lines.push('QUESTION: ' + question);
    var user = lines.join('\n');
    return { system: system, user: user, tokens: estimateTokens(system + '\n' + user) };
  }

  function estimateTokens(text) { return Math.ceil(String(text).length / 4); }

  // ---------------------------------------------------------------- offline answer generation
  var CAT_PLURAL = { Laptop: 'laptops', Smartphone: 'smartphones', Tablet: 'tablets', Earbuds: 'earbuds', Headset: 'headsets',
    Smartwatch: 'smartwatches', Speaker: 'speakers', Monitor: 'monitors' };

  function scopePhrase(ret) {
    var plan = ret.plan;
    var cats = ret.categories_used;
    var noun = cats.length === 2 && cats.indexOf('Headset') !== -1 && cats.indexOf('Earbuds') !== -1 ? 'headphones' :
      cats.length ? joinNatural(cats.map(function (c) { return CAT_PLURAL[c]; })) : 'products';
    var adj = [];
    if (plan.need_wireless) adj.push('wireless');
    if (plan.need_anc) adj.push('noise-cancelling');
    var s = (adj.length ? adj.join(' ') + ' ' : '') + noun;
    if (!ret.relaxed) {
      if (plan.price_max != null && plan.price_min != null) s += ' between ' + inr(plan.price_min) + ' and ' + inr(plan.price_max);
      else if (plan.price_max != null) s += ' under ' + inr(plan.price_max);
      else if (plan.price_min != null) s += ' above ' + inr(plan.price_min);
    }
    return s;
  }

  function constraintPhrase(plan, cats) {
    var s = joinNatural(cats.map(function (c) { return CAT_PLURAL[c]; })) || 'products';
    if (plan.price_max != null && plan.price_min != null) s += ' between ' + inr(plan.price_min) + ' and ' + inr(plan.price_max);
    else if (plan.price_max != null) s += ' under ' + inr(plan.price_max);
    else if (plan.price_min != null) s += ' above ' + inr(plan.price_min);
    return s;
  }

  function topReasons(r, n) {
    return r.why.filter(function (w) { return !/≤|≥|^Named|^Matches|^Wireless$|^Out of stock/.test(w); }).slice(0, n || 4);
  }

  function profileAttrs(ret) {
    return ret.profile.map(function (a) { return a.key; });
  }

  function compare(pick, runner, ret) {
    var keys = profileAttrs(ret).filter(function (k) { return k !== 'price'; }).slice(0, 3);
    var same = [], worse = [], better = [];
    keys.forEach(function (k) {
      var A = ATTRS[k];
      var v1 = A.get(pick), v2 = A.get(runner);
      if (v1 == null || v2 == null) return;
      if (v1 === v2) same.push(A.fmt(runner));
      else if ((v2 - v1) * A.dir > 0) better.push(A.fmt(runner));
      else worse.push(A.fmt(runner) + ' vs ' + A.fmt(pick));
    });
    var parts = [];
    if (same.length) parts.push('same ' + joinNatural(same));
    if (worse.length) parts.push((same.length ? 'but ' : '') + joinNatural(worse));
    var s = parts.join(', ');
    if (better.length) s += (s ? '; it does have ' : 'it has ') + joinNatural(better);
    var diff = runner.price - pick.price;
    if (diff < 0) s += (s ? ', and it\'s ' : 'it\'s ') + inr(-diff) + ' cheaper';
    else if (diff > 0) s += (s ? ', and costs ' : 'it costs ') + inr(diff) + ' more';
    return s;
  }

  function notFoundAnswer(question, ret) {
    var cats = ret.categories_used;
    if (cats.length) {
      return 'Sorry — I couldn\'t find any ' + constraintPhrase(ret.plan, cats) + ' in our catalog. ' +
        'Try widening your budget or asking about a different category.';
    }
    return 'Sorry, that\'s **not in our catalog**. TechMart currently carries laptops, smartphones, tablets, earbuds, headsets, ' +
      'smartwatches, speakers and monitors — ask me about any of those.';
  }

  function relaxedLead(ret) {
    return 'Nothing in our catalog matches **' + constraintPhrase(ret.plan, ret.categories_used) + '** exactly, so the budget filter was relaxed. ' +
      'Here is the best of what we do have:';
  }

  function excludedLine(ret, pick) {
    if (!ret.excluded.length) return null;
    var pickSpec = specOverSet(ret, pick);
    var list = ret.excluded; // nearest to the budget first
    var stronger = pickSpec == null ? [] : list.filter(function (e) { return specOverSet(ret, e.product) > pickSpec; });
    var shown = list.slice(0, 3).map(function (e) { return '**' + e.product.name + '** (' + inr(e.product.price) + ')'; });
    var more = list.length > 3 ? ' (+' + (list.length - 3) + ' more)' : '';
    var limit = ret.plan.price_max != null ? 'over your ' + inr(ret.plan.price_max) + ' budget' : 'outside your price range';
    var tail = '';
    if (stronger.length && ret.plan.price_max != null) {
      var s0 = stronger[0].product;
      var specs0 = ret.profile.slice(0, 2).map(function (a) { return ATTRS[a.key].get(s0) != null ? ATTRS[a.key].fmt(s0) : null; }).filter(Boolean);
      tail = ' The ' + s0.name + ' would score higher' + (ret.plan.use_case ? ' for ' + ret.plan.use_case_label : '') +
        (specs0.length ? ' (' + joinNatural(specs0) + ')' : '') + ', but it is ' + inr(s0.price - ret.plan.price_max) + ' over budget.';
    }
    return 'Excluded (' + limit + '): ' + joinNatural(shown) + more + '.' + tail;
  }

  // spec score of a product normalised over (candidates + excluded) so excluded items are comparable
  function specOverSet(ret, p) {
    if (!ret.profile.length) return null;
    var set = ret.all_ranked.map(function (r) { return r.product; }).concat(ret.excluded.map(function (e) { return e.product; }));
    var w = {};
    ret.profile.forEach(function (a) { w[a.key] = a.weight; });
    var prof = activeProfile(w, set);
    return specScore(prof, p);
  }

  function recommendationAnswer(question, ret) {
    var res = ret.results;
    var pick = res[0];
    var p = pick.product;
    var out = [];
    if (ret.relaxed) out.push(relaxedLead(ret));
    out.push('**Best pick: ' + p.name + ' — ' + inr(p.price) + '**');

    var reasons = topReasons(pick, 5).map(stripBest).filter(function (w) { return w.charAt(0) !== '₹'; }).slice(0, 4);
    var leads = ret.profile.filter(function (a) {
      if (ATTRS[a.key].get(p) == null) return false;
      var tag = ATTRS[a.key].fmt(p) + ' (' + (ATTRS[a.key].best || 'best') + ' in set)';
      return pick.why.indexOf(tag) !== -1;
    }).map(function (a) { return ATTRS[a.key].label; });
    var leadTxt = leads.length >= 2 ? ' — it leads the shortlist on ' + joinNatural(leads) : leads.length === 1 ? ' — the best ' + leads[0] + ' in the shortlist' : '';
    var scope = scopePhrase(ret);
    var reasonLine;
    var onlyBattery = !ret.plan.use_case && ret.profile.length && ret.profile[0].key === 'battery';
    if (res.length === 1 && ret.candidates_count === 1) {
      reasonLine = 'It\'s the only match among our ' + scope + (ret.plan.boosts.battery ? ', so it is also the longest-lasting option' : '') + ': ' + p.specs + '.';
    } else if (onlyBattery && pick.why.some(function (w) { return /battery \(best in set\)/.test(w); })) {
      reasonLine = 'It has the longest battery life of all our ' + scope + ' — ' + ATTRS.battery.fmt(p) +
        (function () { var extra = String(p.specs).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x && !/battery/i.test(x); });
          return extra.length ? ', plus ' + joinNatural(extra) : ''; })() + '.';
    } else if (ret.plan.use_case) {
      reasonLine = 'It\'s the strongest match for ' + ret.plan.use_case_label + ' among our ' + scope + ': ' + joinNatural(reasons) + leadTxt + '.';
    } else if (reasons.length) {
      reasonLine = 'It\'s the best match among our ' + scope + ': ' + joinNatural(reasons) + leadTxt + '.';
    } else {
      reasonLine = p.description + ' (' + p.specs + ').';
    }
    out.push(reasonLine.replace(/^./, function (c) { return c.toUpperCase(); }));
    if (ret.plan.use_case === 'video_editing' && p.category === 'Laptop') {
      var g = attr(p, 'gpu_tier') || 0;
      if (g >= 2) out.push('A dedicated ' + attr(p, 'gpu') + ' speeds up timeline playback and exports, and ' + attr(p, 'ram_gb') + 'GB RAM keeps multi-track edits smooth.');
      else if (g === 0) out.push('Note: it has integrated graphics, so expect slower renders than a laptop with a dedicated GPU.');
    }
    if (p.in_stock === false) out.push('_Heads-up: currently out of stock._');

    if (res[1]) {
      var r2 = res[1].product;
      var cmp = compare(p, r2, ret);
      out.push('**Runner-up: ' + r2.name + ' — ' + inr(r2.price) + '**' + (cmp ? ' — ' + cmp + '.' : '.') + (r2.in_stock === false ? ' (Currently out of stock.)' : ''));
    }
    var ex = excludedLine(ret, p);
    if (ex) out.push(ex);
    return out.join('\n\n');
  }

  function listAnswer(question, ret) {
    var res = ret.results.slice(0, 4);
    var out = [];
    if (ret.relaxed) out.push(relaxedLead(ret));
    else {
      var forWhat = ret.plan.use_case ? ' for ' + ret.plan.use_case_label : '';
      out.push('Here are our top ' + scopePhrase(ret) + forWhat + ':');
    }
    var items = res.map(function (r, i) {
      var reasons = topReasons(r, 4).map(stripBest).filter(function (w) { return w.charAt(0) !== '₹'; }).slice(0, 3);
      return (i + 1) + '. **' + r.product.name + '** — ' + inr(r.product.price) + (reasons.length ? ' · ' + reasons.join(', ') : '') +
        (r.product.in_stock === false ? ' · out of stock' : '');
    });
    out.push(items.join('\n'));
    var top = res[0];
    var tr = topReasons(top, 4);
    var bestWhy = tr.filter(function (w) { return /in set\)/.test(w); }).map(function (w) {
      if (w.charAt(0) === '₹') return 'the lowest price';
      var m = w.match(/^(.*) \((\w+) in set\)$/);
      return m[2] === 'lightest' ? 'the lightest build (' + m[1] + ')' : /battery/.test(m[1]) ? 'the longest battery life (' + m[1] + ')' : 'the most ' + m[1].replace(/^[\d.]+\s*\w*\s*/, '') + ' (' + m[1] + ')';
    });
    out.push('**Top pick: ' + top.product.name + ' (' + inr(top.product.price) + ')** — ' +
      (bestWhy.length ? joinNatural(bestWhy) : joinNatural(tr.map(stripBest))) +
      (ret.plan.use_case === 'student' ? ', which makes it the best value for students.' : '.'));
    var ex = excludedLine(ret, top.product);
    if (ex) out.push(ex);
    return out.join('\n\n');
  }

  function stripBest(w) { return w.replace(/ \((best|lowest|lightest) in set\)/, ''); }

  function askedAttribute(ql) {
    if (/\bram\b|memory/.test(ql)) return 'ram';
    if (/battery/.test(ql)) return 'battery';
    if (/storage|\bssd\b|space/.test(ql)) return 'storage';
    if (/\bgpu\b|graphics/.test(ql)) return 'gpu';
    if (/processor|\bcpu\b|chip/.test(ql)) return 'cpu';
    if (/\banc\b|noise/.test(ql)) return 'anc';
    if (/water|sweat/.test(ql)) return 'water';
    if (/weigh|light|heavy/.test(ql)) return 'weight';
    if (/price|cost|how much/.test(ql)) return 'price';
    return null;
  }

  function pinnedAnswer(question, ret) {
    var ql = question.toLowerCase();
    var pr = ret.results.filter(function (r) { return r.pinned; })[0] || ret.results[0];
    var p = pr.product;
    var key = askedAttribute(ql);
    var uc = ret.plan.use_case;
    var out = [];
    var ram = attr(p, 'ram_gb');
    var others = ret.all_ranked.filter(function (r) { return r.product.id !== p.id; });

    if (key === 'ram' && ram != null) {
      var verdict;
      if (uc === 'coding') {
        if (ram >= 16) verdict = '**Yes.** The **' + p.name + '** (' + inr(p.price) + ') has **' + ram + 'GB RAM**, which is comfortable for coding — IDEs, local servers, containers and plenty of browser tabs at once.';
        else if (ram >= 8) verdict = '**Yes, for everyday coding.** The **' + p.name + '** (' + inr(p.price) + ') has **' + ram + 'GB RAM** with an ' + (attr(p, 'cpu') || 'capable CPU') +
          ' — fine for an editor, terminal, browser and small-to-medium projects. It can feel tight with heavy IDEs, Docker or Android emulators running together.';
        else verdict = '**Probably not.** The **' + p.name + '** has only **' + ram + 'GB RAM**, which is tight for most development work.';
      } else if (uc === 'video_editing' || uc === 'gaming') {
        verdict = ram >= 16 ? '**Yes.** The **' + p.name + '** (' + inr(p.price) + ') has **' + ram + 'GB RAM**, a good amount for ' + ret.plan.use_case_label + '.'
          : '**Only for light work.** The **' + p.name + '** (' + inr(p.price) + ') has **' + ram + 'GB RAM**; 16GB or more is preferable for ' + ret.plan.use_case_label + '.';
      } else {
        verdict = 'The **' + p.name + '** (' + inr(p.price) + ') has **' + ram + 'GB RAM**.';
      }
      out.push(verdict);
      out.push('Full specs: ' + p.specs + '.');
      var alt = others.filter(function (r) { return (attr(r.product, 'ram_gb') || 0) > ram; })
        .sort(function (a, b) { return b.score - a.score; })[0];
      if (alt && ram < 16) {
        var a = alt.product;
        out.push('**If you want more headroom:** the **' + a.name + '** (' + inr(a.price) + ') has ' + attr(a, 'ram_gb') + 'GB RAM' +
          (attr(a, 'cpu') ? ' and an ' + attr(a, 'cpu') : '') + ' — ' + (a.price > p.price ? inr(a.price - p.price) + ' more' : inr(p.price - a.price) + ' less') + '.');
      }
      return out.join('\n\n');
    }

    if (key && ATTRS[key] && ATTRS[key].get(p) != null) {
      out.push('The **' + p.name + '** (' + inr(p.price) + ') has **' + ATTRS[key].fmt(p) + '**.');
    } else {
      out.push('**' + p.name + '** — ' + inr(p.price) + (p.in_stock === false ? ' (out of stock)' : '') + '.');
    }
    out.push(p.description + ' Specs: ' + p.specs + '.');
    if (uc && others.length) {
      var best = others.slice().sort(function (a, b) { return (b.spec_score || 0) - (a.spec_score || 0); })[0];
      if (best && (best.spec_score || 0) > (pr.spec_score || 0)) {
        out.push('For ' + ret.plan.use_case_label + ', the **' + best.product.name + '** (' + inr(best.product.price) + ') scores higher: ' + joinNatural(topReasons(best, 3).map(stripBest)) + '.');
      }
    }
    return out.join('\n\n');
  }

  var LIST_RE = /\b(what|which)\b[^?]*\b(do you have|have you got|do you sell|do you carry|are available|do you stock)\b|\bshow me\b|\blist\b|\boptions\b|\bwhat are\b/;

  function composeAnswer(question, ret, stage) {
    if (!ret.results.length) return { text: notFoundAnswer(question, ret), kind: 'not_found' };
    var ql = question.toLowerCase();
    if (ret.results.some(function (r) { return r.pinned; })) return { text: pinnedAnswer(question, ret), kind: 'product_question' };
    if (stage !== 3 && LIST_RE.test(ql) && ret.results.length > 1) return { text: listAnswer(question, ret), kind: 'list' };
    return { text: recommendationAnswer(question, ret), kind: 'recommendation' };
  }

  // ---------------------------------------------------------------- orchestrator
  /**
   * run(question, products, {stage: 1|2|3, k: 5, stage1Catalog: 'starter'|'full'})
   * Stage 1: no retrieval; the whole catalog goes in the prompt (starter 4 products by default).
   * Stage 2: retrieval (filters + BM25 + spec boosts) -> top-k in prompt.
   * Stage 3: same retrieval, use-case reasoning prompt and a single decisive recommendation.
   */
  function run(question, products, opts) {
    opts = opts || {};
    var stage = Number(opts.stage) || 3;
    var k = opts.k || 5;
    var catalog = products;
    if (stage === 1 && opts.stage1Catalog !== 'full') {
      var starter = products.filter(function (p) { return STARTER_IDS.indexOf(p.id) !== -1; });
      if (starter.length) catalog = starter;
    }
    var ret = retrieve(question, catalog, { k: k });
    var prompt = stage === 1 ? buildPrompt(question, { stage: 1, fullCatalog: catalog }) : buildPrompt(question, { stage: stage, retrieval: ret });
    var fullPrompt = buildPrompt(question, { stage: 1, fullCatalog: products });
    var answer = composeAnswer(question, ret, stage);
    return {
      question: question,
      stage: stage,
      catalog_size: catalog.length,
      retrieval: ret,
      prompt: prompt,
      tokens: {
        full_catalog: fullPrompt.tokens,
        sent: prompt.tokens,
        saved_pct: Math.max(0, Math.round((1 - prompt.tokens / fullPrompt.tokens) * 100))
      },
      offline_answer: answer.text,
      answer_kind: answer.kind
    };
  }

  // ---------------------------------------------------------------- LLM (browser fetch)
  function callAnthropic(prompt, apiKey, model, fetchImpl) {
    var f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) return Promise.reject(new Error('fetch is not available'));
    return f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        max_tokens: 600,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }]
      })
    }).then(function (res) {
      return res.text().then(function (body) {
        var data;
        try { data = JSON.parse(body); } catch (e) { data = null; }
        if (!res.ok) {
          var msg = data && data.error && data.error.message ? data.error.message : body.slice(0, 200);
          throw new Error('HTTP ' + res.status + ': ' + msg);
        }
        var text = (data.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('\n');
        if (!text) throw new Error('Empty response from the model');
        return { text: text, usage: data.usage || null, model: data.model || model };
      });
    });
  }

  var api = {
    CATEGORIES: CATEGORIES,
    STARTER_IDS: STARTER_IDS,
    DEFAULT_MODEL: DEFAULT_MODEL,
    USE_CASES: USE_CASES,
    inr: inr,
    tokenize: tokenize,
    cpuScore: cpuScore,
    parseQuery: parseQuery,
    retrieve: retrieve,
    buildPrompt: buildPrompt,
    estimateTokens: estimateTokens,
    composeAnswer: composeAnswer,
    run: run,
    callAnthropic: callAnthropic
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TechMartEngine = api;
})(typeof window !== 'undefined' ? window : this);
