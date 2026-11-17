/*
 * TechMart answer guard (browser + Node, no dependencies).
 * checkAnswer(text, ctx) inspects an LLM answer for things that are not grounded in our catalog:
 *   - prices that match no catalog product (budgets the user typed and price differences are allowed)
 *   - outside brands / product lines we don't sell (allowed only in a "we don't carry X" sentence when the user asked about X)
 *   - product-like names ("Zentra Vision 99") that match nothing in the catalog
 *   - empty / near-empty replies
 * ctx = { catalog: [products], allowed: [products given to the model this turn], userMessage: string, context?: string }
 * Returns { ok: boolean, problems: [string] }.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- outside brands
  // key: lowercase word looked up in the user's message; re: how it is detected in the answer.
  // Ambiguous English words (Noise, Nothing, Beats, Galaxy, Omen...) are matched case-sensitively and/or need a model word after them.
  var BRANDS = [
    ['Acer', /\bacer\b/i], ['Asus', /\basus\b/i], ['Dell', /\bdell\b/i], ['HP', /\bHP\b/], ['Lenovo', /\blenovo\b/i],
    ['Apple', /\bApple\b/], ['MacBook', /\bmacbook\b/i], ['iPhone', /\biphone\b/i], ['iPad', /\bipad\b/i],
    ['Samsung', /\bsamsung\b/i], ['Galaxy', /\bGalaxy\b/], ['OnePlus', /\bone\s?plus\b/i], ['Xiaomi', /\bxiaomi\b/i],
    ['Redmi', /\bredmi\b/i], ['Realme', /\brealme\b/i], ['Oppo', /\boppo\b/i], ['Vivo', /\bVivo\b|\bVIVO\b/],
    ['Sony', /\bsony\b/i], ['Bose', /\bbose\b/i], ['JBL', /\bjbl\b/i], ['Sennheiser', /\bsennheiser\b/i],
    ['boAt', /\bboAt\b|\bBoat\s+(?:Airdopes|Rockerz|Stone|Wave|Storm|Xtend)\b/], ['Noise', /\bNoise\s+(?!Cancel|Isolat|Reduc|Level|Suppress|Control)[A-Z0-9]/],
    ['Fire-Boltt', /\bfire[\s-]?boltt\b/i], ['Garmin', /\bgarmin\b/i], ['Fitbit', /\bfitbit\b/i], ['LG', /\bLG\b/],
    ['BenQ', /\bbenq\b/i], ['MSI', /\bMSI\b/], ['Razer', /\brazer\b/i], ['Logitech', /\blogitech\b/i],
    ['Pixel', /\bGoogle\s+Pixel\b|\bPixel\s?\d+[a-z]?\b/], ['Google', /\bGoogle\s+Pixel\b/],
    ['Nothing', /\bNothing\s+(?:Phone|Ear|Headphone|CMF)\b/], ['Motorola', /\bmotorola\b|\bMoto\s+[A-Z]\d*/i],
    ['Nokia', /\bnokia\b/i], ['Huawei', /\bhuawei\b/i], ['Surface', /\bMicrosoft\s+Surface\b|\bSurface\s+(?:Pro|Laptop|Go|Book|Studio)\b/],
    ['AirPods', /\bair\s?pods\b/i], ['Beats', /\bBeats\s+(?:Studio|Solo|Fit|Flex|Pill|by\s+Dre)\b|\bPowerbeats\b/],
    ['Skullcandy', /\bskullcandy\b/i], ['Marshall', /\bMarshall\b/], ['Philips', /\bphilips\b/i], ['Panasonic', /\bpanasonic\b/i],
    ['Toshiba', /\btoshiba\b/i], ['Alienware', /\balienware\b/i], ['Predator', /\bPredator\b/], ['ROG', /\bROG\b/],
    ['Zenbook', /\bzenbook\b/i], ['ThinkPad', /\bthinkpad\b/i], ['Legion', /\bLegion\b/], ['Omen', /\bOmen\b|\bOMEN\b/],
    ['Pavilion', /\bPavilion\b/], ['Inspiron', /\binspiron\b/i], ['XPS', /\bXPS\b/]
  ];
  var NEGATION = /\b(?:don'?t|do\s+not|doesn'?t|does\s+not|not\s+carry|not\s+available|not\s+in\s+our\s+catalog|unavailable|isn'?t|aren'?t|not\s+sell|not\s+stock|no\s+longer|we\s+only)\b|don’t|doesn’t|isn’t|aren’t/i;

  // ---------------------------------------------------------------- vocabulary for product-name checks
  var MODEL_WORDS = toSet('pro max ultra plus mini lite elite air slim neo prime edge');
  // spec / component / tech words that legitimately appear in Capitalised runs with numbers
  var SPEC_WORDS = toSet(
    'intel amd ryzen core rtx gtx nvidia geforce iris xe arc radeon snapdragon mediatek dimensity apple m1 m2 m3 m4 ' +
    'bluetooth wi fi wifi usb c type hdmi earc dolby atmos anc enc ldac aac aptx ip ipx amoled oled lcd ips va tn ltpo ' +
    'qhd uhd fhd hd full 2k 4k 5k 8k hdr hz gb tb ssd hdd ram ddr ddr4 ddr5 lpddr nvme pcie gen android windows ios ' +
    'lte 5g 4g gps nfc mp mah w kg inch sport spo2 atm srgb dci p3 rgb os vram tdp cpu gpu ai'
  );
  var STOP_WORDS = toSet(
    'a an the and or of for to in on with is are be it its this that these those i we you your our my me us they ' +
    'if but so as at by from about into than then also just only both all any each every either neither some no not ' +
    'yes yeah sure okay ok hi hello hey thanks thank great good better best top pick picks runner up option options choice ' +
    'choices step steps verdict summary note tip tips why what which who how when where here there price prices pricing ' +
    'budget under over around about approx approximately starting from at upto up value cheap cheaper cheapest premium ' +
    'expensive affordable gaming work office study students student travel gym kids gifting gift video editing coding ' +
    'battery life display screen performance design weight storage memory camera sound audio quality comfort features ' +
    'specs spec key highlights pros cons recommendation recommendations alternative alternatives alternatively ' +
    'compare comparison vs versus or overall final quick budget-friendly mid range high end entry level flagship ' +
    'day days week weeks hour hours hr hrs month months year years rank number no part section turn version generation ' +
    'excluded included price-wise first second third last next new latest same other another one two three four five ' +
    'laptop laptops earbuds earbud headset headsets headphones headphone smartphone smartphones phone phones mobile ' +
    'tablet tablets smartwatch smartwatches watch watches speaker speakers monitor monitors techmart catalog store ' +
    'bonus look consider go get choose buy pay save spend total extra difference only around just still nothing'
  );

  function toSet(s) { var o = Object.create(null); s.split(/\s+/).forEach(function (w) { if (w) o[w] = true; }); return o; }
  function low(s) { return String(s || '').toLowerCase(); }
  function nameTokens(name) {
    return low(name).replace(/[^a-z0-9. ]+/g, ' ').split(/\s+/).filter(Boolean);
  }
  function uniq(a) { var seen = {}; return a.filter(function (x) { if (seen[x]) return false; seen[x] = 1; return true; }); }

  // ---------------------------------------------------------------- prices
  function parseAmount(numStr, unit) {
    var n = parseFloat(String(numStr).replace(/,/g, ''));
    if (isNaN(n)) return null;
    var u = low(unit || '');
    var approx = false;
    if (u === 'k' || u === 'thousand') { n *= 1000; approx = true; }
    else if (u === 'l' || u === 'lakh' || u === 'lakhs' || u === 'lac' || u === 'lacs') { n *= 100000; approx = true; }
    if (/\./.test(numStr)) approx = true;
    return { value: Math.round(n), approx: approx };
  }

  var UNIT = '(k|K|thousand|L|lakhs?|lacs?)?(?![A-Za-z0-9])';
  var CURRENCY_RES = [
    new RegExp('(?:₹|\\bRs\\.?|\\bINR)\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*' + UNIT, 'g'),
    new RegExp('(?<![\\d,.])(\\d[\\d,]*(?:\\.\\d+)?)\\s*' + UNIT.replace('(?![A-Za-z0-9])', '') + '\\s*(?:rupees|INR)\\b', 'gi')
  ];
  var PLAIN_RE = /(?<![\d,.₹])\d{1,3}(?:,\d{2,3})+(?![\d,]*\d)/g;

  // every money amount mentioned in the answer, with its sentence
  function findPrices(text) {
    var out = [], masked = text;
    CURRENCY_RES.forEach(function (re) {
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(masked))) {
        var a = parseAmount(m[1], m[2]);
        if (a && a.value >= 100) out.push({ raw: m[0].trim(), value: a.value, approx: a.approx, index: m.index });
        masked = masked.slice(0, m.index) + ' '.repeat(m[0].length) + masked.slice(m.index + m[0].length);
      }
    });
    var p;
    PLAIN_RE.lastIndex = 0;
    while ((p = PLAIN_RE.exec(masked))) {
      var v = parseInt(p[0].replace(/,/g, ''), 10);
      if (v >= 10000) out.push({ raw: p[0], value: v, approx: false, index: p.index });
    }
    return out;
  }

  // numbers the user (or the prompt context) mentioned: budgets like "70k", "₹70,000", "under 70000", "1.5 lakh"
  function looseNumbers(s) {
    var out = [];
    var re = /(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|l|lakhs?|lacs?)?(?![a-z0-9])/gi;
    var m;
    while ((m = re.exec(String(s || '')))) {
      var a = parseAmount(m[1], m[2]);
      if (a) out.push(a.value);
    }
    return out;
  }

  // sentence boundaries: . ! ? ; newline — but not decimal points ("1.3 kg") or "Rs." / "vs." / "approx."
  function isBreak(text, i) {
    var ch = text.charAt(i);
    if (ch === '\n' || ch === '!' || ch === '?' || ch === ';') return true;
    if (ch !== '.') return false;
    if (/\d/.test(text.charAt(i + 1) || '')) return false;
    if (/(?:^|[^A-Za-z])(?:Rs|rs|vs|Vs|approx|Approx|e\.g|i\.e)$/.test(text.slice(Math.max(0, i - 7), i))) return false;
    return true;
  }
  function sentenceBounds(text, index) {
    var start = index, end = index;
    while (start > 0 && !isBreak(text, start - 1)) start--;
    while (end < text.length && !isBreak(text, end)) end++;
    return [start, end];
  }
  function sentenceAt(text, index) { var b = sentenceBounds(text, index); return text.slice(b[0], b[1]); }

  var DIFF_WORDS = /\b(?:more|less|cheaper|costlier|pricier|dearer|saves?|saving|savings|extra|difference|premium|gap|additional|over|above|below|under)\b/i;
  var BUDGET_WORDS = /\b(?:under|below|within|budget|up\s*to|upto|less\s+than|max(?:imum)?|over|above|around|fits?|limit|range)\b/i;
  var COMPARE_WORDS = /\b(?:vs|versus|than|compared|while|whereas|unlike|instead|same|both|but|against|or)\b/i;

  // ---------------------------------------------------------------- product mentions (full names + unique partial names)
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  var aliasCache = { catalog: null, list: null };
  function aliasesFor(catalog) {
    if (aliasCache.catalog === catalog && aliasCache.list) return aliasCache.list;
    var map = Object.create(null);
    (catalog || []).forEach(function (p) {
      var t = nameTokens(p.name);
      for (var n = 2; n <= t.length; n++) {
        var key = t.slice(0, n).join(' ');
        (map[key] = map[key] || []).push({ p: p, full: n === t.length });
      }
    });
    var list = [];
    Object.keys(map).forEach(function (key) {
      var entries = map[key];
      var full = entries.filter(function (e) { return e.full; });
      var p = full.length === 1 ? full[0].p : (entries.length === 1 ? entries[0].p : null);
      if (!p) return; // ambiguous prefix like "Nova Phone"
      list.push({ key: key, p: p, re: new RegExp('(?<![A-Za-z0-9])' + key.split(' ').map(escapeRe).join('\\s+') + '(?![A-Za-z0-9])', 'gi') });
    });
    list.sort(function (a, b) { return b.key.length - a.key.length; });
    aliasCache = { catalog: catalog, list: list };
    return list;
  }
  function findMentions(text, catalog) {
    var taken = [], out = [];
    aliasesFor(catalog).forEach(function (a) {
      a.re.lastIndex = 0;
      var m;
      while ((m = a.re.exec(text))) {
        var s = m.index, e = s + m[0].length;
        if (taken.some(function (r) { return s < r[1] && e > r[0]; })) continue;
        taken.push([s, e]);
        out.push({ start: s, end: e, p: a.p });
      }
    });
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }
  // nearest product named before `index` in the same sentence, within `maxGap` chars, with no other name in between
  function boundMention(text, mentions, index, maxGap) {
    var b = sentenceBounds(text, index), best = null;
    mentions.forEach(function (m) { if (m.end <= index && m.start >= b[0]) best = m; });
    if (!best || index - best.end > maxGap) return null;
    return best;
  }

  function diffs(list) {
    var d = [];
    for (var i = 0; i < list.length; i++) for (var j = i + 1; j < list.length; j++) d.push(Math.abs(list[i] - list[j]));
    return d;
  }
  // cheapest and dearest price per category (price-range sentences)
  function extremes(catalog) {
    var lo = {}, hi = {};
    (catalog || []).forEach(function (p) {
      var c = p.category, v = Number(p.price);
      if (!(c in lo) || v < lo[c]) lo[c] = v;
      if (!(c in hi) || v > hi[c]) hi[c] = v;
    });
    return Object.keys(lo).map(function (c) { return lo[c]; }).concat(Object.keys(hi).map(function (c) { return hi[c]; }));
  }
  function tolFor(v, approx) { return approx ? Math.max(1000, v * 0.015) : 1; }
  function near(v, list, approx) {
    var tol = tolFor(v, approx);
    for (var i = 0; i < list.length; i++) if (Math.abs(list[i] - v) <= tol) return true;
    return false;
  }

  // what a money amount is doing in its sentence:
  //   'diff'   — "₹2,000 cheaper", "₹18,010 more", "saves you ₹7,990", "₹19,990 over budget"
  //   'budget' — "under ₹70,000", "your ₹60,000 budget"
  //   'range'  — "₹33,990–₹1,59,990"
  //   'price'  — anything else ("is ₹X", "at ₹X", "priced at ₹X", "for only ₹X", "now ₹X", "(₹X)")
  var DIFF_AFTER = /^\s*(?:cheaper|less|more|costlier|pricier|dearer|extra|over|above|below|under|in\s+savings|saving|savings|difference|premium|apart|higher|lower)\b/i;
  var DIFF_BEFORE = /(?:\bsaves?\s+(?:you\s+)?|\bsaving\s+(?:of\s+)?|\bsavings\s+of\s+|\bdifference\s+(?:of\s+|is\s+)?|\bgap\s+(?:of\s+)?|\bextra\s+|\badditional\s+|\bspend(?:ing)?\s+|\bpay(?:ing)?\s+|\bby\s+(?:about\s+|around\s+|just\s+|only\s+)?)$/i;
  var BUDGET_BEFORE = /(?:\bunder|\bbelow|\bwithin|\bup\s*to|\bupto|\bless\s+than|\bmax(?:imum)?|\babove|\bover|\baround|\bbudget(?:\s+of)?|\byour|\bbetween|\band|\bless|\bthan|≤|≥|<|>)\s*$/i;
  function priceRole(text, pr) {
    var before = text.slice(Math.max(0, pr.index - 30), pr.index);
    var after = text.slice(pr.index + pr.raw.length, pr.index + pr.raw.length + 30);
    if (/^\s*(?:–|—|-|to)\s*(?:₹|Rs|INR)/i.test(after) || /(?:₹|Rs\.?|INR)\s*[\d,]+\s*(?:–|—|-|to)\s*$/i.test(before)) return 'range';
    if (DIFF_AFTER.test(after) && !/^\s*(?:over|above|below|under)\s+(?:the\s+)?(?:₹|rs\b|inr\b)/i.test(after)) return 'diff';
    if (DIFF_BEFORE.test(before)) return 'diff';
    if (BUDGET_BEFORE.test(before) || /^\s*budget\b/i.test(after)) return 'budget';
    return 'price';
  }

  function checkPrices(text, ctx, mentions, problems) {
    var catalogPrices = (ctx.catalog || []).map(function (p) { return Number(p.price); }).filter(isFinite);
    var allowedPrices = (ctx.allowed || []).map(function (p) { return Number(p.price); }).filter(isFinite);
    var userNums = looseNumbers(ctx.userMessage).concat(looseNumbers(ctx.context));
    var catalogDiffs = diffs(catalogPrices);
    var strict = (ctx.allowed || []).length > 0;
    function bad(msg) { problems.push(msg); }
    findPrices(text).forEach(function (pr) {
      var role = priceRole(text, pr);
      var tol = tolFor(pr.value, pr.approx);
      var sb = sentenceBounds(text, pr.index);
      var bound = boundMention(text, mentions, pr.index, 60);

      if (role === 'diff') {
        // a difference must be |price A − price B| for two real products, never derived from other numbers in the reply
        var after = text.slice(pr.index + pr.raw.length, sb[1]);
        var thanM = /^\s*(cheaper|less(?:\s+expensive)?|lower|more(?:\s+expensive)?|costlier|pricier|dearer|higher)\b[^.]*?\bthan\b/i.exec(after);
        var other = null;
        if (thanM) {
          var thanAt = pr.index + pr.raw.length + thanM.index + thanM[0].length;
          mentions.forEach(function (m) { if (!other && m.start >= thanAt && m.start < sb[1]) other = m; });
        }
        if (bound && other && bound.p !== other.p) {
          var pa = Number(bound.p.price), pb = Number(other.p.price);
          var cheaper = /^(cheaper|less|lower)/i.test(thanM[1]);
          var dirOk = cheaper ? pa < pb : pa > pb;
          if (!dirOk || Math.abs(Math.abs(pa - pb) - pr.value) > tol) {
            bad('Says ' + bound.p.name + ' is ' + pr.raw + ' ' + thanM[1].toLowerCase() + ' than ' + other.p.name + ', but they cost ' +
              inr(pa) + ' and ' + inr(pb) + ' (' + inr(Math.abs(pa - pb)) + ' ' + (pa < pb ? 'cheaper' : 'more expensive') + ').');
          }
          return;
        }
        // "saves you ₹D" with two products named in the sentence: D must be their price gap
        var inSentence = uniqProducts(mentions.filter(function (m) { return m.start >= sb[0] && m.start < sb[1]; }));
        if (/\bsav(?:e|es|ing|ings)\b/i.test(text.slice(sb[0], sb[1])) && inSentence.length === 2) {
          if (Math.abs(Math.abs(inSentence[0].price - inSentence[1].price) - pr.value) > tol) {
            bad('Says the saving is ' + pr.raw + ', but ' + inSentence[0].name + ' and ' + inSentence[1].name + ' differ by ' + inr(Math.abs(inSentence[0].price - inSentence[1].price)) + '.');
          }
          return;
        }
        if (bound) { // one side known: the gap must be to a product under discussion (named in the reply, shown to the model, or same category)
          var own0 = Number(bound.p.price);
          var named = uniqProducts(mentions), shown = ctx.allowed || [];
          if ((ctx.catalog || []).some(function (q) {
            if (q === bound.p) return false;
            if (!(named.indexOf(q) >= 0 || shown.indexOf(q) >= 0 || q.category === bound.p.category)) return false;
            return Math.abs(Math.abs(own0 - Number(q.price)) - pr.value) <= tol;
          })) return;
        } else if (near(pr.value, catalogDiffs, pr.approx)) return;
        // "₹19,990 over budget": a catalog price minus the user's budget
        for (var u = 0; u < userNums.length; u++) {
          for (var c = 0; c < catalogPrices.length; c++) {
            if (Math.abs(Math.abs(catalogPrices[c] - userNums[u]) - pr.value) <= tol) return;
          }
        }
        bad('Price difference "' + pr.raw + '" does not match the gap between any two of our products' + (bound ? ' involving ' + bound.p.name : '') + '.');
        return;
      }

      if (role === 'budget') {
        if (near(pr.value, userNums, pr.approx) || near(pr.value, catalogPrices, pr.approx)) return;
        bad('Budget "' + pr.raw + '" is neither the user\'s budget nor a catalog price.');
        return;
      }

      if (role === 'price' && bound) {
        // "Nova Tab 11 is ₹9,999" / "… cheaper at ₹9,499" / "priced at ₹X": must be that product's price
        var own = Number(bound.p.price);
        if (Math.abs(own - pr.value) <= tol) return;
        bad('Price "' + pr.raw + '" is given for ' + bound.p.name + ', but it costs ' + inr(own) + '.');
        return;
      }

      // unbound price or range end: must be a real price (of a product shown to the model when we know them)
      if (near(pr.value, strict ? allowedPrices : catalogPrices, pr.approx)) return;
      if (near(pr.value, extremes(ctx.catalog), pr.approx)) return; // "our laptops run ₹33,990–₹1,59,990"
      if (near(pr.value, userNums, pr.approx)) return;
      bad('Price "' + pr.raw + '" does not match ' + (strict ? 'any product shown to the model' : 'any catalog product') + ' or the user\'s budget.');
    });
  }
  function uniqProducts(ms) {
    var out = [];
    ms.forEach(function (m) { if (out.indexOf(m.p) < 0) out.push(m.p); });
    return out;
  }

  // "It has 3GB RAM" / "It's ₹6,990 cheaper than …" / "With 16GB RAM …": a sentence opening with a pronoun refers to the
  // single product named in the nearest earlier sentence that names any product.
  var PRONOUN_START = /^[\s\-–•\d.)]*(It(?:['’]s)?|This(?:\s+one)?|That(?:\s+one)?|With)\b/;
  function addPronounMentions(text, mentions) {
    var sentences = [], i = 0;
    while (i < text.length) {
      var b = sentenceBounds(text, i);
      if (b[1] > b[0]) sentences.push(b);
      i = b[1] + 1;
    }
    var extra = [];
    sentences.forEach(function (s, k) {
      var m = PRONOUN_START.exec(text.slice(s[0], s[1]));
      if (!m) return;
      var word = m[1];
      var pStart = s[0] + m.index + m[0].length - word.length, pEnd = pStart + word.length;
      var inSentence = mentions.filter(function (x) { return x.start >= s[0] && x.start < s[1]; });
      if (/^With$/i.test(word) && inSentence.length) return; // "With 16GB RAM, the Pixelon Slim 14 …" names its own subject
      if (inSentence.some(function (x) { return x.start < pStart; })) return;
      for (var j = k - 1; j >= 0 && j >= k - 3; j--) {
        var prev = uniqProducts(mentions.filter(function (x) { return x.start >= sentences[j][0] && x.start < sentences[j][1]; }));
        if (!prev.length) continue;
        if (prev.length === 1) extra.push({ start: pStart, end: pEnd, p: prev[0], pronoun: true });
        return;
      }
    });
    return mentions.concat(extra).sort(function (a, b) { return a.start - b.start; });
  }

  // ---------------------------------------------------------------- contradictions with the deterministic answer
  var CHEAPER_CLAIM = /\b(?:cheaper|more\s+affordable|less\s+expensive|lower[\s-]priced|cheapest|budget[\s-]friendly\s+(?:option|alternative|pick))\b/i;
  function checkContradictions(text, ctx, mentions, problems) {
    var ea = String(ctx.engineAnswer || '');
    var m = /\b(?:is\s+)?already\s+(?:the\s+|our\s+)?(?:most\s+affordable|cheapest|lowest[\s-]priced)\b/i.exec(ea);
    if (!m) return;
    var em = findMentions(ea, ctx.catalog);
    var before = em.filter(function (x) { return x.start < m.index; });
    var subject = before.length ? before[before.length - 1].p : (em[0] && em[0].p);
    if (!subject) return;
    // products the engine answer itself names ("our cheapest laptop overall is X, but it's a weaker fit") are fair game
    var engineNamed = uniqProducts(em);
    var i = 0;
    while (i < text.length) {
      var b = sentenceBounds(text, i);
      var s = text.slice(b[0], b[1]);
      i = b[1] + 1;
      if (!CHEAPER_CLAIM.test(s)) continue;
      if (/\b(?:no(?:thing)?|none)\s+(?:is\s+|are\s+)?(?:cheaper|more\s+affordable)|\b(?:isn['’]?t|aren['’]?t|not)\s+(?:any\s+)?(?:cheaper|more\s+affordable)|\balready\b/i.test(s)) continue;
      var others = uniqProducts(mentions.filter(function (x) { return x.start >= b[0] && x.start < b[1] && !x.pronoun; }))
        .filter(function (p) { return p !== subject && engineNamed.indexOf(p) < 0; });
      if (others.length) {
        problems.push('Presents ' + others[0].name + ' as cheaper, but ' + subject.name + ' is already the most affordable option.');
        return;
      }
    }
  }
  function inr(n) {
    var s = String(Math.round(n)), last3 = s.slice(-3), rest = s.slice(0, -3);
    if (rest) rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return '₹' + (rest ? rest + ',' + last3 : last3);
  }

  // ---------------------------------------------------------------- spec binding
  // Each extractor returns [{raw, index, kind, value}] for claims in a text slice.
  var SPEC_PATTERNS = [
    { kind: 'ram', re: /(\d+)\s?GB\s+(?:of\s+)?(?:LP)?(?:DDR\d\s+)?RAM\b/gi, val: function (m) { return +m[1]; } },
    { kind: 'storage', re: /(\d+(?:\.\d+)?)\s?(GB|TB)\s+(?:of\s+)?(?:NVMe\s+)?(?:SSD|storage|internal\s+storage|ROM|HDD)\b/gi, val: function (m) { return /tb/i.test(m[2]) ? Math.round(+m[1] * 1024) : +m[1]; } },
    { kind: 'battery', re: /(\d+(?:\.\d+)?)[\s-]?(hours?|hrs?|hr|days?)\s+(?:of\s+)?(?:battery|playback|playtime|backup)/gi, val: batteryVal },
    { kind: 'battery', re: /battery(?:\s+life)?\s+(?:of|is|lasts|rated\s+at|up\s+to|:|—|-)?\s*(?:about\s+|around\s+|up\s+to\s+)?(\d+(?:\.\d+)?)[\s-]?(hours?|hrs?|hr|days?)\b/gi, val: batteryVal },
    { kind: 'gpu', re: /\bRTX\s?(\d{4})\b/gi, val: function (m) { return 'rtx ' + m[1]; } },
    { kind: 'cpu', re: /\b(?:Intel\s+)?(?:Core\s+)?(i[3579])\b/g, val: function (m) { return m[1].toLowerCase(); } },
    { kind: 'cpu', re: /\bRyzen\s+(\d)\b/gi, val: function (m) { return 'ryzen ' + m[1]; } },
    { kind: 'display', re: /(\d+(?:\.\d+)?)[\s-]?(?:inch(?:es)?\b|″|")/gi, val: function (m) { return +m[1]; } },
    { kind: 'refresh', re: /(\d{2,3})\s?Hz\b/gi, val: function (m) { return +m[1]; } },
    { kind: 'ip', re: /\b(IP(?:X\d|\d{2}))\b/gi, val: function (m) { return m[1].toUpperCase(); } },
    { kind: 'weight', re: /(\d+(?:\.\d+)?)\s?kg\b/gi, val: function (m) { return +m[1]; } }
  ];
  function batteryVal(m) { return /day/i.test(m[2]) ? +m[1] * 24 : +m[1]; }

  function specClaims(slice) {
    var out = [];
    SPEC_PATTERNS.forEach(function (sp) {
      sp.re.lastIndex = 0;
      var m;
      while ((m = sp.re.exec(slice))) out.push({ kind: sp.kind, value: sp.val(m), raw: m[0].trim(), index: m.index });
    });
    return out;
  }

  // does product p actually have this spec value? null = we have no data to judge
  function specMatches(p, c) {
    var a = p.attributes || {}, specs = low(p.specs);
    switch (c.kind) {
      case 'ram': return a.ram_gb == null ? null : a.ram_gb === c.value;
      case 'storage': return a.storage_gb == null ? null : a.storage_gb === c.value;
      case 'battery': return a.battery_hr == null ? null : Math.abs(a.battery_hr - c.value) <= 0.5;
      case 'gpu':
        if (p.category !== 'Laptop') return null;
        return !!a.gpu && low(a.gpu).indexOf(c.value) >= 0;
      case 'cpu':
        if (!a.cpu) return null;
        if (/^i\d$/.test(c.value)) return /intel/i.test(a.cpu) ? new RegExp('\\b' + c.value + '\\b').test(low(a.cpu)) : false;
        return low(a.cpu).indexOf(c.value) >= 0;
      case 'display': return a.display_in == null ? null : Math.abs(a.display_in - c.value) <= 0.05;
      case 'refresh': return a.refresh_hz == null ? null : a.refresh_hz === c.value;
      case 'ip':
        var wr = a.water_resistance ? String(a.water_resistance).toUpperCase() : (specs.match(/\bipx?\d+/i) || [''])[0].toUpperCase();
        return wr ? wr === c.value : false;
      case 'weight': return a.weight_kg == null ? null : Math.abs(a.weight_kg - c.value) <= 0.05;
    }
    return null;
  }

  var SPEC_LABEL = { ram: 'RAM', storage: 'storage', battery: 'battery', gpu: 'GPU', cpu: 'processor', display: 'screen size', refresh: 'refresh rate', ip: 'water resistance', weight: 'weight' };

  function checkSpecs(text, ctx, mentions, problems) {
    var pool = (ctx.allowed || []).slice();
    mentions.forEach(function (m) { if (pool.indexOf(m.p) < 0) pool.push(m.p); });
    mentions.forEach(function (m, i) {
      var sb = sentenceBounds(text, m.start);
      var stop = Math.min(sb[1], m.end + 120, i + 1 < mentions.length ? mentions[i + 1].start : Infinity);
      var slice = text.slice(m.end, stop);
      if (!slice) return;
      var sentence = text.slice(sb[0], sb[1]);
      var comparing = COMPARE_WORDS.test(sentence) || mentions.some(function (o) { return o !== m && o.start >= sb[0] && o.start < sb[1]; });
      specClaims(slice).forEach(function (c) {
        var ok = specMatches(m.p, c);
        if (ok !== false) return;
        // "10hr battery vs 14hr battery": in a comparison the value may belong to another product under discussion
        if (comparing && pool.some(function (o) { return o !== m.p && specMatches(o, c) === true; })) return;
        problems.push('Says ' + m.p.name + ' has "' + c.raw + '", which does not match its ' + SPEC_LABEL[c.kind] + ' (' + m.p.specs + ').');
      });
    });
  }

  // ---------------------------------------------------------------- outside brands
  function checkBrands(text, ctx, problems) {
    var user = String(ctx.userMessage || '') + ' ' + String(ctx.context || '');
    var catalogText = (ctx.catalog || []).map(function (p) { return p.name + ' ' + (p.brand || ''); }).join(' | ');
    BRANDS.forEach(function (b) {
      var key = b[0], re = b[1];
      if (re.test(catalogText)) return; // never flag something we actually stock
      var g = new RegExp(re.source, re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g');
      var m, flagged = false;
      var userMentioned = new RegExp('\\b' + key.replace(/[-]/g, '[\\s-]?') + '\\b', 'i').test(user);
      while ((m = g.exec(text)) && !flagged) {
        if (userMentioned && NEGATION.test(sentenceAt(text, m.index))) continue;
        problems.push('Mentions "' + m[0].trim() + '" (' + key + '), which is not in our catalog' + (userMentioned ? ' (not phrased as "we don\'t carry it").' : '.'));
        flagged = true;
        if (m[0].length === 0) g.lastIndex++;
      }
    });
  }

  // ---------------------------------------------------------------- invented product names
  function buildCatalogIndex(catalog) {
    var names = (catalog || []).map(function (p) { return nameTokens(p.name); });
    var brand = Object.create(null);
    (catalog || []).forEach(function (p, i) {
      if (p.brand) brand[low(p.brand)] = true;
      if (names[i][0]) brand[names[i][0]] = true;
    });
    return { names: names, brand: brand };
  }

  // split text into runs of Capitalised / model tokens separated only by single spaces or hyphens
  function capitalRuns(text) {
    var runs = [], cur = [];
    var re = /[A-Za-z0-9][A-Za-z0-9.+']*/g, m, lastEnd = -1;
    function flush() { if (cur.length) runs.push(cur); cur = []; }
    while ((m = re.exec(text))) {
      var raw = m[0], endsDot = false;
      if (/\.$/.test(raw)) { raw = raw.replace(/\.+$/, ''); endsDot = true; }
      var possessive = /'s$|’s$/i.test(raw) || /^[’']s\b/.test(text.slice(m.index + m[0].length));
      raw = raw.replace(/'s$/i, '').replace(/'$/, '');
      var sep = lastEnd < 0 ? '\n' : text.slice(lastEnd, m.index);
      if (!/^[ \t-]$/.test(sep)) flush();
      var isDigit = /\d/.test(raw);
      var isCap = /^[A-Z]/.test(raw);
      var isModel = isDigit || /^[A-Z]$/.test(raw) || (isCap && MODEL_WORDS[low(raw)]);
      // "14-hour", "16 GB", "15.6 inch": a number carrying a unit is a spec, not a model number
      var unit = isDigit && UNIT_AFTER.test(text.slice(m.index + m[0].length, m.index + m[0].length + 10));
      if (raw && (isCap || isModel)) cur.push({ t: raw, l: low(raw), digit: isDigit, cap: isCap, model: !!isModel, unit: unit });
      else flush();
      if (endsDot || possessive) flush(); // "Arcwave Campus 14's 14-hour battery" ends the name at 's
      lastEnd = m.index + m[0].length;
    }
    flush();
    return runs;
  }

  var UNIT_AFTER = /^[\s-]?(?:hours?|hrs?|days?|inch(?:es)?|gb|tb|hz|mp|mah|w|watts?|kg|mm|atm|k\b|x\b)/i;

  function startsWith(seg, name) {
    if (name.length > seg.length) return false;
    for (var i = 0; i < name.length; i++) if (seg[i] !== name[i]) return false;
    return true;
  }
  function subsetOf(seg, name) {
    for (var i = 0; i < seg.length; i++) if (name.indexOf(seg[i]) < 0) return false;
    return true;
  }
  function generic(l) { return STOP_WORDS[l] || SPEC_WORDS[l] || /^\d+(?:\.\d+)?(?:gb|tb|hz|hr|hrs|mp|mah|w|k|kg|in|inch|mm|atm|v)$/.test(l); }

  function checkNames(text, ctx, problems) {
    var idx = buildCatalogIndex(ctx.catalog);
    var userLow = ' ' + nameTokens(ctx.userMessage + ' ' + (ctx.context || '')).join(' ') + ' ';
    var seen = {};
    function report(label) {
      var key = low(label);
      if (seen[key]) return;
      if (userLow.indexOf(' ' + nameTokens(label).join(' ') + ' ') >= 0) return; // the user named it themselves
      seen[key] = true;
      problems.push('Mentions "' + label + '", which matches no product in our catalog.');
    }
    capitalRuns(text).forEach(function (run) {
      var toks = run.map(function (x) { return x.l; });
      var handled = new Array(run.length);
      // (a) segments anchored on one of our brand words: must be (part of) a real catalog name
      for (var i = 0; i < run.length; i++) {
        if (!idx.brand[toks[i]]) continue;
        var j = i + 1;
        while (j < run.length && !idx.brand[toks[j]]) j++;
        var seg = toks.slice(i, j);
        while (seg.length > 1 && generic(seg[seg.length - 1]) && !MODEL_WORDS[seg[seg.length - 1]] && !/^\d+$/.test(seg[seg.length - 1])) seg.pop();
        for (var h = i; h < j; h++) handled[h] = true;
        if (seg.length < 2) continue;
        var best = null;
        idx.names.forEach(function (n) { if (startsWith(seg, n) && (!best || n.length > best.length)) best = n; });
        if (best) {
          var nxt = seg[best.length], nxtTok = run[i + best.length];
          if (nxt && !(nxtTok && nxtTok.unit) && (/^\d+$/.test(nxt) || MODEL_WORDS[nxt])) report(run.slice(i, i + best.length + 1).map(function (x) { return x.t; }).join(' '));
          continue;
        }
        var hasModel = run.slice(i, i + seg.length).some(function (x) { return x.model; });
        if (!hasModel) continue;
        if (idx.names.some(function (n) { return subsetOf(seg, n); })) continue;
        report(run.slice(i, i + seg.length).map(function (x) { return x.t; }).join(' '));
      }
      // (b) other brands: two unknown Capitalised words followed by a model number ("Predator Helios 300")
      for (var k = 2; k < run.length; k++) {
        if (handled[k] || handled[k - 1] || handled[k - 2]) continue;
        var a = run[k - 2], b = run[k - 1], c = run[k];
        if (!c.digit || a.digit || b.digit || !a.cap || !b.cap) continue;
        if (generic(a.l) || generic(b.l) || MODEL_WORDS[a.l] || MODEL_WORDS[b.l]) continue;
        var trio = [a.l, b.l, c.l];
        if (idx.names.some(function (n) { return subsetOf(trio, n); })) continue;
        report(a.t + ' ' + b.t + ' ' + c.t);
      }
    });
  }

  // ---------------------------------------------------------------- public API
  function checkAnswer(text, ctx) {
    ctx = ctx || {};
    var problems = [];
    var t = String(text == null ? '' : text);
    if (t.trim().length < 3) {
      problems.push('The reply is empty or too short.');
      return { ok: false, problems: problems };
    }
    // markdown emphasis / code marks would otherwise glue onto tokens
    var clean = t.replace(/[*_`#>]+/g, ' ');
    // never let the guard crash the UI (GUARD_DEBUG=1 in Node rethrows so tests see bugs)
    var debug = typeof process !== 'undefined' && process.env && process.env.GUARD_DEBUG;
    function safe(fn) { try { return fn(); } catch (e) { if (debug) throw e; return null; } }
    var mentions = safe(function () { return addPronounMentions(clean, findMentions(clean, ctx.catalog)); }) || [];
    safe(function () { checkPrices(clean, ctx, mentions, problems); });
    safe(function () { checkContradictions(clean, ctx, mentions, problems); });
    safe(function () { checkSpecs(clean, ctx, mentions, problems); });
    safe(function () { checkBrands(clean, ctx, problems); });
    safe(function () { checkNames(clean, ctx, problems); });
    problems = uniq(problems);
    return { ok: problems.length === 0, problems: problems };
  }

  // products the model was shown this turn: cards + retrieved + price-excluded + any catalog product named in the prompt
  function allowedFromConv(conv, catalog) {
    conv = conv || {};
    var byId = Object.create(null), out = [];
    (catalog || []).forEach(function (p) { byId[p.id] = p; });
    function add(p) { if (p && p.id && byId[p.id] && out.indexOf(byId[p.id]) < 0) out.push(byId[p.id]); }
    (conv.products || []).forEach(add);
    var ret = conv.run && conv.run.retrieval;
    if (ret) {
      (ret.results || []).forEach(function (x) { add(x.product); });
      (ret.excluded || []).forEach(function (x) { add(x.product); });
    }
    var prompt = conv.llm ? low(String(conv.llm.system || '') + '\n' + String(conv.llm.user || '')) : '';
    if (prompt) (catalog || []).forEach(function (p) { if (prompt.indexOf(low(p.name)) >= 0) add(p); });
    return out;
  }

  var api = { checkAnswer: checkAnswer, allowedFromConv: allowedFromConv, findPrices: findPrices, BRANDS: BRANDS.map(function (b) { return b[0]; }) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TechMartGuard = api;
})(typeof window !== 'undefined' ? window : this);
