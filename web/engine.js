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
    color:   { label: 'colour accuracy', dir: 1, get: function (p) { return attr(p, 'color_gamut_srgb'); }, fmt: function (p) { return attr(p, 'color_gamut_srgb') + '% sRGB'; } },
    // only used when a plan asks for them (chat layer boosts); never active for plain run() queries
    screen:  { label: 'screen size', dir: 1, best: 'biggest', get: function (p) { return attr(p, 'display_in'); }, fmt: function (p) { return attr(p, 'display_in') + '-inch display'; } },
    camera:  { label: 'camera', dir: 1, get: function (p) { return specNum(p, /(\d+)\s*MP\b/i); }, fmt: function (p) { return specNum(p, /(\d+)\s*MP\b/i) + 'MP camera'; } }
  };

  function specNum(p, re) { var m = String(p.specs || '').match(re); return m ? parseFloat(m[1]) : null; }

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
    // opts.plan lets the chat layer retrieve with a merged/constructed plan (follow-ups); default is unchanged.
    var plan = opts.plan || parseQuery(question, products);
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
    var ret = retrieve(question, catalog, { k: k, plan: opts.plan });
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

  // ================================================================ conversation layer: converse()
  // Pure + synchronous. Intent detection -> (follow-up resolution via state) -> retrieval -> deterministic,
  // catalog-grounded answer + cards + suggestion chips + a compact LLM prompt. See docs/CHAT_CONTRACT.md §1.

  var CAT_WORD = { Laptop: 'laptop', Smartphone: 'phone', Tablet: 'tablet', Earbuds: 'earbuds', Headset: 'headset',
    Smartwatch: 'smartwatch', Speaker: 'speaker', Monitor: 'monitor' };
  var CAT_TITLE = { Laptop: 'Laptops', Smartphone: 'Smartphones', Tablet: 'Tablets', Earbuds: 'Earbuds', Headset: 'Headsets',
    Smartwatch: 'Smartwatches', Speaker: 'Speakers', Monitor: 'Monitors' };

  function catsNoun(cats) {
    if (cats.length === 2 && cats.indexOf('Headset') !== -1 && cats.indexOf('Earbuds') !== -1) return 'headphones';
    return cats.length ? joinNatural(cats.map(function (c) { return CAT_PLURAL[c]; })) : 'products';
  }
  function catsWordQ(cats) {
    if (cats.length === 2 && cats.indexOf('Headset') !== -1 && cats.indexOf('Earbuds') !== -1) return 'headphones';
    return cats.map(function (c) { return CAT_WORD[c]; }).join(' and ');
  }
  function cloneJSON(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function cap(s) { return String(s).replace(/^./, function (c) { return c.toUpperCase(); }); }

  // ---------------------------------------------------------------- normalisation
  var HINGLISH = [
    [/\b(kaise ho|kaisa hai|kaise hain|kya haal( hai)?|kya chal raha( hai)?)\b/g, ' how are you '],
    [/\b(sasta|sasti|saste|sastaa)\b/g, ' cheap '],
    [/\b(mehenga|mehnga|mahenga|mehngi|mehenge)\b/g, ' expensive '],
    [/\b(chahiye|chaiye|chahie|chahiya)\b/g, ' need '],
    [/\bke (liye|liya|lie)\b/g, ' for '],
    [/(\d+(?:,\d+)*\s*k?)\s+(se kam|tak|ke andar|se neeche|se niche|ke niche|ke under|ke neeche)\b/g, ' under $1 '],
    [/\b(kaunsa|konsa|kaun sa|kon sa|kaunsi|konsi|kaun si)\b/g, ' which '],
    [/\b(dikhao|dikha do|batao|bata do|bataiye|dikhaiye)\b/g, ' show '],
    [/\b(accha|acha|achha|achcha|badhiya|badiya|mast)\b/g, ' good '],
    [/\b(kitne ka|kitne ki|kitna|kitne)\b/g, ' price '],
    [/\baur\b/g, ' and '],
    [/\b(bhai|bhaiya|yaar|yar|bro|dude|ji|plz|pls|please)\b/g, ' '],
    [/\b(hai|hain|mujhe|mereko|mera|meri|koi|wala|wali|wale)\b/g, ' ']
  ];

  function normalizeMessage(message) {
    var s = String(message == null ? '' : message);
    if (s.length > 600) s = s.slice(0, 600);
    // strip markup so formatting/code/links carry no signal: `code`, ```blocks```, [text](url), <tags>, bare urls
    s = s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, ' $1 ')
      .replace(/<[^>]*>/g, ' ').replace(/\b(?:https?|javascript|data|vbscript|file):\S*/gi, ' ').replace(/\bwww\.\S+/gi, ' ');
    s = s.toLowerCase().replace(/[‘’ʼ']/g, '').replace(/\bv\/s\b/g, ' vs ');
    s = s.replace(/[–—]/g, ' - ');
    s = s.replace(/[^\x20-\x7e₹]+/g, ' ');           // emoji & other non-ascii (keeps ₹)
    s = s.replace(/[!?;:"`~^*_=<>{}\[\]|\\@$%&()\/+]/g, ' ');
    s = s.replace(/(\D)\.(\s|$)/g, '$1 $2');               // sentence dots (keeps 5.1, rs.)
    s = s.replace(/\s+/g, ' ').trim();
    HINGLISH.forEach(function (h) { s = s.replace(h[0], h[1]); });
    return s.replace(/\s+/g, ' ').trim();
  }
  function wordTokens(s) { return s.split(/[^a-z0-9#]+/).filter(Boolean); }

  // optimal-string-alignment distance (a transposition counts as one edit: "lapotp" -> "laptop")
  function osa(a, b) {
    var m = a.length, n = b.length, d = [], i, j;
    if (Math.abs(m - n) > 2) return 3;
    for (i = 0; i <= m; i++) { d[i] = [i]; }
    for (j = 0; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++) {
      var c = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[m][n];
  }
  // chat-only spelling fixes for shopping words ("lapotp for gamng"); product-name tokens are left for findProducts()
  var TYPO_VOCAB = ('laptop laptops phone phones smartphone smartphones tablet tablets earbuds headphones headphone headset headsets ' +
    'speaker speakers monitor monitors smartwatch smartwatches gaming editing students student battery camera cheapest wireless ' +
    'bluetooth recommend compare expensive premium budget earphones earphone earbud mobile mobiles notebook notebooks ultrabook ' +
    'soundbar soundbars speakers').split(' ');
  var TYPO_SKIP = new Set(('tables coming battle phase mentor gamer gamers games honey photo photos phonics spender speak cheaper pricier ' +
    'costlier lighter heavier bigger larger smaller faster louder thinner better options others editor editors expense premiums budgets ' +
    'student compares compared camera cameras monitoring speaking').split(' '));
  var TYPO_CATEGORY_WORDS = new Set(('laptop laptops phone phones smartphone smartphones tablet tablets earbuds headphones headphone headset ' +
    'headsets speaker speakers monitor monitors smartwatch smartwatches earphones earphone earbud mobile mobiles notebook notebooks ' +
    'ultrabook soundbar soundbars').split(' '));
  // common English words that sit one edit away from a shopping word ("table" -> "tablet") are never corrected
  var TYPO_COMMON = new Set(('table cable label able stable fable gable sable tables cables labels phase phony phoned mentor monitored ' +
    'speak speaks beaker heads header headed heading notice mobility comparing compared budge budged ' +
    'premise premier gamine gaining gamin gamma editions edition edging camel cameo carmen').split(' '));

  // Long messages: keep the most product-relevant sentence(s) instead of a truncated prefix.
  function relevanceScore(text, products) {
    var s = normalizeMessage(text);
    if (!s) return 0;
    var pq = parseQuery(s, products);
    var sc = pq.categories.length * 3 + (pq.price_max != null || pq.price_min != null ? 2 : 0) + (pq.use_case ? 2 : 0) +
      findProducts(s, products).length * 3 + (pq.need_anc || pq.need_wireless ? 1 : 0) + Object.keys(pq.boosts).length;
    if (findUnknown(s, pq.categories.length > 0)) sc += 2;
    return sc;
  }
  function focusLongMessage(raw, products) {
    if (raw.length <= 600) return raw;
    var parts = raw.replace(/([.!?\n;|])\s*/g, '$1\u0001').split('\u0001').map(function (x) { return x.trim(); }).filter(Boolean);
    var chunks = [];
    parts.forEach(function (p) {  // split run-on sentences into ~40-word windows
      var w = p.split(/\s+/);
      if (p.length <= 400) { chunks.push(p); return; }
      for (var i = 0; i < w.length; i += 40) chunks.push(w.slice(i, i + 40).join(' '));
    });
    var scored = chunks.map(function (c, i) { return { c: c, i: i, s: relevanceScore(c, products) }; });
    var hits = scored.filter(function (x) { return x.s > 0; });
    if (!hits.length) return raw.slice(0, 600);
    var best = hits.slice().sort(function (a, b) { return b.s - a.s || b.i - a.i; })[0];
    // the best sentence, plus other relevant sentences while they fit (in original order)
    var keep = hits.filter(function (x) { return x === best || x.s >= 2; }).sort(function (a, b) { return a.i - b.i; });
    var out = [];
    var len = 0;
    keep.forEach(function (x) { if (x === best || len + x.c.length < 520 - best.c.length) { out.push(x); len += x.c.length; } });
    return out.map(function (x) { return x.c; }).join(' ').slice(0, 600);
  }
  function correctTypos(ql, products, noCategoryTargets) {
    var meta = catalogMeta(products);
    return ql.split(' ').map(function (w) {
      if (w.length < 5 || /[^a-z]/.test(w) || TYPO_SKIP.has(w) || TYPO_COMMON.has(w) || STOPWORDS.has(w) || meta.vocab.has(w) || meta.vocab.has(stem(w)) || TYPO_VOCAB.indexOf(w) !== -1) return w;
      if (Object.keys(meta.tokCount).some(function (t) { return tokMatch(w, t) >= 0; }) || meta.brands[w]) return w;
      var best = null, bd = 9;
      TYPO_VOCAB.forEach(function (v) {
        if (noCategoryTargets && TYPO_CATEGORY_WORDS.has(v)) return;  // an exact category word is already present: it wins
        var allowed = Math.min(v.length, w.length) >= 7 ? 2 : 1;
        var d = osa(w, v);
        if (d <= allowed && d < bd) { bd = d; best = v; }
      });
      return best || w;
    }).join(' ');
  }

  function lev(a, b) {
    if (a === b) return 0;
    var m = a.length, n = b.length, i, j;
    if (Math.abs(m - n) > 2) return 3;
    var prev = [], cur;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur = [i];
      for (j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }

  // ---------------------------------------------------------------- catalog meta + fuzzy product names
  var NAME_CAT_WORDS = new Set('phone tab watch buds pods band pad soundbar book'.split(' '));
  var NAME_GENERIC = new Set('pro max air mini go lite ultra x plus'.split(' '));
  // never pin a product from one of these words alone (common English / spec words)
  var NAME_COMMON = new Set(('air pro max mini go lite ultra x plus smart home elite slim vision curve sport pulse trail arena strike ' +
    'infinity sonic studio campus roam boom bass snap edge view calm echo aura tune fit run band buds pods phone tab watch pad oled ' +
    'soundbar party slate fit').split(' '));
  var NO_FUZZY = new Set(('laptop laptops notebook notebooks phone phones mobile mobiles tablet tablets ipad earbuds earphones headphones ' +
    'headset headsets speaker speakers watch watches smartwatch monitor monitors display screen band bands buds under below above ' +
    'cheap cheaper battery camera gaming editing coding students student travel price budget better best which about compare ' +
    'with what have show more less light lighter want need good great any some does this that them they there their these those ' +
    'other options option first second third tell about phone video music').split(' '));

  var _meta = { ref: null, meta: null };
  function catalogMeta(products) {
    if (_meta.ref === products && _meta.meta) return _meta.meta;
    var brands = {}, tokCount = {}, vocab = new Set(), byId = {};
    products.forEach(function (p) {
      byId[p.id] = p;
      if (p.brand) brands[String(p.brand).toLowerCase()] = p.brand;
      uniq(wordTokens(p.name.toLowerCase())).forEach(function (t) { tokCount[t] = (tokCount[t] || 0) + 1; });
      tokenize(docText(p)).forEach(function (t) { vocab.add(t); });
    });
    var meta = { brands: brands, tokCount: tokCount, vocab: vocab, byId: byId };
    _meta = { ref: products, meta: meta };
    return meta;
  }

  function tokMatch(m, t) {
    if (m === t) return 0;
    if (NO_FUZZY.has(m) || STOPWORDS.has(m) || m.length < 4 || /\d/.test(m) || /\d/.test(t)) return -1;
    var allowed = t.length >= 7 ? 2 : t.length >= 5 ? 1 : 0;
    if (!allowed) return -1;
    var d = lev(m, t);
    return d <= allowed ? d : -1;
  }

  // Returns [{id, idx:[message token positions], fuzzy}] for products named in the message (exact, partial, typo).
  function findProducts(ql, products) {
    var meta = catalogMeta(products);
    var mt = wordTokens(ql);
    if (!mt.length) return [];
    var cands = [];
    products.forEach(function (p) {
      var nt = wordTokens(p.name.toLowerCase());
      var brand = String(p.brand || '').toLowerCase();
      var matched = [], idx = [], fuzzy = false, firstPos = {};
      nt.forEach(function (t, ti) {
        for (var i = 0; i < mt.length; i++) {
          var d = tokMatch(mt[i], t);
          if (d < 0 || idx.indexOf(i) !== -1) continue;
          matched.push(t); idx.push(i); firstPos[ti] = i; if (d > 0) fuzzy = true;
          break;
        }
      });
      if (!matched.length) return;
      var isBrand = function (t) { return t === brand || !!meta.brands[t]; };
      var distinct = matched.filter(function (t) { return !isBrand(t) && !NAME_CAT_WORDS.has(t) && !NAME_GENERIC.has(t) && !/^\d+$/.test(t); });
      var nonBrandCat = matched.filter(function (t) { return !isBrand(t) && !NAME_CAT_WORDS.has(t) && !/^\d+$/.test(t); });
      var all = matched.length === nt.length;
      var prefix = nt.length >= 2 && firstPos[0] != null && firstPos[1] === firstPos[0] + 1 && nonBrandCat.length > 0;
      var single = matched.length === 1 && !fuzzy && distinct.length === 1 && !NAME_COMMON.has(distinct[0]) &&
        (meta.tokCount[distinct[0]] || 0) <= 2 && (distinct[0].length >= 5 || /\d/.test(distinct[0]));
      var ok = (all && (matched.length >= 2 || single)) || (matched.length >= 2 && distinct.length > 0) || prefix || single;
      if (!ok) return;
      cands.push({ id: p.id, idx: idx, fuzzy: fuzzy, unmatched: nt.length - matched.length, pos: Math.min.apply(null, idx) });
    });
    // drop products whose matched tokens are a strict subset of another's ("nova phone 12" inside "nova phone 12 pro")
    var kept = cands.filter(function (a) {
      return !cands.some(function (b) {
        if (a === b) return false;
        var sub = a.idx.every(function (i) { return b.idx.indexOf(i) !== -1; });
        if (!sub) return false;
        if (b.idx.length > a.idx.length) return true;
        return b.unmatched < a.unmatched; // same tokens: prefer the product with fewer unmatched name tokens
      });
    });
    kept.sort(function (a, b) { return a.pos - b.pos; });
    return kept;
  }

  function mentionedBrands(ql, products) {
    var meta = catalogMeta(products);
    return uniq(wordTokens(ql).filter(function (t) { return meta.brands[t]; }).map(function (t) { return meta.brands[t]; }));
  }

  // ---------------------------------------------------------------- unknown (not carried) products
  var MODEL_TAIL = '(?:\\s+(?:\\d+[a-z]*|pro|max|plus|ultra|mini|air|lite|se|fold|flip|note|s\\d+|a\\d+|m\\d+|series))*';
  var UNKNOWN_PRODUCTS = [
    { re: 'i\\s?phones?', label: 'iPhone', cat: 'Smartphone', tier: 'premium' },
    { re: 'ipads?', label: 'iPad', cat: 'Tablet', tier: 'premium' },
    { re: 'mac\\s?books?|imacs?', label: 'MacBook', cat: 'Laptop', tier: 'premium' },
    { re: 'air\\s?pods?', label: 'AirPods', cat: 'Earbuds', tier: 'premium' },
    { re: 'apple watch(?:es)?', label: 'Apple Watch', cat: 'Smartwatch', tier: 'premium' },
    { re: 'apple', label: 'Apple', cat: 'Smartphone', tier: 'premium' },
    { re: 'galaxy\\s+(?:tab|book|buds|watch)\\w*', label: 'Samsung Galaxy', cat: null, tier: 'premium' },
    { re: 'samsung|galaxy', label: 'Samsung Galaxy', cat: 'Smartphone', tier: 'premium' },
    { re: 'google pixel|pixel', label: 'Google Pixel', cat: 'Smartphone', tier: 'premium' },
    { re: 'one\\s?plus', label: 'OnePlus', cat: 'Smartphone', tier: 'mid' },
    { re: 'xiaomi|redmi|realme|poco|oppo|vivo|iqoo|motorola|moto|nokia|honor|huawei|nothing phone|infinix|tecno|lava', label: null, cat: 'Smartphone', tier: 'budget' },
    { re: 'ps5|ps4|playstation|xbox|nintendo(?: switch)?|steam deck', label: null, cat: 'Laptop', uc: 'gaming', tier: 'premium' },
    { re: 'sony|bose|sennheiser|beats|skullcandy|jabra', label: null, cat: 'Headset', tier: 'premium' },
    { re: 'jbl|marshall|harman kardon|bang olufsen|sonos', label: null, cat: 'Speaker', tier: 'premium' },
    { re: 'boat|boult', label: null, cat: 'Earbuds', tier: 'budget' },
    { re: 'dell|hp|lenovo|asus|acer|msi|thinkpad|chromebook|surface|razer|alienware|rog|legion|ideapad|vivobook|zenbook', label: null, cat: 'Laptop', tier: 'mid' },
    { re: 'fitbit|garmin|amazfit|fire[\\s-]?boltt|noise colorfit|whoop', label: null, cat: 'Smartwatch', tier: 'mid' },
    { re: 'kindle', label: 'Kindle', cat: 'Tablet', tier: 'budget' },
    { re: 'alexa|echo dot|homepod|google home|nest mini|nest hub', label: null, cat: 'Speaker', tier: 'mid' },
    { re: 'lg|benq|viewsonic', label: null, cat: 'Monitor', tier: 'mid' },
    // generic product types we don't stock (only when the message names none of our categories)
    { re: 'dslrs?|mirrorless|gopro|canon|nikon|camcorders?|cameras?', label: 'standalone cameras', cat: 'Smartphone', boost: 'camera', tier: 'premium', generic: true },
    { re: 'tvs?|televisions?|smart tvs?', label: 'TVs', cat: 'Monitor', tier: 'premium', generic: true },
    { re: 'printers?|routers?|projectors?|drones?|keyboards?|mouse|mice|chargers?|power\\s?banks?|cables?|pendrives?|hard dis[ck]s?|webcams?|consoles?', label: null, cat: null, tier: 'mid', generic: true, accessory: true }
  ].map(function (u) { u.rx = new RegExp('\\b(?:' + u.re + ')\\b' + MODEL_TAIL); return u; });

  function prettyUnknown(raw, u) {
    var words = raw.trim().split(/\s+/);
    if (u.label && !u.generic) {
      var head = new RegExp('^(?:' + u.re + ')$');
      var cut = 1;
      for (var i = 1; i <= words.length; i++) if (head.test(words.slice(0, i).join(' '))) { cut = i; break; }
      var tail = words.slice(cut).map(function (w) { return /^(pro|max|plus|ultra|mini|air|lite|fold|flip|note|series)$/.test(w) ? cap(w) : w.toUpperCase(); });
      return [u.label].concat(tail).join(' ');
    }
    if (u.label) return u.label;
    var special = { ps5: 'PS5', ps4: 'PS4', xbox: 'Xbox', jbl: 'JBL', hp: 'HP', lg: 'LG', msi: 'MSI', rog: 'ROG', benq: 'BenQ', iqoo: 'iQOO', oneplus: 'OnePlus' };
    return words.map(function (w) { return special[w] || (/\d/.test(w) ? w.toUpperCase() : cap(w)); }).join(' ');
  }

  function findUnknown(ql, hasCategory) {
    for (var i = 0; i < UNKNOWN_PRODUCTS.length; i++) {
      var u = UNKNOWN_PRODUCTS[i];
      if (u.generic && hasCategory) continue;
      var m = ql.match(u.rx);
      if (m) return { label: prettyUnknown(m[0], u), labelled: !!u.label && !u.generic, generic: !!u.generic, rx: u.rx, raw: m[0], cat: u.cat, uc: u.uc || null, boost: u.boost || null, tier: u.tier, accessory: !!u.accessory };
    }
    return null;
  }

  // ---------------------------------------------------------------- intent patterns
  var RX = {
    smalltalk: /\bhow are (you|u)\b|\bhow r u\b|\bhows it going\b|\bhow is it going\b|\bhow (is|was) your day\b|\bwhats up\b|\bwassup\b|\bsup\b|\blol\b|\blmao\b|\brofl\b|\bha(ha)+\b|\bhe(he)+\b|\bjoke\b|\bfunny\b|\bbored\b|\blove you\b|\bmarry me\b|\byou(re| are) (so )?(smart|dumb|stupid|great|awesome|cool|funny|helpful|useless|the best)\b|\bgood bot\b|\bbad bot\b|\bnice to meet you\b|\bwhat is your favou?rite\b/,
    joke: /\bjoke\b|\bmake me laugh\b|\bsomething funny\b|\bbored\b/,
    greeting: /^(hi+|hello+|helo|hey+|heya|hiya|yo|namaste|namaskar|hola|howdy|greetings|good (morning|afternoon|evening|day)|hai)\b/,
    thanks: /\b(thanks?|thank you|thx|tysm|ty|thanku|thankyou|shukriya|dhanyavad|appreciate it|much appreciated)\b|^(ok|okay|k|kk|cool|nice|great|awesome|perfect|got it|alright|fine|sure|hmm+|oh|wow|super|amazing|done)$/,
    bye: /\b(bye+|goodbye|good bye|see you|see ya|cya|good night|ttyl|catch you later|thats all|that is all)\b/,
    help: /\b(who are you|what are you|who made you|who built you|whats your name|what is your name|your name|what can you do|what do you do|help|how does this work|how do i use|what can i ask|are you (a )?(bot|robot|human|ai|real|chatgpt|person))\b/,
    strongOff: /\bweather\b(?![\s-]*(proof|resist|seal))|\btemperature (today|outside)\b|\bcapital of\b|\bprime minister\b|\bpresident of\b|\bwho is the (president|pm|ceo|king|queen)\b|\bwrite (me )?(a |an )?(poem|story|essay|song|letter|haiku|limerick)\b|\bpoem\b|\bhaiku\b|\brecipe\b|\btranslate\b|\bhomework\b|\bmeaning of life\b|\bhoroscope\b|\bwho won\b|\bcricket score\b|\bipl\b|\bbitcoin\b|\bcrypto(currency)?\b|\bstock market\b|^(what is|whats|calculate|solve)\s+\d+\s*(plus|minus|times|x|\*|-|\+|divided by)\s*\d+/,
    nonElec: /\b(fridges?|refrigerators?|washing machines?|washers?|dryers?|microwaves?|ovens?|air conditioners?|\bac\b|air coolers?|ceiling fans?|geysers?|vacuum( cleaners?)?|irons?|cars?|bikes?|motorbikes?|scooters?|bicycles?|cycles?|shoes?|sneakers?|clothes|clothing|shirts?|t-shirts?|jeans|dress(es)?|sarees?|food|pizzas?|burgers?|groceries|grocery|furniture|sofas?|beds?|mattress(es)?|chairs?|medicines?|books?|jewell?ery|perfumes?|cosmetics|makeup|toys?|flights? tickets?|hotels?|insurance|loans?|houses?|flats?|apartments?)\b/,
    generalQ: /^(who|what|when|where|why|how|is|are|can|tell me)\b/,
    wantSomething: /\b(buy|get|choose|pick|recommend|suggest|purchase|gift|need|want|looking|shopping|shop)\b/,
    compare: /\bcompare\b|\bcomparison\b|\bvs\b|\bversus\b|\bdifference between\b|\bdifferences?\b|\bdiff\b|\bbetter than\b|\bwhich is better\b|\bor the\b/,
    compareRef: /\b(them|these|those|both|the two|top two|top 2|first two|these two|those two|the 2|all three|each other)\b/,
    overview: /\bwhat (all )?(do|can) (you|i) (sell|have|offer|stock|carry|buy|get)\b|\b(what|which) (products|categories|brands|items|things|stuff|gadgets)\b|\bcategor(y|ies)\b|\b(your|the|full) (catalog|catalogue|range|inventory|product list)\b|\bshow (me )?(everything|all products|all items|all categories|the catalog|your products)\b|\bwhat (all )?is (in stock|available)\b|\bwhat brands\b|\bwhich brands\b|\beverything you (have|sell)\b/,
    list: /\b(what|which)\b[^?]*\b(do you have|have you got|do you sell|do you carry|are available|do you stock|do you offer|you got)\b|\bshow( me)?\b|\blist\b|\boptions\b|\bwhat are\b|\ball (the )?(laptops?|phones?|smartphones?|tablets?|earbuds|headsets?|headphones|smartwatch(es)?|watch(es)?|speakers?|monitors?)\b|\bdo you (sell|have|carry|stock)\b|\bbrowse\b|\brange of\b|\bany (laptops?|phones?|tablets?|earbuds|headsets?|headphones|watch(es)?|speakers?|monitors?)\b/,
    cheapest: /\bcheapest\b|\blowest pric(e|ed)\b|\bleast expensive\b|\bmost affordable\b|\bbudget-?est\b|\bcheap(est)? one\b/,
    priciest: /\bmost expensive\b|\bcostliest\b|\bpriciest\b|\bhighest pric(e|ed)\b|\btop[\s-]end\b|\bmost premium\b|\bflagship\b|\bmost costly\b/,
    recWords: /\bbest\b|\brecommend|\bsuggest|\bshould i\b|\bgood\b|\bwhich\b|\bideal\b|\bperfect\b|\bright\b|\bworth\b|\bfor\b|\bwith\b|\bneed\b|\bwant\b|\blooking\b|\bunder\b|\bbelow\b/,
    cheaper: /\bcheaper\b|\bless expensive\b|\blower (price|budget|cost)\b|\bmore affordable\b|\bcheap(er)? (one|option|alternative)s?\b|\bsomething cheap\b|\banything cheap\b|\bsave money\b|\btoo (expensive|costly|pricey)\b|\bover my budget\b|\bcheap\b/,
    pricier: /\bmore expensive\b|\bpricier\b|\bcostlier\b|\bpremium\b|\bhigher[\s-]end\b|\bupgrade\b|\bmore powerful\b|\bbetter (one|option)s?\b|\bstep up\b|\bspend more\b|\bmore budget\b|\bhigher budget\b/,
    more: /\bshow (me )?more\b|\bmore options\b|\bmore results\b|\bother (options|ones|choices|models)\b|\balternatives?\b|\banything else\b|\bsomething else\b|\bany others?\b|\bwhat else\b|\bnext (ones|options)\b|\bothers\b/,
    refine: /^(what|how) about\b|^and\b|^also\b|^ok(ay)? (and|what about)\b|\bwhich (one )?(is|has|have|one|of them|of these)\b|\bwhich\s+\w+\s+(has|have|is)\b|\bwith (anc|noise|gps|wireless|bluetooth|more|better|good|longer|a bigger|bigger|a better)\b|\bwithout\b|\b(more|better|longer|bigger|best|most) (ram|memory|storage|battery|camera|display|screen|performance|gpu|graphics|sound|refresh)\b|\b(lighter|smaller|bigger|larger|faster|louder|thinner)\b|\bfor (gaming|editing|video|coding|programming|students?|college|travel|gym|running|work|office|kids)\b|\binstead\b|\bonly\b/,
    detail: /\btell me (more|about)\b|\bmore (about|details|info)\b|\bdetails?\b|\bspecs?\b|\bspecifications?\b|\bfeatures?\b|\breview\b|\bdescribe\b|\binfo(rmation)?\b|\bworth it\b|\bany good\b|\bgood for\b|\bhow (good|much|long|heavy|big)\b|\bis it\b|\bdoes it\b|\bcan it\b|\bwill it\b|\bdo they\b|\bhas it\b|\bprice\b|\bcost\b/,
    pronoun: /\b(it|its|this one|that one|this|that|the same|same one)\b/,
    ordinal: /\b(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b(?:\s+(?:one|option|pick|product|item|model))?|#\s*([1-6])\b|\b(?:number|no|option|item|pick)\s*([1-6])\b|\b(top (?:one|pick|choice))\b|\b(best pick)\b|\b(runner[\s-]?up)\b|\b(the last (?:one|option|pick)|last one)\b/g,
    gift: /\bgifts?\b|\bgifting\b|\bpresent for\b|\bbirthday\b|\banniversary\b|\bdiwali\b|\bchristmas\b/,
    featureWords: /\b(battery|anc|noise|ram|memory|storage|ssd|gpu|graphics|camera|screen|display|refresh|hz|wireless|bluetooth|waterproof|water|gps|stylus|amoled|oled|4k|qhd|bass|mic|charging|processor|cpu|electronics?|gadgets?|devices?|tech)\b/
  };

  var ORD_IDX = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4 };
  function ordinalRefs(ql) {
    var out = [], m;
    RX.ordinal.lastIndex = 0;
    while ((m = RX.ordinal.exec(ql))) {
      var i = null;
      if (m[1]) i = ORD_IDX[m[1]];
      else if (m[2]) i = parseInt(m[2], 10) - 1;
      else if (m[3]) i = parseInt(m[3], 10) - 1;
      else if (m[4] || m[5]) i = 0;
      else if (m[6]) i = 1;
      else if (m[7]) i = -1;
      if (i != null && out.indexOf(i) === -1) out.push(i);
    }
    return out;
  }

  // converse-only boosts; plain run() queries never see these.
  var EXTRA_BOOSTS = [
    { key: 'ram', re: /\bram\b|\bmemory\b|\bmultitask/, w: 0.5 },
    { key: 'storage', re: /\bstorage\b|\bspace\b|\bssd\b|\b[12]\s*tb\b/, w: 0.5 },
    { key: 'screen', re: /\b(big|bigger|biggest|large|larger|largest|huge)\s+(screen|display)\b|\bscreen size\b|\bbigger\b|\blarger\b/, w: 0.5 },
    { key: 'camera', re: /\bcamera\b|\bphotos?\b|\bphotograph|\bselfies?\b|\bmp\b/, w: 0.6 },
    { key: 'weight', re: /\blighter\b|\blightest\b|\bweigh|\bthin(ner)?\b|\bportable\b|\bcarry around\b/, w: 0.4 },
    { key: 'refresh', re: /\brefresh\b|\bhz\b|\bsmooth(er)?\b/, w: 0.5 },
    { key: 'water', re: /\bwater\b|\bswim|\brain\b|\bshower\b|\bsplash/, w: 0.4 },
    { key: 'battery', re: /\bbattery\b|\bbackup\b|\blasts? long/, w: 0.4 },
    { key: 'cpu', re: /\bpowerful\b|\bperformance\b|\bfast(er|est)?\b|\bspeed\b|\bprocessor\b/, w: 0.3 },
    { key: 'gpu', re: /\bpowerful\b|\bperformance\b|\bgraphics\b|\bgpu\b/, w: 0.3 },
    { key: 'price', re: /\bcheap(er|est)?\b|\baffordable\b|\bvalue for money\b|\bbudget\b/, w: 0.4 }
  ];
  var SOFT_CATS = [
    { re: /\bkids?\b|\bchild(ren)?\b|\btoddlers?\b|\bson\b|\bdaughter\b/, cats: ['Tablet'], kw: ['kid'] },
    { re: /\bdraw(ing)?\b|\bsketch(ing)?\b|\bstylus\b|\bnote[\s-]?taking\b|\bhandwrit/, cats: ['Tablet'], kw: ['stylu'] },
    { re: /\bphotograph|\bphotos?\b|\bselfies?\b/, cats: ['Smartphone'] },
    { re: /\boffice\b|\bwork from home\b|\bwfh\b|\bzoom calls?\b|\bmeetings?\b|\bspreadsheets?\b|\bexcel\b/, cats: ['Laptop'], boosts: { ram: 0.3, battery: 0.3, weight: 0.2 } },
    { re: /\bparty\b|\bkaraoke\b|\bdj\b/, cats: ['Speaker'], kw: ['karaoke'] },
    { re: /\bmusic\b|\bsongs?\b|\bpodcasts?\b|\baudiobooks?\b/, cats: ['Headset', 'Earbuds'] },
    { re: /\bmovies?\b|\bnetflix\b|\bbinge\b|\bstreaming\b|\breading\b|\bebooks?\b|\bcomics\b/, cats: ['Tablet'] },
    { re: /\bheart[\s-]?rate\b|\bspo2\b|\bsleep track|\bstep count|\bsteps\b|\bfitness track/, cats: ['Smartwatch'] }
  ];

  var FOLLOW_STOP = new Set(('cheaper expensive costlier pricier option other else alternative alternatives more less lower higher show ' +
    'first second third top two them which one ones lighter heavier bigger larger smaller premium better powerful anything something ' +
    'instead only also okay ok and what about how else others next result results same ram memory battery storage camera gps screen display ' +
    'anc noise lightest cheapest weight weigh good').split(' '));

  // ---------------------------------------------------------------- plan helpers
  function ucById(id) { for (var i = 0; i < USE_CASES.length; i++) if (USE_CASES[i].id === id) return USE_CASES[i]; return null; }
  function recomputeWeights(plan) {
    var w = {};
    var uc = ucById(plan.use_case);
    if (uc) Object.keys(uc.weights).forEach(function (k) { w[k] = uc.weights[k]; });
    Object.keys(plan.boosts || {}).forEach(function (k) { w[k] = (w[k] || 0) + plan.boosts[k]; });
    if (!Object.keys(w).length && plan.base_weights) Object.keys(plan.base_weights).forEach(function (k) { w[k] = plan.base_weights[k]; });
    plan.weights = w;
    return plan;
  }

  // "best phone under 50k" has no use case or boost: rank by an all-round quality profile instead of price only (chat layer only).
  var DEFAULT_PROFILE = {
    Laptop: { cpu: 0.3, ram: 0.3, gpu: 0.2, storage: 0.2 },
    Smartphone: { camera: 0.3, ram: 0.25, refresh: 0.25, storage: 0.2 },
    Tablet: { ram: 0.3, storage: 0.3, refresh: 0.2, battery: 0.2 },
    Earbuds: { anc: 0.4, battery: 0.4, water: 0.2 },
    Headset: { anc: 0.4, battery: 0.4, weight: 0.2 },
    Smartwatch: { battery: 0.5, water: 0.5 },
    Speaker: { battery: 0.5, water: 0.5 },
    Monitor: { resolution: 0.35, refresh: 0.35, color: 0.3 }
  };
  function applyDefaultProfile(plan) {
    if (!plan.categories || !plan.categories.length) return plan;
    var w = {};
    plan.categories.forEach(function (c) {
      var d = DEFAULT_PROFILE[c] || {};
      Object.keys(d).forEach(function (k) { w[k] = (w[k] || 0) + d[k] / plan.categories.length; });
    });
    plan.base_weights = w;
    return recomputeWeights(plan);
  }
  // fitness/gym/running: smartwatches + sweat/water-proof sport earbuds only (never speakers, laptops...)
  var FITNESS_CATS = ['Smartwatch', 'Earbuds'];
  function applyFitnessScope(plan) {
    var inter = (plan.categories || []).filter(function (c) { return FITNESS_CATS.indexOf(c) !== -1; });
    plan.categories = inter.length ? inter : FITNESS_CATS.slice();
    if (plan.categories.indexOf('Earbuds') !== -1) plan.sport_earbuds = true;
    return plan;
  }
  function makePlan(o) {
    o = o || {};
    var uc = ucById(o.use_case);
    return recomputeWeights({
      categories: (o.categories || []).slice(), price_max: o.price_max == null ? null : o.price_max, price_min: o.price_min == null ? null : o.price_min,
      use_case: uc ? uc.id : null, use_case_label: uc ? uc.label : null, need_wireless: !!o.need_wireless, need_anc: !!o.need_anc,
      keywords: (o.keywords || []).slice(), pinned_ids: (o.pinned_ids || []).slice(), boosts: cloneJSON(o.boosts || {}), weights: {}
    });
  }
  function addBoost(plan, key, w) { plan.boosts[key] = Math.max(plan.boosts[key] || 0, w); }

  function augmentPlan(plan, ql, opts) {
    opts = opts || {};
    var changed = [];
    EXTRA_BOOSTS.forEach(function (b) {
      if (opts.skip && opts.skip.indexOf(b.key) !== -1) return;
      if (b.key === 'price' && (plan.price_max != null || plan.boosts.price)) return;
      if (b.key === 'battery' && plan.boosts.battery) return;
      if (b.key === 'water' && plan.boosts.water) return;
      if (b.key === 'weight' && plan.boosts.weight) return;
      if (b.re.test(ql)) { addBoost(plan, b.key, b.w); changed.push(b.key); }
    });
    if (!plan.categories.length) {
      for (var i = 0; i < SOFT_CATS.length; i++) {
        var s = SOFT_CATS[i];
        if (!s.re.test(ql)) continue;
        plan.categories = s.cats.slice();
        (s.kw || []).forEach(function (k) { if (plan.keywords.indexOf(k) === -1) plan.keywords.push(k); });
        Object.keys(s.boosts || {}).forEach(function (k) { addBoost(plan, k, s.boosts[k]); });
        plan.soft_category = true;
        break;
      }
    }
    recomputeWeights(plan);
    return changed;
  }

  var BOOST_TEXT = { battery: 'long battery life', price: 'cheap', weight: 'lightweight', anc: 'anc', water: 'waterproof', ram: 'more RAM',
    storage: 'more storage', screen: 'bigger screen', camera: 'great camera', refresh: 'high refresh rate', cpu: 'fast processor', gpu: 'strong graphics' };
  var BOOST_LABEL = { battery: 'battery life', price: 'a lower price', weight: 'a lighter build', anc: 'noise cancellation', water: 'water resistance',
    ram: 'more RAM', storage: 'more storage', screen: 'a bigger screen', camera: 'the camera', refresh: 'a high refresh rate', cpu: 'performance', gpu: 'graphics' };

  function planToText(plan) {
    var parts = [];
    if (plan.need_wireless) parts.push('wireless');
    if (plan.need_anc) parts.push('noise cancelling');
    if (plan.need_gps) parts.push('GPS');
    parts.push(plan.categories.length ? catsWordQ(plan.categories) : 'products');
    if (plan.use_case) parts.push('for ' + UC_TEXT[plan.use_case]);
    var b = Object.keys(plan.boosts || {}).filter(function (k) { return !(k === 'anc' && plan.need_anc); }).map(function (k) { return BOOST_TEXT[k]; }).filter(Boolean);
    if (b.length) parts.push('with ' + b.join(', '));
    var kw = (plan.keywords || []).filter(function (k) { return k.length > 2; });
    if (kw.length) parts.push('(' + kw.join(' ') + ')');
    if (plan.price_min != null && plan.price_max != null) parts.push('between ' + inr(plan.price_min) + ' and ' + inr(plan.price_max));
    else if (plan.cheaper_than && plan.price_max === plan.cheaper_than.price) parts.push('cheaper than ' + plan.cheaper_than.name + ' (' + inr(plan.cheaper_than.price) + ')');
    else if (plan.price_max != null) parts.push('under ' + inr(plan.price_max));
    else if (plan.price_min != null) parts.push('above ' + inr(plan.price_min));
    return parts.join(' ');
  }
  var UC_TEXT = { video_editing: 'video editing', gaming: 'gaming', coding: 'coding', student: 'students', travel: 'travel', workout: 'workouts' };

  function runPlan(text, catalog, plan, stage, k) {
    return run(text, catalog, { stage: stage, k: k || 5, plan: plan, stage1Catalog: 'full' });
  }

  // ---------------------------------------------------------------- card + formatting helpers
  function specBits(p, n) { return String(p.specs || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, n || 3); }
  function card(p, why, badge) {
    var w = (why && why.length ? why : specBits(p, 3)).slice(0, 4);
    return { id: p.id, name: p.name, category: p.category, price: p.price, specs: p.specs, why: w, badge: badge || '' };
  }
  function cardsFromResults(results, n, badges) {
    return results.slice(0, n || 3).map(function (r, i) {
      return card(r.product, r.why.filter(function (w) { return w !== 'Named in your question'; }), badges === false ? '' : (i === 0 ? 'Best pick' : i === 1 ? 'Runner-up' : ''));
    });
  }
  function bullet(p) { return '- **' + p.name + '** — ' + inr(p.price) + ' — ' + specBits(p, 3).join(', ') + (p.in_stock === false ? ' _(out of stock)_' : ''); }

  // ---------------------------------------------------------------- compare
  function weightFmt(kg) { return kg < 1 ? Math.round(kg * 1000) + ' g' : kg + ' kg'; }
  var CMP = {
    cpu: { label: 'Processor', dir: 1, get: function (p) { return attr(p, 'cpu') ? cpuScore(attr(p, 'cpu')) : null; }, fmt: function (p) { return attr(p, 'cpu'); }, adv: 'a faster processor' },
    ram: { label: 'RAM', dir: 1, get: function (p) { return attr(p, 'ram_gb'); }, fmt: function (p) { return attr(p, 'ram_gb') + 'GB'; }, adv: 'more RAM' },
    gpu: { label: 'Graphics', dir: 1, get: function (p) { return p.category === 'Laptop' ? (attr(p, 'gpu_tier') || 0) : null; }, fmt: function (p) { return attr(p, 'gpu') || 'integrated'; }, adv: 'stronger graphics' },
    storage: { label: 'Storage', dir: 1, get: function (p) { return attr(p, 'storage_gb'); }, fmt: function (p) { return storageLabel(attr(p, 'storage_gb')); }, adv: 'more storage' },
    camera: { label: 'Main camera', dir: 1, get: function (p) { return specNum(p, /(\d+)\s*MP\b/i); }, fmt: function (p) { var v = specNum(p, /(\d+)\s*MP\b/i); return v ? v + 'MP' : (/triple camera/i.test(p.specs) ? 'triple camera' : 'n/a'); }, adv: 'a higher-resolution camera' },
    mah: { label: 'Battery', dir: 1, get: function (p) { return specNum(p, /(\d+)\s*mAh/i); }, fmt: function (p) { return specNum(p, /(\d+)\s*mAh/i) + 'mAh'; }, adv: 'a bigger battery' },
    battery: { label: 'Battery', dir: 1, get: function (p) { return attr(p, 'battery_hr'); }, fmt: function (p) { return ATTRS.battery.fmt(p).replace(' battery', ''); }, adv: 'longer battery life' },
    refresh: { label: 'Refresh rate', dir: 1, get: function (p) { return attr(p, 'refresh_hz'); }, fmt: function (p) { return attr(p, 'refresh_hz') + 'Hz'; }, adv: 'a smoother high-refresh screen' },
    screen: { label: 'Screen', dir: 1, get: function (p) { return attr(p, 'display_in'); }, fmt: function (p) { return attr(p, 'display_in') + '-inch'; }, adv: 'a bigger screen' },
    weight: { label: 'Weight', dir: -1, get: function (p) { return attr(p, 'weight_kg'); }, fmt: function (p) { return weightFmt(attr(p, 'weight_kg')); }, adv: 'a lighter build' },
    anc: { label: 'Noise cancellation', dir: 1, get: function (p) { var a = attr(p, 'anc'); return a == null ? null : (a ? 1 : 0); }, fmt: function (p) { return attr(p, 'anc') ? 'yes' : 'no'; }, adv: 'noise cancellation' },
    water: { label: 'Water resistance', dir: 1, get: function (p) { return ATTRS.water.get(p); }, fmt: function (p) { return attr(p, 'water_resistance') || 'none'; }, adv: 'better water resistance' },
    gps: { label: 'GPS', dir: 1, get: function (p) { var g = attr(p, 'gps'); return g == null ? null : (g ? 1 : 0); }, fmt: function (p) { return attr(p, 'gps') ? 'built-in' : 'no'; }, adv: 'built-in GPS' },
    output: { label: 'Output', dir: 1, get: function (p) { return specNum(p, /(\d+)\s*W output/i); }, fmt: function (p) { return specNum(p, /(\d+)\s*W output/i) + 'W'; }, adv: 'more power and volume' },
    resolution: { label: 'Resolution', dir: 1, get: function (p) { return resolutionScore(attr(p, 'resolution')); }, fmt: function (p) { return ATTRS.resolution.fmt(p); }, adv: 'a sharper resolution' },
    panel: { label: 'Panel', dir: 1, get: function (p) { var v = { OLED: 3, IPS: 2, VA: 1 }[attr(p, 'panel')]; return v == null ? null : v; }, fmt: function (p) { return attr(p, 'panel'); }, adv: 'a better panel' },
    color: { label: 'Colour', dir: 1, get: function (p) { return attr(p, 'color_gamut_srgb'); }, fmt: function (p) { return attr(p, 'color_gamut_srgb') + '% sRGB'; }, adv: 'more accurate colour' }
  };
  var CMP_KEYS = {
    Laptop: ['cpu', 'ram', 'gpu', 'storage', 'refresh', 'battery', 'weight', 'screen'],
    Smartphone: ['camera', 'ram', 'storage', 'mah', 'refresh', 'screen', 'weight'],
    Tablet: ['cpu', 'ram', 'storage', 'screen', 'refresh', 'battery', 'weight'],
    Earbuds: ['anc', 'battery', 'water'],
    Headset: ['anc', 'battery', 'water', 'weight'],
    Smartwatch: ['battery', 'gps', 'water', 'screen'],
    Speaker: ['output', 'battery', 'water', 'weight'],
    Monitor: ['screen', 'resolution', 'refresh', 'panel', 'color']
  };

  function cmpVal(key, p) { var v = CMP[key].get(p); return v == null || isNaN(v) ? null : v; }

  function compareAnswer(a, b, useCase) {
    var keys = CMP_KEYS[a.category] || [];
    if (a.category !== b.category) keys = keys.filter(function (k) { return (CMP_KEYS[b.category] || []).indexOf(k) !== -1; });
    var out = ['Here\'s how the **' + a.name + '** and the **' + b.name + '** compare:'];
    if (a.category !== b.category) out[0] = 'The **' + a.name + '** is a ' + CAT_WORD[a.category] + ' and the **' + b.name + '** is a ' + CAT_WORD[b.category] + ', so here is what they share:';
    var lines = ['- **Price:** ' + a.name + ' — ' + inr(a.price) + ' · ' + b.name + ' — ' + inr(b.price)];
    var advA = [], advB = [];
    keys.forEach(function (k) {
      var va = cmpVal(k, a), vb = cmpVal(k, b);
      if (va == null && vb == null) return;
      var C = CMP[k];
      var fa = va == null && k !== 'camera' ? 'n/a' : C.fmt(a), fb = vb == null && k !== 'camera' ? 'n/a' : C.fmt(b);
      var note = '';
      if (va != null && vb != null) {
        if (va === vb) note = ' (same)';
        else if ((va - vb) * C.dir > 0) advA.push(C.adv); else advB.push(C.adv);
      }
      lines.push('- **' + C.label + ':** ' + fa + ' vs ' + fb + note);
    });
    out.push(lines.join('\n'));
    var diff = a.price - b.price; // >0: a dearer
    var cheaper = diff > 0 ? b : diff < 0 ? a : null;
    var save = Math.abs(diff);
    var verdict;
    var ucLine = '';
    var uc = ucById(useCase);
    if (uc && a.category === b.category) {
      var prof = activeProfile(uc.weights, [a, b]);
      if (prof.length) {
        var sa = specScore(prof, a), sb = specScore(prof, b);
        ucLine = sa !== sb ? ' For ' + uc.label + ', the **' + (sa > sb ? a.name : b.name) + '** is the better fit.'
          : ' For ' + uc.label + ' they\'re evenly matched on the specs that matter (' + joinNatural(prof.slice(0, 3).map(function (x) { return ATTRS[x.key].label; })) + ').';
      }
    }
    if (advA.length && advB.length) {
      verdict = 'Pick the **' + a.name + '** if you want ' + joinNatural(advA.slice(0, 3)) + '; pick the **' + b.name + '** if you\'d rather have ' + joinNatural(advB.slice(0, 3)) +
        (cheaper === b ? ' and save ' + inr(save) : cheaper === a ? ' (it costs ' + inr(save) + ' more)' : '') + '.';
    } else if (advA.length || advB.length) {
      var win = advA.length ? a : b, lose = advA.length ? b : a, adv = advA.length ? advA : advB;
      if (cheaper === lose) verdict = 'The **' + win.name + '** is stronger on ' + joinNatural(adv.slice(0, 3)) + '; the **' + lose.name + '** only makes sense if you want to save ' + inr(save) + '.';
      else verdict = 'The **' + win.name + '** wins outright — ' + joinNatural(adv.slice(0, 3)) + (cheaper === win ? ', and it\'s ' + inr(save) + ' cheaper' : ' at the same price') + '.';
    } else {
      verdict = cheaper ? 'They\'re evenly matched on the key specs, so the cheaper **' + cheaper.name + '** (' + inr(cheaper.price) + ') is the smarter buy.' : 'They\'re evenly matched on the key specs and price.';
    }
    out.push('**Verdict:** ' + verdict + ucLine);
    return out.join('\n\n');
  }

  // which of a set wins on one attribute ("which is lighter?" after a compare)
  var SUPERLATIVE = [
    { key: 'weight', re: /\blight(er|est)?\b|\bweigh|\bheav(y|ier)\b|\bportable\b/ },
    { key: 'price', re: /\bcheap(er|est)?\b|\baffordable\b|\bless expensive\b|\bvalue\b/, cmp: 'price' },
    { key: 'battery', re: /\bbattery\b|\blasts? longer\b|\bbackup\b/ },
    { key: 'ram', re: /\bram\b|\bmemory\b/ },
    { key: 'storage', re: /\bstorage\b|\bspace\b|\bssd\b/ },
    { key: 'camera', re: /\bcamera\b|\bphotos?\b|\bselfie/ },
    { key: 'screen', re: /\bscreen\b|\bdisplay\b|\bbigger\b|\blarger\b/ },
    { key: 'anc', re: /\banc\b|\bnoise\b/ },
    { key: 'water', re: /\bwater|\bswim|\bsweat/ },
    { key: 'gps', re: /\bgps\b/ },
    { key: 'refresh', re: /\brefresh\b|\bhz\b|\bsmooth/ },
    { key: 'gpu', re: /\bgraphics\b|\bgpu\b|\bgaming\b/ },
    { key: 'cpu', re: /\bfast(er|est)?\b|\bpowerful\b|\bperformance\b|\bprocessor\b/ },
    { key: 'output', re: /\blouder\b|\bloud\b|\bvolume\b|\bwatts?\b/ }
  ];
  function superlativeKey(ql) {
    for (var i = 0; i < SUPERLATIVE.length; i++) if (SUPERLATIVE[i].re.test(ql)) return SUPERLATIVE[i].key;
    return null;
  }
  function getForKey(key, p) {
    if (key === 'price') return p.price;
    if (key === 'battery' && p.category === 'Smartphone' && specNum(p, /(\d+)\s*mAh/i)) return specNum(p, /(\d+)\s*mAh/i);
    return CMP[key] ? cmpVal(key, p) : null;
  }
  function fmtForKey(key, p) {
    if (key === 'price') return inr(p.price);
    if (key === 'battery' && p.category === 'Smartphone' && specNum(p, /(\d+)\s*mAh/i)) return CMP.mah.fmt(p);
    return CMP[key].fmt(p);
  }
  var KEY_PHRASE = { weight: ['is lighter', 'is the lightest'], price: ['is cheaper', 'is the cheapest'], battery: ['has the better battery', 'has the best battery'],
    ram: ['has more RAM', 'has the most RAM'], storage: ['has more storage', 'has the most storage'], camera: ['has the better camera', 'has the best camera'],
    screen: ['has the bigger screen', 'has the biggest screen'], anc: ['has noise cancellation', 'has noise cancellation'], water: ['is more water-resistant', 'is the most water-resistant'],
    gps: ['has GPS', 'has GPS'], refresh: ['has the smoother screen', 'has the smoothest screen'], gpu: ['has the stronger graphics', 'has the strongest graphics'],
    cpu: ['is faster', 'is the fastest'], output: ['is louder', 'is the loudest'] };

  function superlativeAnswer(key, items) {
    var dir = key === 'price' || key === 'weight' ? -1 : 1;
    var have = items.filter(function (p) { return getForKey(key, p) != null; });
    if (!have.length) return null;
    var sorted = have.slice().sort(function (x, y) { return (getForKey(key, y) - getForKey(key, x)) * dir; });
    var best = sorted[0];
    var two = items.length === 2;
    var verb = KEY_PHRASE[key] ? KEY_PHRASE[key][two ? 0 : 1] : 'wins';
    var tied = sorted.filter(function (p) { return getForKey(key, p) === getForKey(key, best); });
    var vals = items.map(function (p) { return p.name + ' — ' + inr(p.price) + ': ' + (getForKey(key, p) == null ? 'n/a' : fmtForKey(key, p)); });
    var head;
    if (tied.length === items.length) head = 'They\'re the same here — ' + (key === 'anc' || key === 'gps' ? (getForKey(key, best) ? 'both have it.' : 'neither has it.') : 'both have ' + fmtForKey(key, best) + '.');
    else if ((key === 'anc' || key === 'gps') && tied.length > 1) head = joinNatural(tied.map(function (p) { return '**' + p.name + '**'; })) + ' have it.';
    else head = 'The **' + best.name + '** ' + verb + (key === 'price' ? ' at ' + inr(best.price) : ' (' + fmtForKey(key, best) + ')') + '.';
    return { text: head + '\n\n' + vals.map(function (v) { return '- ' + v; }).join('\n'), best: best };
  }

  // ---------------------------------------------------------------- product question
  function detectAttr(ql) {
    if (/\banc\b|\bnoise\b/.test(ql)) return 'anc';
    if (/\bcamera\b|\bphotos?\b|\bselfie|\bmp\b|\bmegapixel/.test(ql)) return 'camera';
    if (/\bgps\b|\bnavigation\b|\bmaps\b/.test(ql)) return 'gps';
    if (/\bwater|\bsweat|\bswim|\brain\b|\bip\s?\d\d|\bipx/.test(ql)) return 'water';
    if (/\bram\b|\bmemory\b/.test(ql)) return 'ram';
    if (/\bstorage\b|\bssd\b|\bspace\b/.test(ql)) return 'storage';
    if (/\bbattery\b|\bbackup\b|\bcharge\b|\blast(s)? (long|how)/.test(ql)) return 'battery';
    if (/\bgpu\b|\bgraphics\b|\brtx\b|\bgraphic card\b/.test(ql)) return 'gpu';
    if (/\bprocessor\b|\bcpu\b|\bchip(set)?\b/.test(ql)) return 'cpu';
    if (/\brefresh\b|\bhz\b/.test(ql)) return 'refresh';
    if (/\bresolution\b|\b4k\b|\bqhd\b|\bfull hd\b|\b1080p?\b/.test(ql)) return 'resolution';
    if (/\bscreen\b|\bdisplay\b|\binch(es)?\b|\bsize\b/.test(ql)) return 'screen';
    if (/\bweigh|\bheavy\b|\blight(weight)?\b/.test(ql)) return 'weight';
    if (/\bwireless\b|\bbluetooth\b/.test(ql)) return 'wireless';
    if (/\bloud\b|\boutput\b|\bwatts?\b/.test(ql)) return 'output';
    if (/\bin stock\b|\bavailab|\bstock\b/.test(ql)) return 'stock';
    if (/\bprice\b|\bcost\b|\bhow much\b|\brate\b/.test(ql)) return 'price';
    return null;
  }
  var ATTR_LABEL = { anc: 'noise cancellation', camera: 'a camera', gps: 'GPS', water: 'water resistance', ram: 'RAM', storage: 'storage', battery: 'battery',
    gpu: 'graphics', cpu: 'processor', refresh: 'refresh rate', resolution: 'resolution', screen: 'screen', weight: 'weight', wireless: 'wireless', output: 'output' };

  function rankInCategory(p, key, catalog) {
    var dir = key === 'weight' || key === 'price' ? -1 : 1;
    var same = catalog.filter(function (q) { return q.category === p.category && getForKey(key, q) != null; });
    if (same.length < 3) return '';
    same.sort(function (x, y) { return (getForKey(key, y) - getForKey(key, x)) * dir; });
    var v = getForKey(key, p);
    var rank = same.filter(function (q) { return (getForKey(key, q) - v) * dir > 0; }).length + 1;
    var word = { weight: 'lightest', price: 'most affordable', battery: 'longest battery', ram: 'most RAM', storage: 'most storage', camera: 'highest-resolution camera',
      screen: 'biggest screen', refresh: 'highest refresh rate', cpu: 'fastest processor', gpu: 'strongest graphics', output: 'loudest', resolution: 'sharpest', water: 'best water rating' }[key];
    if (!word) return '';
    if (rank === 1) return ' — the ' + word + ' of our ' + same.length + ' ' + CAT_PLURAL[p.category];
    if (rank <= 3) return ' — #' + rank + ' for ' + word.replace(/^(most|longest|highest|biggest|fastest|strongest|loudest|sharpest|best|lightest)\s*/, function (m0) { return m0; }) + ' among our ' + CAT_PLURAL[p.category];
    return '';
  }

  function useCaseVerdict(p, ucId, catalog) {
    var uc = ucById(ucId);
    var same = catalog.filter(function (q) { return q.category === p.category; });
    var prof = activeProfile(uc.weights, same);
    if (!prof.length || same.length < 2) return null;
    var ranked = same.slice().sort(function (x, y) { return specScore(prof, y) - specScore(prof, x) || x.price - y.price; });
    var rank = ranked.indexOf(p) + 1;
    var best = ranked[0];
    var keySpecs = prof.slice(0, 3).map(function (a) { return ATTRS[a.key].get(p) != null ? ATTRS[a.key].fmt(p) : null; }).filter(Boolean);
    var s;
    if (rank === 1) s = '**Yes** — it\'s our best ' + CAT_WORD[p.category] + ' for ' + uc.label + ' (' + joinNatural(keySpecs) + ').';
    else if (rank <= Math.max(2, Math.ceil(same.length / 3))) s = '**Yes, it\'s a strong choice** for ' + uc.label + ' — #' + rank + ' of our ' + same.length + ' ' + CAT_PLURAL[p.category] + ' (' + joinNatural(keySpecs) + '). The top pick is the **' + best.name + '** (' + inr(best.price) + ').';
    else s = '**It\'ll manage light ' + uc.label + '**, but it isn\'t built for it (' + joinNatural(keySpecs) + '). For ' + uc.label + ' the **' + best.name + '** (' + inr(best.price) + ') is a much better fit.';
    return { text: s, best: best };
  }

  function productAnswer(p, ql, catalog, ucId) {
    var key = detectAttr(ql);
    var out = [];
    var alt = null;
    var stock = p.in_stock === false ? ' It\'s currently **out of stock**.' : '';
    function closestWith(pred) {
      return catalog.filter(function (q) { return q.id !== p.id && q.category === p.category && pred(q); })
        .sort(function (x, y) { return Math.abs(x.price - p.price) - Math.abs(y.price - p.price); })[0] || null;
    }
    if (ucId && !key) {
      var v = useCaseVerdict(p, ucId, catalog);
      if (v) { out.push('**' + p.name + '** — ' + inr(p.price) + '. ' + v.text); out.push('Specs: ' + p.specs + '.' + stock); if (v.best.id !== p.id) alt = v.best; return { text: out.join('\n\n'), alt: alt }; }
    }
    if (key === 'price') {
      out.push('The **' + p.name + '** costs **' + inr(p.price) + '**' + rankInCategory(p, 'price', catalog) + '.' + (p.in_stock === false ? ' It\'s currently out of stock.' : ' It\'s in stock.'));
      out.push('Specs: ' + p.specs + '.');
    } else if (key === 'stock') {
      out.push(p.in_stock === false ? 'Sorry — the **' + p.name + '** (' + inr(p.price) + ') is **out of stock** right now.' : 'Yes — the **' + p.name + '** (' + inr(p.price) + ') is **in stock**.');
    } else if (key === 'anc' || key === 'gps' || key === 'wireless') {
      var field = key === 'wireless' ? 'wireless' : key;
      var has = attr(p, field);
      var detail = specBits(p, 6).filter(function (s) { return new RegExp(key === 'anc' ? 'anc' : key === 'gps' ? 'gps' : 'bluetooth|wireless|wi-fi', 'i').test(s); })[0];
      if (has === true || (has == null && detail)) out.push('**Yes** — the **' + p.name + '** (' + inr(p.price) + ') has ' + (detail ? '**' + detail + '**' : ATTR_LABEL[key]) + '.');
      else if (has === false) {
        out.push('**No** — the **' + p.name + '** (' + inr(p.price) + ') doesn\'t have ' + ATTR_LABEL[key] + '.');
        alt = closestWith(function (q) { return attr(q, field) === true; });
        if (alt) out.push('If you need it, the closest option is the **' + alt.name + '** (' + inr(alt.price) + ') — ' + specBits(alt, 3).join(', ') + '.');
      } else out.push('That doesn\'t apply to the **' + p.name + '** (' + inr(p.price) + ') — it\'s a ' + CAT_WORD[p.category] + '. Its specs: ' + p.specs + '.');
      if (has != null || detail) out.push('Full specs: ' + p.specs + '.' + stock);
    } else if (key === 'camera' && p.category !== 'Smartphone') {
      out.push('The **' + p.name + '** (' + inr(p.price) + ') doesn\'t have a camera listed — it\'s a ' + CAT_WORD[p.category] + '. Specs: ' + p.specs + '.');
    } else if (key && (getForKey(key, p) != null || (key === 'camera'))) {
      var val = key === 'camera' ? CMP.camera.fmt(p) : key === 'water' ? (attr(p, 'water_resistance') ? attr(p, 'water_resistance') + ' water resistance' : 'no water-resistance rating')
        : key === 'gpu' ? ATTRS.gpu.fmt(p) : key === 'cpu' ? attr(p, 'cpu') + ' processor' : key === 'battery' ? (p.category === 'Smartphone' && specNum(p, /(\d+)\s*mAh/i) ? CMP.mah.fmt(p) + ' battery' : ATTRS.battery.fmt(p))
        : key === 'screen' ? attr(p, 'display_in') + '-inch display' : key === 'weight' ? weightFmt(attr(p, 'weight_kg')) : key === 'refresh' ? attr(p, 'refresh_hz') + 'Hz refresh rate'
        : key === 'resolution' ? ATTRS.resolution.fmt(p) + ' resolution' : key === 'ram' ? attr(p, 'ram_gb') + 'GB RAM' : key === 'storage' ? CMP.storage.fmt(p) + ' storage' : CMP[key].fmt(p);
      out.push('The **' + p.name + '** (' + inr(p.price) + ') has **' + val + '**' + rankInCategory(p, key, catalog) + '.');
      if (key === 'water' && !attr(p, 'water_resistance')) {
        alt = closestWith(function (q) { return !!attr(q, 'water_resistance'); });
        if (alt) out.push('Need water resistance? The **' + alt.name + '** (' + inr(alt.price) + ') is rated ' + attr(alt, 'water_resistance') + '.');
      }
      if (ucId) { var v2 = useCaseVerdict(p, ucId, catalog); if (v2) out.push(v2.text); }
      out.push('Full specs: ' + p.specs + '.' + stock);
    } else if (key) {
      out.push('I don\'t have ' + ATTR_LABEL[key] + ' details listed for the **' + p.name + '** (' + inr(p.price) + '). Here\'s what we do list: ' + p.specs + '.');
    } else {
      out.push('**' + p.name + '** — ' + inr(p.price) + (p.in_stock === false ? ' (out of stock)' : '') + '. ' + p.description);
      out.push('**Key specs:** ' + p.specs + '.');
      var same = catalog.filter(function (q) { return q.category === p.category; }).sort(function (x, y) { return x.price - y.price; });
      if (same.length > 2) out.push('It sits at #' + (same.indexOf(p) + 1) + ' of ' + same.length + ' in our ' + CAT_PLURAL[p.category] + ' by price (' + inr(same[0].price) + '–' + inr(same[same.length - 1].price) + ').');
    }
    return { text: out.join('\n\n'), alt: alt };
  }

  // ---------------------------------------------------------------- canned answers
  var EXAMPLES = ['Laptop for video editing under ₹70,000', 'Wireless headphones under ₹10,000', 'What do you sell?'];
  var GLOSSARY = {
    'anc|noise cancell?(ing|ation)|active noise cancell?(ing|ation)': ['**ANC (active noise cancellation)** uses microphones to listen to outside noise and plays an inverted sound wave to cancel it — great for flights, commutes and open offices. Many of our earbuds and headsets have it.', ['Earbuds with ANC under ₹5,000', 'Headphones with ANC', 'Which earbuds have the longest battery life?']],
    'oled|amoled': ['**OLED / AMOLED** screens light each pixel individually, so you get true blacks, high contrast and vivid colours (AMOLED is the variant used in phones and watches).', ['Phones with AMOLED under ₹30,000', 'Best monitor for gaming', 'What do you sell?']],
    'ltpo': ['**LTPO** is a display technology that lets the refresh rate drop as low as 1Hz when nothing moves, saving battery while still scrolling at 120Hz.', ['Best phone for camera', 'Phones under ₹40,000', 'What do you sell?']],
    'refresh rate|hz|high refresh rate': ['**Refresh rate (Hz)** is how many times per second the screen redraws. 60Hz is standard; 120–240Hz feels much smoother for scrolling and gaming.', ['Monitor for gaming', 'Gaming laptop under ₹1,00,000', 'Phones with 120Hz under ₹30,000']],
    'ip ?rating|ip ?\\d\\d|ipx ?\\d|water resistance|atm|5atm|10atm': ['**IP / ATM ratings** describe dust and water protection. IPX4 = splash/sweat proof, IP67/IP68 = survives dunking, 5ATM/10ATM = fine for swimming.', ['Waterproof speaker', 'Earbuds for gym', 'Best smartwatch for running']],
    'ssd': ['An **SSD** is fast flash storage — it makes a laptop boot, open apps and load files far quicker than an old hard drive. All our laptops use SSDs.', ['Laptop with 1TB SSD', 'Laptop for students', 'What do you sell?']],
    'ram|memory': ['**RAM** is a device\'s short-term working memory — more RAM lets you keep more apps and browser tabs open smoothly. 8GB is fine for everyday use; 16GB+ is better for coding, editing and gaming.', ['Laptop with 16GB RAM under ₹70,000', 'Does the NovaBook Air have enough RAM for coding?', 'Phones with 12GB RAM']],
    'gpu|graphics card|rtx': ['A **GPU** (graphics card) handles graphics and video. A dedicated one like an RTX 4050/4060 makes gaming and video exports much faster than integrated graphics.', ['Gaming laptop under ₹1,00,000', 'Laptop for video editing under ₹70,000', 'Compare Zentra Vision 15 and Pixelon Blaze 15']],
    'ldac|spatial audio|multipoint|dolby atmos': ['These are audio features: **LDAC** streams hi-res Bluetooth audio, **spatial audio** creates a surround effect, **multipoint** pairs two devices at once and **Dolby Atmos** is immersive surround sound.', ['Earbuds with ANC', 'Best speaker', 'What do you sell?']],
    'qhd|4k|full hd|fhd|resolution': ['**Resolution** is the number of pixels: Full HD = 1920×1080, QHD = 2560×1440, 4K = 3840×2160. Higher means sharper text and more workspace.', ['Best monitor for video editing', 'Monitor for gaming', 'Cheapest monitor']]
  };
  var JOKES = [
    'Why did the laptop go to the doctor? It had a bad case of the *bytes*. (Ours come with healthy SSDs, promise.)',
    'My phone and I have a lot in common — we both hit 1% by evening. That\'s why the **Arcwave Max 10** packs a 6000mAh battery.',
    'I told my monitor a joke. It didn\'t laugh, but it did *refresh* — 165 times a second.',
    'Why don\'t wireless earbuds ever argue? They hate getting *tangled up* in things.'
  ];
  function catalogSummary(catalog) {
    var cats = CATEGORIES.filter(function (c) { return catalog.some(function (p) { return p.category === c; }); });
    return { cats: cats, text: joinNatural(cats.map(function (c) { return CAT_PLURAL[c]; })) };
  }
  function overviewAnswer(catalog) {
    var sum = catalogSummary(catalog);
    var lines = sum.cats.map(function (c) {
      var ps = catalog.filter(function (p) { return p.category === c; });
      var prices = ps.map(function (p) { return p.price; });
      return '- **' + CAT_TITLE[c] + '** — ' + ps.length + ' model' + (ps.length === 1 ? '' : 's') + ', ' + inr(Math.min.apply(null, prices)) + ' to ' + inr(Math.max.apply(null, prices));
    });
    var brands = uniq(catalog.map(function (p) { return p.brand; }).filter(Boolean));
    return 'TechMart carries **' + catalog.length + ' products** across ' + sum.cats.length + ' categories:\n\n' + lines.join('\n') +
      (brands.length ? '\n\nBrands: ' + brands.join(', ') + '.' : '') + '\n\nTell me a category, a budget or what you\'ll use it for and I\'ll pick the best match.';
  }

  // ---------------------------------------------------------------- suggestions
  var CAT_THIRD = { Laptop: 'Which has the best battery?', Smartphone: 'Which has the best camera?', Tablet: 'Which has the most storage?',
    Earbuds: 'Which has ANC?', Headset: 'Which has ANC?', Smartwatch: 'Which has GPS?', Speaker: 'Which is waterproof?', Monitor: 'Which is best for gaming?' };
  function suggestFor(kind, ctx) {
    ctx = ctx || {};
    var cat = ctx.cats && ctx.cats.length ? ctx.cats[0] : null;
    var catPl = ctx.cats && ctx.cats.length ? catsNoun(ctx.cats) : 'laptops';
    var third = cat ? CAT_THIRD[cat] : 'Which has the best battery?';
    if ((cat === 'Earbuds' || cat === 'Headset') && ctx.plan && ctx.plan.need_anc) third = 'Which has the best battery?';
    if (cat === 'Laptop' && ctx.plan && ctx.plan.boosts && ctx.plan.boosts.battery) third = 'Which is lightest?';
    var s;
    switch (kind) {
      case 'recommendation':
        s = ctx.count > 1 ? ['Anything cheaper?', 'Compare the top two', third] : ['Tell me more about it', 'Show more ' + catPl, 'Anything cheaper?'];
        break;
      case 'list':
        s = ctx.count > 1 ? ['Compare the top two', 'Tell me more about the first one', ctx.cheapest ? 'Show the most expensive ' + catPl : 'Cheapest ' + (cat ? CAT_WORD[cat] : 'option')] : ['Tell me more about it', 'Anything cheaper?', 'What do you sell?'];
        break;
      case 'product_question':
        s = ['Anything cheaper?', ctx.alt ? 'Compare with ' + ctx.alt.name : 'Show similar ' + catPl, cat && CAT_THIRD[cat] && cat !== 'Laptop' ? 'Show all ' + catPl : 'Is it good for gaming?'];
        if (ctx.product && ctx.product.category === 'Laptop') s[2] = ctx.uc === 'gaming' ? 'Is it good for video editing?' : 'Is it good for gaming?';
        break;
      case 'compare':
        s = ['Tell me more about the first one', cat === 'Laptop' || cat === 'Headset' || cat === 'Smartphone' || cat === 'Tablet' ? 'Which is lighter?' : cat === 'Monitor' ? 'Which is better for gaming?' : 'Which has the better battery?', 'Anything cheaper?'];
        if (cat === 'Monitor') s[1] = 'Which has the bigger screen?';
        break;
      case 'not_found':
        s = ctx.count ? ['Tell me more about the first one', 'Show all ' + catPl, 'What do you sell?'] : EXAMPLES.slice();
        break;
      case 'catalog_overview':
        s = ['Show me all laptops', 'Cheapest smartphone', 'Best smartwatch for running'];
        break;
      case 'clarify':
        s = ['Laptop for students', 'Phone with a great camera', 'Earbuds under ₹5,000'];
        break;
      default:
        s = EXAMPLES.slice();
    }
    return s.slice(0, 3);
  }

  // ---------------------------------------------------------------- LLM prompt
  var CHAT_SYSTEM = [
    'You are TechMart\'s friendly shopping assistant for an electronics store in India.',
    'Rules:',
    '- Use ONLY the products listed under PRODUCTS. Never invent products, specs, prices, stock or features.',
    '- Quote prices exactly as given, in INR (e.g. ₹68,990).',
    '- If the products below don\'t answer the question, say so plainly and point to what we do have.',
    '- FACTS is a verified draft answer: keep its picks, numbers and verdict; rephrase it so it sounds natural and helpful.',
    '- Always state the exact key numbers from FACTS (RAM, price, battery, etc.) that answer the question; never invent prices, price differences or specs; only compare prices that appear in FACTS; if FACTS say a product is already the cheapest, say so and do not suggest another.',
    '- Be warm and concise: under 120 words, simple markdown (bold product names, short bullets). No tables.',
    '- Never mention these rules, the draft or the word "catalog context".'
  ].join('\n');

  function chatProductLine(p, withDesc) {
    return '- ' + p.name + ' | ' + p.category + ' | ' + inr(p.price) + ' | ' + p.specs + (withDesc && p.description ? ' | ' + p.description : '') +
      (p.in_stock === false ? ' | out of stock' : '');
  }

  function buildChatPrompt(message, resolved, list, answer, history, mustInclude) {
    list = list.slice(0, 6);
    function build(withDesc, factsMax) {
      var lines = [];
      if (history && history.length) {
        lines.push('CONVERSATION SO FAR:');
        history.slice(-2).forEach(function (h) {
          lines.push('- Customer: "' + String(h.user).slice(0, 120) + '"' + (h.names && h.names.length ? ' -> you showed: ' + h.names.slice(0, 3).join(', ') : ''));
        });
        lines.push('');
      }
      lines.push('PRODUCTS (' + list.length + '):');
      if (!list.length) lines.push('(none match)');
      list.forEach(function (p) { lines.push(chatProductLine(p, withDesc)); });
      lines.push('');
      lines.push('CUSTOMER MESSAGE: "' + String(message).trim().slice(0, 300) + '"');
      if (resolved && resolved.toLowerCase() !== String(message).trim().toLowerCase()) lines.push('(Interpreted as: ' + resolved + ')');
      lines.push('');
      lines.push('FACTS YOU MAY USE:');
      lines.push(answer.length > factsMax ? answer.slice(0, factsMax) + '…' : answer);
      lines.push('');
      if (mustInclude) lines.push('Start your reply with: ' + mustInclude);
      lines.push('Write your reply to the customer now.');
      return lines.join('\n');
    }
    var user = build(true, 1600);
    if (estimateTokens(CHAT_SYSTEM + user) > 900) user = build(false, 1600);
    if (estimateTokens(CHAT_SYSTEM + user) > 900) user = build(false, 900);
    return { system: CHAT_SYSTEM, user: user };
  }

  var NO_LLM_RE = /already the most affordable match|^None of our |^Sorry — none of our |^Nothing in our catalog fits|Nothing in our catalog matches \*\*[^*]+\*\* exactly|^That's everything we have/m;
  // numbers stated in the answer's first sentence ("8GB", "₹52,000", "10hr", "IP68") for product questions
  function factNumbers(answer) {
    // first sentence that states numbers ("**Yes, for everyday coding.** The NovaBook Air 14 (₹52,000) has 8GB RAM…" -> 2nd sentence)
    var re = /₹[\d,]+|\bIP[X\d]\d\b|\b\d+ATM\b|\b\d+(?:\.\d+)?\s?(?:GB|TB|MP|mAh|Hz|hr|-day|-inch|kg|g|W|% sRGB)(?![A-Za-z])/g;
    var sentences = String(answer).replace(/\*\*/g, '').split('\n')[0].replace(/([.!?])\s+(?=[A-Z])/g, '$1\u0001').split('\u0001');
    var m = [];
    for (var i = 0; i < sentences.length && !m.length; i++) m = sentences[i].match(re) || [];
    return uniq(m.map(function (x) { return x.replace(/\s+(?=GB|TB|MP|mAh|Hz|hr|kg|g\b|W)/, ''); }));
  }

  // ---------------------------------------------------------------- converse()
  /**
   * converse(message, products, state, {stage, k}) -> {kind, needs_llm, answer, products, suggestions, run, llm, resolved_query, state}
   */
  function converse(message, products, state, opts) {
    opts = opts || {};
    var stage = Number(opts.stage) || 3;
    var k = opts.k || 5;
    var all = Array.isArray(products) ? products : [];
    var catalog = all;
    if (stage === 1) {
      var starter = all.filter(function (p) { return STARTER_IDS.indexOf(p.id) !== -1; });
      if (starter.length) catalog = starter;
    }
    state = state && typeof state === 'object' ? state : null;
    var raw = String(message == null ? '' : message);
    var meta = catalogMeta(catalog);
    raw = focusLongMessage(raw, catalog);
    var ql0 = normalizeMessage(raw);
    var ql = correctTypos(ql0, catalog, parseQuery(ql0, catalog).categories.length > 0);
    var lastIds = state && Array.isArray(state.last_ids) ? state.last_ids.filter(function (id) { return meta.byId[id]; }) : [];
    var lastPlan = state && state.last_plan ? state.last_plan : null;
    var lastProducts = lastIds.map(function (id) { return meta.byId[id]; });

    var res = { kind: 'clarify', needs_llm: false, answer: '', products: [], suggestions: [], run: null, llm: null, resolved_query: ql,
      must_include: null, facts_numbers: [], state: null };
    var ctx = {};
    var planForState = null, idsForState = null;
    var listForPrompt = [];

    function finish() {
      if (!res.answer) res.answer = 'Sorry, I didn\'t catch that. What are you shopping for?';
      if (!res.suggestions.length) res.suggestions = suggestFor(res.kind, ctx);
      var retrievalKinds = ['product_question', 'recommendation', 'list', 'compare', 'not_found'];
      res.needs_llm = retrievalKinds.indexOf(res.kind) !== -1 && res.products.length > 0;
      // deterministic "nothing cheaper / nothing matches" answers go out as-is: a small model invents products here
      if (res.needs_llm && NO_LLM_RE.test(res.answer)) res.needs_llm = false;
      var mi = res.answer.match(/^Sorry, we don't carry[^\n]*?[.:](?=\s|$)/);
      res.must_include = mi ? mi[0] : null;
      res.facts_numbers = res.kind === 'product_question' ? factNumbers(res.answer) : [];
      var hist = (state && Array.isArray(state.history) ? state.history.slice(-1) : []);
      if (res.needs_llm) {
        var pl = listForPrompt.length ? listForPrompt : res.products.map(function (c) { return meta.byId[c.id]; }).filter(Boolean);
        res.llm = buildChatPrompt(raw, res.resolved_query, pl, res.answer, hist, res.must_include);
      }
      var isRetrieval = retrievalKinds.indexOf(res.kind) !== -1;
      var newIds = idsForState || res.products.map(function (c) { return c.id; });
      res.state = {
        turn: (state && Number(state.turn) > 0 ? Math.floor(Number(state.turn)) : 0) + 1,
        last_query: isRetrieval ? res.resolved_query : (state ? state.last_query || '' : ''),
        last_plan: isRetrieval && planForState ? cloneJSON(planForState) : (lastPlan ? cloneJSON(lastPlan) : null),
        last_ids: isRetrieval && newIds.length ? newIds.slice(0, 6) : lastIds.slice(),
        last_kind: res.kind,
        history: hist.concat([{ user: raw.slice(0, 200), resolved: res.resolved_query, kind: res.kind, names: res.products.map(function (c) { return c.name; }) }]).slice(-2)
      };
      return res;
    }

    // ---- empty / whitespace
    if (!ql || !/[a-z0-9]/.test(ql)) {
      res.kind = 'clarify';
      res.answer = 'Ask me anything about TechMart\'s ' + catalogSummary(catalog).text + ' — for example *"best phone for camera"* or *"compare Zentra Vision 15 and Pixelon Slim 14"*.';
      return finish();
    }

    var cur = parseQuery(ql, catalog);
    var pins = findProducts(ql, catalog);
    var pinIds = pins.map(function (x) { return x.id; });
    var cats = cur.categories.slice();
    var unknown = findUnknown(ql, cats.length > 0);
    var brands = mentionedBrands(ql, catalog);
    var ords = ordinalRefs(ql);
    var hasPrice = cur.price_max != null || cur.price_min != null;
    // catalog words that count as a shopping signal (single letters like the "x" of "Arena X" never do)
    var kwKnown = cur.keywords.filter(function (t) { return t.length >= 3 && meta.vocab.has(t) && !FOLLOW_STOP.has(t); });
    var isCompare = RX.compare.test(ql) || (pins.length >= 2 && /\bor\b/.test(ql));
    var hasState = !!(lastPlan || lastIds.length);
    var signals = !!(cats.length || pins.length || unknown || cur.use_case || hasPrice || cur.need_anc || cur.need_wireless || Object.keys(cur.boosts).length ||
      brands.length || RX.featureWords.test(ql) || RX.overview.test(ql) || isCompare || RX.cheapest.test(ql) || RX.priciest.test(ql) ||
      (hasState && (RX.cheaper.test(ql) || RX.pricier.test(ql) || RX.more.test(ql) || RX.refine.test(ql) || ords.length || (RX.pronoun.test(ql) && RX.detail.test(ql)) || RX.compareRef.test(ql))));
    var tokCount = wordTokens(ql).length;

    // ---- creative / general-knowledge requests: always off-topic
    if (RX.strongOff.test(ql) && !pins.length && !(cats.length && !/\bpoem|\bhaiku|\bstory|\bessay|\bsong\b/.test(ql))) {
      res.kind = 'off_topic';
      var topic = /weather|temperature/.test(ql) ? 'the weather' : /poem|haiku|story|essay|song|letter|limerick/.test(ql) ? 'creative writing' :
        /capital|president|prime minister|who is the/.test(ql) ? 'general-knowledge questions' : /cricket|ipl|who won/.test(ql) ? 'sports scores' :
        /bitcoin|crypto|stock market/.test(ql) ? 'markets or investing' : /recipe/.test(ql) ? 'recipes' : /\d/.test(ql) ? 'maths' : 'that';
      res.answer = 'I\'m TechMart\'s shopping assistant, so I can\'t help with ' + topic + ' — but I\'d love to help you find the right gadget. We carry ' + catalogSummary(catalog).text + '.';
      return finish();
    }

    // ---- "what is ANC?" style jargon questions -> short definition
    var gm = !pins.length && !cats.length && ql.match(/^(?:what is|whats|what does|what do you mean by|define|meaning of|explain)\s+(?:an?\s+|the\s+)?([a-z0-9 -]+?)(?:\s+mean|\s+means|\s+stand for)?$/);
    if (gm) {
      var gKey = Object.keys(GLOSSARY).filter(function (g) { return new RegExp('^(?:' + g + ')$').test(gm[1].trim()); })[0];
      if (gKey) {
        res.kind = 'help';
        res.answer = GLOSSARY[gKey][0];
        res.suggestions = GLOSSARY[gKey][1].slice();
        return finish();
      }
    }

    // ---- social intents (only when the message carries no shopping content)
    if (!signals) {
      if (RX.smalltalk.test(ql)) {
        res.kind = 'smalltalk';
        if (RX.joke.test(ql)) res.answer = JOKES[((state && state.turn) || 0) % JOKES.length] + '\n\nWant me to find you something?';
        else if (/\bhow are|how r u|hows it|how is it|how (is|was) your day|whats up|wassup|\bsup\b/.test(ql)) res.answer = 'Doing great, thanks for asking! Ready to help you find the right gadget — what are you shopping for today?';
        else if (/\blol\b|\blmao\b|\brofl\b|\bha(ha)+\b|\bhe(he)+\b|\bfunny\b/.test(ql)) res.answer = 'Glad that made you smile! Anything I can help you find?';
        else if (/\bdumb\b|\bstupid\b|\buseless\b|\bbad bot\b/.test(ql)) res.answer = 'Sorry about that — I\'ll do better. Tell me what you\'re looking for (a category, budget or use) and I\'ll find the best match.';
        else res.answer = 'Aw, thanks! I\'m happiest helping people pick gadgets — what can I find for you?';
        return finish();
      }
      if (RX.bye.test(ql)) {
        res.kind = 'thanks';
        res.answer = 'Bye for now! Come back any time you need help choosing a gadget.';
        return finish();
      }
      if (RX.thanks.test(ql)) {
        res.kind = 'thanks';
        res.answer = /\b(thanks?|thank you|thx|tysm|ty|thanku|thankyou|shukriya|dhanyavad|appreciate)/.test(ql) ? 'You\'re welcome! Anything else I can help you find?' : 'Great! Anything else I can help you find?';
        return finish();
      }
      if (RX.help.test(ql)) {
        res.kind = 'help';
        res.answer = 'I\'m TechMart\'s shopping assistant. I only know our own catalog of **' + catalog.length + ' products** (' + catalogSummary(catalog).text + '), and I can:\n\n' +
          '- **Recommend** something for your budget and use (gaming, video editing, coding, students, travel, workouts…)\n' +
          '- **Answer questions** about a product — battery, RAM, ANC, price, stock\n' +
          '- **Compare** two models side by side\n' +
          '- **Browse** a category, cheapest first or by price\n\nFollow-ups like *"anything cheaper?"* or *"compare the top two"* work too.';
        return finish();
      }
      if (RX.greeting.test(ql)) {
        res.kind = 'greeting';
        res.answer = 'Hi there! I\'m TechMart\'s shopping assistant. I can recommend, compare and answer questions about our ' + catalogSummary(catalog).text + '. What are you looking for today?';
        return finish();
      }
    }
    // strip a leading greeting from mixed messages ("hi, I need a laptop")
    ql = ql.replace(/^(hi+|hello+|hey+|namaste|hola|good (morning|afternoon|evening))\b[\s,.-]*/, '').trim() || ql;

    // ---- non-electronics items -> off topic
    if (!cats.length && !pins.length && !unknown && RX.nonElec.test(ql) && !cur.use_case) {
      var item = ql.match(RX.nonElec)[0];
      res.kind = 'off_topic';
      res.answer = 'We don\'t sell ' + (/s$/.test(item) || /clothes|clothing|food|furniture|groceries|jeans|cosmetics|makeup|insurance/.test(item) ? item : item + 's') +
        ' — TechMart is an electronics store. We carry ' + catalogSummary(catalog).text + '. Can I help you with any of those?';
      return finish();
    }

    // ---------------------------------------------------------------- helpers bound to this turn
    function retrievalTurn(plan, text, kOverride) {
      var r = runPlan(text, catalog, plan, stage, kOverride || k);
      if (plan.cheaper_than || plan.sport_earbuds) {  // chat-only hard filters
        var retc = r.retrieval;
        var keepFn = function (x) {
          if (plan.cheaper_than && x.product.price >= plan.cheaper_than.price) return false;
          if (plan.sport_earbuds && x.product.category === 'Earbuds' && ATTRS.water.get(x.product) < 5) return false;
          return true;
        };
        var kept = retc.all_ranked.filter(keepFn);
        if (kept.length !== retc.all_ranked.length) {
          retc.funnel.splice(retc.funnel.length - 1, 0, { label: plan.cheaper_than ? 'Cheaper than ' + plan.cheaper_than.name : 'Sport earbuds (IP55+)', count: kept.length });
          retc.all_ranked = kept; retc.results = kept.slice(0, kOverride || k); retc.candidates_count = kept.length;
          retc.excluded = retc.excluded.filter(function (e) { return !plan.cheaper_than || e.product.price < plan.cheaper_than.price; });
          r.prompt = buildPrompt(text, { stage: stage === 1 ? 2 : stage, retrieval: retc });
        }
      }
      if (plan.need_gps) {  // GPS is not a hard filter in retrieve(); apply it here
        var ret0 = r.retrieval;
        var g = ret0.all_ranked.filter(function (x) { return attr(x.product, 'gps') === true; });
        if (g.length) {
          ret0.funnel.splice(ret0.funnel.length - 1, 0, { label: 'GPS', count: g.length });
          ret0.all_ranked = g; ret0.results = g.slice(0, kOverride || k); ret0.candidates_count = g.length;
          g.forEach(function (x) { if (x.why.indexOf('Built-in GPS') === -1) x.why.push('Built-in GPS'); });
          r.prompt = buildPrompt(text, { stage: stage === 1 ? 2 : stage, retrieval: ret0 });
        }
      }
      res.run = r; res.resolved_query = text;
      planForState = plan;
      return r;
    }
    function setRecommendation(r, lead) {
      var ret = r.retrieval;
      if (!ret.results.length) return false;
      res.kind = 'recommendation';
      res.answer = (lead ? lead + '\n\n' : '') + recommendationAnswer(r.question, ret).replace(/\bsame no ANC\b/g, 'also no ANC');
      res.products = cardsFromResults(ret.results, 3);
      listForPrompt = ret.results.slice(0, 5).map(function (x) { return x.product; });
      ctx = { cats: ret.categories_used.length ? ret.categories_used : uniq(ret.results.map(function (x) { return x.product.category; })).slice(0, 1), count: ret.results.length, plan: ret.plan };
      idsForState = ret.results.slice(0, 5).map(function (x) { return x.product.id; });
      return true;
    }
    function setList(r, mode, lead) {
      var ret = r.retrieval;
      var ranked = ret.all_ranked.map(function (x) { return x; });
      if (mode === 'priciest') ranked.sort(function (a, b) { return b.product.price - a.product.price; });
      if (mode === 'cheapest') ranked.sort(function (a, b) { return a.product.price - b.product.price; });
      if (!ranked.length) return false;
      var shown = ranked.slice(0, 6);
      var cats2 = ret.categories_used;
      var noun = catsNoun(cats2);
      var scope = scopePhrase(ret);
      var out = [];
      if (lead) out.push(lead);
      if (ret.relaxed) out.push(relaxedLead(ret));
      if (mode === 'cheapest') {
        var c0 = shown[0].product;
        out.push('The most affordable of our ' + scope + ' is the **' + c0.name + '** at **' + inr(c0.price) + '** (' + specBits(c0, 3).join(', ') + ').');
        if (shown.length > 1) out.push('Next up by price:\n' + shown.slice(1, 5).map(function (x) { return bullet(x.product); }).join('\n'));
      } else if (mode === 'priciest') {
        var e0 = shown[0].product;
        out.push('Our most premium ' + CAT_WORD[e0.category] + (cats2.length ? '' : ' overall') + ' is the **' + e0.name + '** at **' + inr(e0.price) + '** (' + specBits(e0, 3).join(', ') + ').');
        if (shown.length > 1) out.push('Next by price:\n' + shown.slice(1, 5).map(function (x) { return bullet(x.product); }).join('\n'));
      } else {
        var total = ret.candidates_count;
        var forWhat = ret.plan.use_case ? ' for ' + ret.plan.use_case_label : '';
        out.push((total > shown.length ? 'Here are the top ' + shown.length + ' of our ' + total + ' ' : 'Here ' + (shown.length === 1 ? 'is' : 'are') + ' our ') + scope + forWhat + ':');
        out.push(shown.map(function (x) { return bullet(x.product); }).join('\n'));
        if (shown.length > 1 && (ret.profile.length || ret.plan.use_case)) out.push('**Top pick: ' + shown[0].product.name + ' (' + inr(shown[0].product.price) + ')** — ' + joinNatural(topReasons(shown[0], 4).map(stripBest).filter(function (w) { return w.charAt(0) !== '₹'; }).slice(0, 3)) + '.');
        else if (shown.length > 1) out.push('Want a recommendation? Tell me your budget or what you\'ll use it for.');
      }
      res.kind = 'list';
      res.answer = out.join('\n\n');
      res.products = shown.slice(0, 3).map(function (x, i) { return card(x.product, x.why.filter(function (w) { return w !== 'Named in your question'; }), i === 0 && mode !== 'priciest' && (ret.profile.length || mode === 'cheapest') ? 'Best pick' : ''); });
      listForPrompt = shown.map(function (x) { return x.product; });
      idsForState = shown.map(function (x) { return x.product.id; });
      ctx = { cats: cats2.length ? cats2 : [shown[0].product.category], count: shown.length, cheapest: mode === 'cheapest', plan: ret.plan };
      void noun;
      return true;
    }
    function setProduct(p, qText, ucId, extraLead) {
      var restTxt = wordTokens(qText || '').filter(function (t) { return !STOPWORDS.has(t) && !/^(tell|more|about|details|info|specs?|first|second|third|one|is|it|the)$/.test(t); }).join(' ');
      var resolved = p.name + (restTxt ? ' ' + restTxt : '');
      var pa = null;
      var key = detectAttr(qText || '');
      // RAM questions reuse the original engine's pinned answer (keeps the assignment answer identical in tone)
      var plan = parseQuery(resolved, catalog);
      if (ucId && !plan.use_case) { plan.use_case = ucId; plan.use_case_label = ucById(ucId).label; recomputeWeights(plan); }
      var r = retrievalTurn(plan, resolved);
      var inRes = r.retrieval.results.some(function (x) { return x.pinned && x.product.id === p.id; });
      if (key === 'ram' && inRes && attr(p, 'ram_gb') != null) pa = { text: pinnedAnswer(resolved, r.retrieval), alt: null };
      if (!pa) pa = productAnswer(p, qText || '', catalog, ucId || plan.use_case);
      res.kind = 'product_question';
      res.answer = (extraLead ? extraLead + '\n\n' : '') + pa.text;
      res.products = [card(p, null, '')];
      if (pa.alt) res.products.push(card(pa.alt, null, ''));
      listForPrompt = [p].concat(pa.alt ? [pa.alt] : []);
      idsForState = [p.id].concat(pa.alt ? [pa.alt.id] : []);
      planForState = makePlan({ categories: [p.category], use_case: ucId || plan.use_case });
      ctx = { cats: [p.category], product: p, alt: pa.alt || closestSibling(p), uc: ucId || plan.use_case };
      return true;
    }
    function closestSibling(p) {
      return catalog.filter(function (q) { return q.id !== p.id && q.category === p.category; })
        .sort(function (x, y) { return Math.abs(x.price - p.price) - Math.abs(y.price - p.price); })[0] || null;
    }
    function unknownName(u) {
      var generic = /^(standalone|TVs)/.test(u.label);
      var brandOnly = !u.labelled || u.label === 'Apple' || u.label === 'Samsung Galaxy';
      if (generic) return '**' + u.label + '**';
      return brandOnly ? '**' + u.label.replace(/ Galaxy$/, '') + ' products**' : 'the **' + u.label + '**';
    }
    function setCompare(a, b, ucId, lead) {
      res.kind = 'compare';
      res.resolved_query = 'compare ' + a.name + ' vs ' + b.name;
      if (unknown) lead = 'Sorry, we don\'t carry ' + unknownName(unknown) + ' — TechMart only stocks its own catalog. Here\'s how our closest options compare:' + (lead ? '\n\n' + lead : '');
      res.answer = (lead ? lead + '\n\n' : '') + compareAnswer(a, b, ucId);
      res.products = [card(a, null, ''), card(b, null, '')];
      listForPrompt = [a, b];
      idsForState = [a.id, b.id];
      var plan = makePlan({ categories: uniq([a.category, b.category]), use_case: ucId });
      res.run = runPlan(res.resolved_query, catalog, makePlan({ categories: uniq([a.category, b.category]), use_case: ucId, pinned_ids: [a.id, b.id] }), stage, k);
      planForState = plan;
      ctx = { cats: [a.category] };
      return true;
    }
    function refProduct(i) {
      if (!lastProducts.length) return null;
      return i === -1 ? lastProducts[lastProducts.length - 1] : (lastProducts[i] || null);
    }
    function stripRefs(s) {
      return s.replace(RX.ordinal, ' ').replace(/\b(tell me more about|tell me about|more about|what about|how about|the|it|its|this one|that one|this|that|one)\b/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // ---- compare
    if (isCompare && !(unknown && pins.length < 2)) {
      var pair = null;
      var cpUc = cur.use_case || (lastPlan && lastPlan.use_case) || null;
      if (pins.length >= 2) pair = [meta.byId[pins[0].id], meta.byId[pins[1].id]];
      else if (pins.length === 1 && lastProducts.length) {
        var other = lastProducts.filter(function (p) { return p.id !== pins[0].id; })[0];
        if (other) pair = [meta.byId[pins[0].id], other];
      } else if (ords.length >= 2 && lastProducts.length) {
        var o1 = refProduct(ords[0]), o2 = refProduct(ords[1]);
        if (o1 && o2 && o1 !== o2) pair = [o1, o2];
      } else if (!cats.length && lastProducts.length >= 2) pair = [lastProducts[0], lastProducts[1]];
      if (!pair && cats.length) {
        var cplan = parseQuery(ql.replace(RX.compare, ' '), catalog);
        augmentPlan(cplan, ql);
        var cr = runPlan(ql, catalog, cplan, stage, k);
        if (cr.retrieval.results.length >= 2) {
          pair = [cr.retrieval.results[0].product, cr.retrieval.results[1].product];
          cpUc = cplan.use_case;
        }
      }
      if (pair) {
        setCompare(pair[0], pair[1], cpUc, pins.length === 1 && pair[1] === lastProducts.filter(function (p) { return p.id !== pins[0].id; })[0] ? 'Comparing it with the **' + pair[1].name + '** from before:' : null);
        return finish();
      }
      if (pins.length === 1) { setProduct(meta.byId[pins[0].id], ql, cur.use_case); return finish(); }
      res.kind = 'clarify';
      res.answer = 'Happy to compare! Which two products should I put side by side? For example *"Zentra Vision 15 vs Pixelon Slim 14"* or *"compare Vertex Aura Elite and Nova Pods Max"*.';
      res.suggestions = ['Zentra Vision 15 vs Pixelon Slim 14', 'Compare Zentra Echo Buds 2 and Pixelon Tune Pro', 'What do you sell?'];
      return finish();
    }

    // ---- follow-up: after a compare, "which is lighter / cheaper / has ANC?" answers among the two
    if (hasState && !cats.length && !pins.length && state.last_kind === 'compare' && lastProducts.length >= 2 && /\bwhich\b|\bwho\b|\bbetter\b/.test(ql)) {
      var sk = superlativeKey(ql);
      var ucQ = cur.use_case;
      if (ucQ) {
        var two = lastProducts.slice(0, 2);
        setCompare(two[0], two[1], ucQ);
        return finish();
      }
      if (sk) {
        var sa = superlativeAnswer(sk, lastProducts.slice(0, 2));
        if (sa) {
          res.kind = 'compare';
          res.resolved_query = 'which ' + (KEY_PHRASE[sk] ? KEY_PHRASE[sk][0] : sk) + ': ' + lastProducts.slice(0, 2).map(function (p) { return p.name; }).join(' vs ');
          res.answer = sa.text;
          res.products = [card(sa.best, null, '')].concat(lastProducts.slice(0, 2).filter(function (p) { return p !== sa.best; }).map(function (p) { return card(p, null, ''); }));
          listForPrompt = lastProducts.slice(0, 2);
          idsForState = lastProducts.slice(0, 2).map(function (p) { return p.id; });
          res.run = runPlan(res.resolved_query, catalog, makePlan({ categories: uniq(lastProducts.slice(0, 2).map(function (p) { return p.category; })), pinned_ids: idsForState }), stage, k);
          planForState = lastPlan;
          ctx = { cats: [lastProducts[0].category] };
          return finish();
        }
      }
    }

    // ---- references to earlier products: "the first one", "tell me more about it", "does it have ANC?"
    if (hasState && !pins.length && !cats.length && lastProducts.length) {
      var refP = null;
      if (ords.length) refP = refProduct(ords[0]);
      else if (RX.pronoun.test(ql) && (RX.detail.test(ql) || detectAttr(ql) || cur.use_case) && !RX.cheaper.test(ql) && !RX.pricier.test(ql) && !RX.more.test(ql) && !hasPrice) refP = lastProducts[0];
      else if (/^(tell me more|more details|details|specs|more info)$/.test(ql)) refP = lastProducts[0];
      else if (detectAttr(ql) && tokCount <= 4 && !/\b(which|more|better|bigger|longer|less|lighter|best|most|good|great|high|higher|with|without)\b/.test(ql) && !cur.use_case) refP = lastProducts[0];  // "price?", "battery?"
      if (refP && !(hasPrice || RX.cheaper.test(ql) || RX.pricier.test(ql) || RX.more.test(ql))) {
        setProduct(refP, stripRefs(ql), cur.use_case);
        return finish();
      }
    }

    // ---- follow-up refinement of the previous search
    var isRefine = hasState && lastPlan && !pins.length && (!unknown || (unknown.generic && !unknown.accessory && !/\b(sell|have|carry|stock)\b/.test(ql))) && (
      (!cats.length && (RX.cheaper.test(ql) || RX.pricier.test(ql) || RX.more.test(ql) || RX.refine.test(ql) ||
        (tokCount <= 6 && (hasPrice || cur.use_case || cur.need_anc || cur.need_wireless || Object.keys(cur.boosts).length || EXTRA_BOOSTS.some(function (b) { return b.key !== 'price' && b.re.test(ql); })))) ||
      (cats.length && /^(and|what about|how about|ok(ay)? (and|what about))\b/.test(ql))));
    if (isRefine) {
      var plan = cloneJSON(lastPlan);
      plan.pinned_ids = []; plan.boosts = plan.boosts || {}; plan.keywords = plan.keywords || []; plan.categories = plan.categories || [];
      var changes = [];
      var lead = null;
      var top = lastProducts[0] || null;
      if (cats.length) {  // "what about tablets?" -> new category, keep the use case
        plan.categories = cats; plan.price_max = null; plan.price_min = null; plan.keywords = [];
        plan.need_anc = cur.need_anc; plan.need_wireless = cur.need_wireless;
        plan.boosts = {};
        Object.keys(cur.boosts).forEach(function (bk) { plan.boosts[bk] = cur.boosts[bk]; });
      } else {
        // the last cards were all one category (e.g. Headset after "which has ANC?") -> stay on it
        var lastCats = uniq(lastProducts.slice(0, 3).map(function (p) { return p.category; }));
        if (lastCats.length === 1 && (!plan.categories.length || plan.categories.indexOf(lastCats[0]) !== -1)) plan.categories = [lastCats[0]];
      }
      if (hasPrice) { plan.price_max = cur.price_max; plan.price_min = cur.price_min; delete plan.cheaper_than; }
      if (cur.use_case) { plan.use_case = cur.use_case; plan.use_case_label = cur.use_case_label; changes.push('for ' + cur.use_case_label); }
      if (plan.use_case === 'workout' && !cats.length) applyFitnessScope(plan);
      if (cur.need_anc && !plan.need_anc) plan.need_anc = true;
      if (/\bgps\b/.test(ql) && !plan.need_gps) { plan.need_gps = true; changes.push('with GPS'); }
      if (cur.need_wireless) plan.need_wireless = true;
      if (/\bwithout (anc|noise)/.test(ql)) plan.need_anc = false;
      Object.keys(cur.boosts).forEach(function (bk) { if (bk !== 'anc' || !plan.need_anc) plan.boosts[bk] = cur.boosts[bk]; });
      var boosted = augmentPlan(plan, ql, { skip: plan.price_max != null || RX.cheaper.test(ql) ? ['price'] : [] });
      kwKnown.forEach(function (t) { if (plan.keywords.indexOf(t) === -1 && !STRUCTURAL_TOKENS.has(t)) plan.keywords.push(t); });
      var cheaper = RX.cheaper.test(ql) && !hasPrice;
      var pricier = !cheaper && RX.pricier.test(ql) && !hasPrice;
      if (cheaper && top) {
        // internal bound: price <= top.price, then anything at or above top.price is dropped in retrievalTurn
        plan.price_max = Math.min(plan.price_max == null ? Infinity : plan.price_max, top.price);
        plan.price_min = null;
        plan.cheaper_than = { id: top.id, name: top.name, price: top.price };
        lead = 'Here\'s what\'s cheaper than the **' + top.name + '** (' + inr(top.price) + '):';
      } else if (pricier && top) {
        plan.price_min = top.price + 1; plan.price_max = null; delete plan.cheaper_than;
        lead = 'Stepping up from the **' + top.name + '** (' + inr(top.price) + '):';
      }
      recomputeWeights(plan);
      if (!Object.keys(plan.weights).length) applyDefaultProfile(plan);
      boosted.forEach(function (bk) { if (bk !== 'price' && BOOST_LABEL[bk]) changes.push('prioritising ' + BOOST_LABEL[bk]); });
      var text = planToText(plan);
      var showMore = RX.more.test(ql) && !cheaper && !pricier;
      var r = retrievalTurn(plan, text, showMore ? 50 : k);
      var ret = r.retrieval;
      if (showMore) {
        var seen = lastIds;
        ret.results = ret.all_ranked.filter(function (x) { return seen.indexOf(x.product.id) === -1; }).slice(0, 6);
        r.prompt = buildPrompt(text, { stage: stage === 1 ? 2 : stage, retrieval: ret });
        if (!ret.results.length) {
          res.kind = 'list';
          res.answer = 'That\'s everything we have for **' + text + '** — you\'ve seen them all. Want to widen the budget or try a different category?';
          res.products = lastProducts.slice(0, 3).map(function (p) { return card(p, null, ''); });
          listForPrompt = lastProducts.slice(0, 3);
          ctx = { cats: plan.categories, count: 0 };
          return finish();
        }
        ret.all_ranked = ret.results;
        ret.candidates_count = ret.results.length;
        setList(r, null, 'More ' + catsNoun(plan.categories) + ' you haven\'t seen yet:');
        res.answer = res.answer.replace(/^More ([^\n]*)\n\nHere (are|is) [^\n]*:/, 'More $1');
        return finish();
      }
      if (cheaper && top && (ret.relaxed || !ret.results.length || ret.results[0].product.id === top.id)) {
        res.kind = 'recommendation';
        var cheapestSame = catalog.filter(function (p) { return plan.categories.indexOf(p.category) !== -1; }).sort(function (a, b) { return a.price - b.price; })[0];
        res.answer = 'The **' + top.name + '** (' + inr(top.price) + ') is already the most affordable match' + (plan.use_case ? ' for ' + plan.use_case_label : '') + ' in our ' + catsNoun(plan.categories) + '.' +
          (cheapestSame && cheapestSame.id !== top.id ? ' Our cheapest ' + CAT_WORD[cheapestSame.category] + ' overall is the **' + cheapestSame.name + '** (' + inr(cheapestSame.price) + '), but it\'s a weaker fit.' : '');
        res.products = [card(top, null, 'Best pick')].concat(cheapestSame && cheapestSame.id !== top.id ? [card(cheapestSame, null, '')] : []);
        listForPrompt = res.products.map(function (c) { return meta.byId[c.id]; });
        ctx = { cats: plan.categories, count: 1, plan: plan };
        plan.price_max = lastPlan.price_max; delete plan.cheaper_than; if (lastPlan.cheaper_than) plan.cheaper_than = lastPlan.cheaper_than; recomputeWeights(plan);
        return finish();
      }
      if (!lead) lead = 'Got it — **' + scopePhrase(ret) + (plan.use_case ? ' for ' + plan.use_case_label : '') + '**' + (changes.length ? ', ' + joinNatural(uniq(changes).filter(function (c) { return !/^for /.test(c); })) : '') + ':';
      lead = lead.replace(/, :$/, ':');
      if (setRecommendation(r, lead)) {
        if (cheaper) {
          res.answer = res.answer.split(/\n\n/).filter(function (para) { return !/^Excluded \(/.test(para); }).join('\n\n');
          if (top) res.answer = res.answer.split('under ' + inr(top.price)).join('cheaper than the ' + top.name);
        }
        return finish();
      }
      // nothing fits (e.g. a feature filter emptied the set)
      res.kind = 'not_found';
      res.answer = 'None of our ' + catsNoun(plan.categories) + ' match that' + (plan.need_anc ? ' with noise cancellation' : '') + '. ' + (lastProducts.length ? 'The earlier picks are still the closest:' : '');
      res.products = lastProducts.slice(0, 3).map(function (p) { return card(p, null, ''); });
      listForPrompt = lastProducts.slice(0, 3);
      ctx = { cats: plan.categories, count: res.products.length };
      return finish();
    }

    // ---- unknown product (not carried) -> closest in-catalog alternatives
    if (unknown && !pins.length) {
      res.kind = 'not_found';
      var ucat = cats.length ? cats : unknown.cat ? [unknown.cat] : [];
      if (!ucat.length) {
        res.answer = 'We don\'t carry ' + (unknown.label || unknown.raw) + ' — TechMart only stocks ' + catalogSummary(catalog).text + '. Can I help you find one of those?';
        return finish();
      }
      var uplan = makePlan({ categories: ucat, use_case: cur.use_case || unknown.uc, price_max: cur.price_max, price_min: cur.price_min, need_anc: cur.need_anc, need_wireless: cur.need_wireless, boosts: cur.boosts });
      augmentPlan(uplan, ql.replace(unknown.rx, ' '));
      if (unknown.boost) { addBoost(uplan, unknown.boost, 0.6); recomputeWeights(uplan); }
      var utext = planToText(uplan);
      var ur = retrievalTurn(uplan, utext, 6);
      var alts = ur.retrieval.results.slice();
      var hasProfile = ur.retrieval.profile.length > 0;
      if (!hasProfile && !hasPrice) alts.sort(function (a, b) { return unknown.tier === 'budget' ? a.product.price - b.product.price : b.product.price - a.product.price; });
      alts = alts.slice(0, 3);
      var genericU = /^(standalone|TVs)/.test(unknown.label);
      var brandOnly = !unknown.labelled || unknown.label === 'Apple' || unknown.label === 'Samsung Galaxy';
      var name = brandOnly && !genericU ? unknown.label.replace(/ Galaxy$/, '') + ' products' : unknown.label;
      var article = genericU || brandOnly ? '' : 'the ';
      res.answer = 'Sorry, we don\'t carry ' + article + '**' + name + '** — TechMart only stocks the products in its own catalog.' +
        (alts.length ? ' Here are the closest ' + catsNoun(ucat) + ' we do have' + (unknown.uc ? ' for ' + ucById(unknown.uc).label : '') + ':\n\n' + alts.map(function (x) { return bullet(x.product); }).join('\n') : '');
      res.products = alts.map(function (x) { return card(x.product, null, ''); });
      listForPrompt = alts.map(function (x) { return x.product; });
      idsForState = alts.map(function (x) { return x.product.id; });
      ctx = { cats: ucat, count: alts.length };
      return finish();
    }

    // ---- named product(s)
    if (pins.length >= 2) {
      setCompare(meta.byId[pins[0].id], meta.byId[pins[1].id], cur.use_case);
      return finish();
    }
    if (pins.length === 1) {
      var pp = meta.byId[pins[0].id];
      var rest = wordTokens(ql).filter(function (t, i) { return pins[0].idx.indexOf(i) === -1; }).join(' ');
      setProduct(pp, rest, cur.use_case, unknown ? 'Sorry, we don\'t carry ' + unknownName(unknown) + ' — but here\'s the **' + pp.name + '** from our catalog:' : null);
      return finish();
    }

    // ---- catalog overview
    if (!cats.length && !cur.use_case && !hasPrice && !brands.length && RX.overview.test(ql)) {
      res.kind = 'catalog_overview';
      res.answer = overviewAnswer(catalog);
      return finish();
    }

    // ---- fresh search: list / recommendation
    var fplan = parseQuery(ql, catalog);
    var softBefore = fplan.categories.length;
    augmentPlan(fplan, ql, { skip: fplan.pinned_ids.length ? ['ram'] : [] });
    fplan.pinned_ids = [];
    if (/\bgps\b/.test(ql)) fplan.need_gps = true;
    if (fplan.use_case === 'workout' && !softBefore) applyFitnessScope(fplan);
    var softCat = !softBefore && fplan.categories.length > 0;
    var cheapestQ = RX.cheapest.test(ql), priciestQ = RX.priciest.test(ql);
    var hasProfile2 = Object.keys(fplan.weights).length > 0;

    // budget / gift only, no category: best of each category within budget
    if (!fplan.categories.length && !fplan.use_case && (hasPrice || RX.gift.test(ql)) && !kwKnown.length && !fplan.need_anc) {
      var maxP = fplan.price_max, minP = fplan.price_min;
      var picks = [];
      CATEGORIES.forEach(function (c) {
        var inCat = catalog.filter(function (p) { return p.category === c && (maxP == null || p.price <= maxP) && (minP == null || p.price >= minP) && p.in_stock !== false; });
        if (inCat.length) picks.push(inCat.sort(function (a, b) { return b.price - a.price; })[0]);
      });
      var gtext = planToText(fplan);
      retrievalTurn(fplan, gtext);
      if (!picks.length) {
        res.kind = 'not_found';
        res.answer = 'Nothing in our catalog fits ' + (maxP != null ? 'under ' + inr(maxP) : 'that budget') + '. Our most affordable item is the **' +
          catalog.slice().sort(function (a, b) { return a.price - b.price; })[0].name + '** (' + inr(catalog.slice().sort(function (a, b) { return a.price - b.price; })[0].price) + ').';
        var cheapestAll = catalog.slice().sort(function (a, b) { return a.price - b.price; })[0];
        res.products = [card(cheapestAll, null, '')];
        ctx = { cats: [cheapestAll.category], count: 1 };
        return finish();
      }
      res.kind = 'list';
      res.answer = (RX.gift.test(ql) ? 'Great gift ideas' : 'The best of each category') + (maxP != null ? ' under ' + inr(maxP) : minP != null ? ' above ' + inr(minP) : '') + ':\n\n' +
        picks.slice(0, 6).map(bullet).join('\n') + '\n\nTell me who it\'s for or what they\'ll use it for and I\'ll narrow it down.';
      res.products = picks.slice(0, 3).map(function (p) { return card(p, null, ''); });
      listForPrompt = picks.slice(0, 6);
      idsForState = picks.slice(0, 6).map(function (p) { return p.id; });
      ctx = { cats: [picks[0].category], count: picks.length };
      return finish();
    }

    var hasContent = fplan.categories.length || fplan.use_case || fplan.need_anc || fplan.need_wireless || fplan.need_gps || brands.length || kwKnown.length ||
      Object.keys(fplan.boosts).some(function (b) { return b !== 'price'; });
    if (hasContent) {
      var ftext = ql;
      var lead2 = softCat ? 'For that, our ' + catsNoun(fplan.categories) + ' are the best fit.' : null;
      var listy = RX.list.test(ql) || LIST_RE.test(ql);
      var bareCat = fplan.categories.length && !fplan.use_case && !hasProfile2 && !hasPrice && !fplan.need_anc && !kwKnown.length && !RX.recWords.test(ql);
      if (!Object.keys(fplan.weights).length && !cheapestQ && !priciestQ && !listy && !bareCat && !brands.length && !kwKnown.length) applyDefaultProfile(fplan);
      var fr = retrievalTurn(fplan, ftext, listy || cheapestQ || priciestQ || bareCat ? 6 : k);
      var fret = fr.retrieval;
      if (brands.length) {  // brand filter ("zentra laptops", "show me nova products")
        var bres = fret.all_ranked.filter(function (x) { return brands.indexOf(x.product.brand) !== -1; });
        if (bres.length) {
          fret.all_ranked = bres; fret.results = bres.slice(0, Math.max(k, 6)); fret.candidates_count = bres.length;
          fret.funnel.push({ label: 'Brand: ' + brands.join(' / '), count: bres.length });
          fr.prompt = buildPrompt(ftext, { stage: stage === 1 ? 2 : stage, retrieval: fret });
          if (!fplan.categories.length || !(hasProfile2 || fplan.use_case)) {
            setList(fr, cheapestQ ? 'cheapest' : priciestQ ? 'priciest' : null, null);
            res.answer = res.answer.replace(/our (products|[a-z ]+?)(:| is)/, 'our ' + brands.join('/') + ' $1$2');
            return finish();
          }
        }
      }
      if (fret.results.length && fret.mode === 'bm25_fallback' && !fret.results.some(function (x) { return x.bm25 > 0; })) {
        // keyword-only query that matched nothing meaningful -> fall through to clarify
      } else if (fret.results.length) {
        if (priciestQ && !fplan.use_case) { setList(fr, 'priciest', lead2); return finish(); }
        if (cheapestQ && !fplan.use_case && !(hasProfile2 && Object.keys(fplan.weights).some(function (w) { return w !== 'price'; }))) { setList(fr, 'cheapest', lead2); return finish(); }
        if ((listy || bareCat) && fret.results.length > 1) { setList(fr, null, lead2); return finish(); }
        setRecommendation(fr, lead2);
        return finish();
      } else {
        // nothing matched hard filters (e.g. "speaker with ANC") -> drop features, show closest
        var nplan = cloneJSON(fplan); nplan.need_anc = false; nplan.need_wireless = false; delete nplan.boosts.anc; recomputeWeights(nplan);
        var nr = runPlan(ftext, catalog, nplan, stage, k);
        res.kind = 'not_found';
        res.run = fr;
        var miss = fplan.need_anc ? 'noise cancellation' : fplan.need_wireless ? 'wireless connectivity' : 'those requirements';
        res.answer = 'Sorry — none of our ' + catsNoun(fret.categories_used) + ' have ' + miss + '.' +
          (nr.retrieval.results.length ? ' The closest ' + catsNoun(fret.categories_used) + ' we have:\n\n' + nr.retrieval.results.slice(0, 3).map(function (x) { return bullet(x.product); }).join('\n') : '');
        res.products = nr.retrieval.results.slice(0, 3).map(function (x) { return card(x.product, null, ''); });
        listForPrompt = res.products.map(function (c) { return meta.byId[c.id]; });
        ctx = { cats: fret.categories_used, count: res.products.length };
        return finish();
      }
    }

    // ---- nothing product-related
    if (RX.nonElec.test(ql)) {
      res.kind = 'off_topic';
      res.answer = 'That\'s not something TechMart sells — we\'re an electronics store with ' + catalogSummary(catalog).text + '. Can I help with any of those?';
      return finish();
    }
    if (RX.generalQ.test(ql) && !RX.wantSomething.test(ql) && tokCount >= 2) {
      res.kind = 'off_topic';
      res.answer = 'I\'m TechMart\'s shopping assistant, so I can only help with our ' + catalogSummary(catalog).text + '. Ask me for a recommendation, a comparison or a product\'s specs!';
      return finish();
    }
    res.kind = 'clarify';
    res.answer = 'Happy to help you find something! What are you shopping for? We carry ' + catalogSummary(catalog).text +
      '. Tell me what you\'ll use it for and your budget — e.g. *"laptop for coding under ₹60,000"*.';
    return finish();
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
    converse: converse,
    normalizeMessage: normalizeMessage,
    findProducts: findProducts,
    callAnthropic: callAnthropic
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TechMartEngine = api;
})(typeof window !== 'undefined' ? window : this);
