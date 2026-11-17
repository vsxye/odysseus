/* Plain-node tests for web/guard.js.  Run: node tests/guard.test.js */
'use strict';
process.env.GUARD_DEBUG = '1';
var assert = require('assert');
var path = require('path');
var catalog = require(path.join(__dirname, '..', 'data', 'products.json'));
var E = require(path.join(__dirname, '..', 'web', 'engine.js'));
var G = require(path.join(__dirname, '..', 'web', 'guard.js'));

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message ? e.message : e)); }
}
function byName(n) { return catalog.filter(function (p) { return p.name === n; })[0]; }
function ctx(user, allowedNames) {
  return { catalog: catalog, allowed: (allowedNames || []).map(byName), userMessage: user || '' };
}
function expectOk(text, c) {
  var r = G.checkAnswer(text, c);
  assert.ok(r.ok, 'expected ok, got problems: ' + JSON.stringify(r.problems) + '\n       text: ' + text.slice(0, 300));
}
function expectFail(text, c, re) {
  var r = G.checkAnswer(text, c);
  assert.ok(!r.ok, 'expected guard to fail for: ' + text);
  if (re) assert.ok(r.problems.some(function (p) { return re.test(p); }), 'problems did not mention ' + re + ': ' + JSON.stringify(r.problems));
}

var ASSIGNMENT = [
  ['Does the NovaBook Air have enough RAM for coding?', 1],
  ['Which earbuds have the longest battery life?', 1],
  ['I need wireless headphones under ₹10,000 with good battery life', 2],
  ['What laptops do you have for students?', 2],
  ['Which laptop is best for video editing under ₹70,000?', 3]
];
var MORE_QUERIES = [
  'best gaming laptop under 1 lakh', 'cheapest phone', 'most expensive laptop', 'show me all tablets', 'what monitors do you have',
  'earbuds with ANC under ₹5,000', 'smartwatch for running with GPS', 'speaker for a party', 'monitor for photo editing',
  'tablet for kids', 'phone with the best camera', 'laptop for coding under 60k', 'headset for gaming', 'gift under ₹5,000',
  'compare Zentra Vision 15 vs Pixelon Slim 14', 'compare NovaBook Air 14 and NovaBook Pro 15', 'do you have the iPhone 15?',
  'PS5', 'what do you sell?', 'lightest laptop', 'phone under 20000', 'earbuds for the gym', 'battery of Nova Watch 3?',
  'does SoundCore X40 have ANC?', 'zentra vision', 'novabook air', 'travel headphones with long battery', 'office monitor',
  'video editing laptop under 90k', 'cheap earbuds', 'samsung galaxy s24', 'anything with 32GB RAM'
];

console.log('guard.test.js');

// ---- 1. zero false positives on the engine's own deterministic answers
test('5 assignment queries: offline answers pass (run)', function () {
  ASSIGNMENT.forEach(function (q) {
    var r = E.run(q[0], catalog, { stage: q[1], k: 5 });
    var conv = { run: r, llm: r.prompt, products: [] };
    expectOk(r.offline_answer, { catalog: catalog, allowed: G.allowedFromConv(conv, catalog), userMessage: q[0] });
  });
});
test('5 assignment queries: converse answers pass at every stage', function () {
  ASSIGNMENT.forEach(function (q) {
    [1, 2, 3].forEach(function (stage) {
      var c = E.converse(q[0], catalog, null, { stage: stage, k: 5 });
      expectOk(c.answer, { catalog: catalog, allowed: G.allowedFromConv(c, catalog), userMessage: q[0] });
    });
  });
});
test('32 more queries: run() and converse() answers pass', function () {
  MORE_QUERIES.forEach(function (q) {
    var r = E.run(q, catalog, { stage: 3, k: 5 });
    expectOk(r.offline_answer, { catalog: catalog, allowed: G.allowedFromConv({ run: r, llm: r.prompt }, catalog), userMessage: q });
    var c = E.converse(q, catalog, null, { stage: 3, k: 5 });
    expectOk(c.answer, { catalog: catalog, allowed: G.allowedFromConv(c, catalog), userMessage: q });
  });
});
test('multi-turn follow-ups pass ("anything cheaper?", "compare them", "show more")', function () {
  var chains = [
    ['best laptop for video editing under 90k', 'anything cheaper?', 'compare the top two', 'tell me more about the first one'],
    ['earbuds with ANC', 'under 5k?', 'which has the longest battery?', 'show more'],
    ['gaming laptop', 'and with more RAM?', 'compare them'],
    ['phone with a good camera', 'anything cheaper?', 'anything cheaper?']
  ];
  chains.forEach(function (chain) {
    var state = null, users = [];
    chain.forEach(function (q) {
      users.push(q);
      var c = E.converse(q, catalog, state, { stage: 3, k: 5 });
      state = c.state;
      expectOk(c.answer, { catalog: catalog, allowed: G.allowedFromConv(c, catalog), userMessage: users.join('\n'), context: c.llm ? c.llm.user : '', engineAnswer: c.answer });
    });
  });
});
test('every catalog product named with its price passes (50 products, several formats)', function () {
  catalog.forEach(function (p) {
    var n = p.price;
    var plain = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    expectOk('The **' + p.name + '** costs ' + E.inr(n) + '.', ctx(''));
    expectOk(p.name + ' is ₹' + plain + ' (Rs. ' + n + ', INR ' + plain + ').', ctx(''));
    expectOk('Consider the ' + p.name + ' at about ₹' + Math.round(n / 1000) + 'k — ' + p.specs + '.', ctx(''));
  });
});
test('every catalog product passes in tell-me-more answers', function () {
  catalog.forEach(function (p) {
    var q = 'Tell me more about ' + p.name;
    var c = E.converse(q, catalog, null, { stage: 3, k: 5 });
    expectOk(c.answer, { catalog: catalog, allowed: G.allowedFromConv(c, catalog), userMessage: q });
  });
});
test('partial catalog names and spec words pass', function () {
  expectOk('The NovaBook Air has 8GB RAM and an Intel i5, which is fine for coding. The Zentra Vision has an RTX 4050 and AMD Ryzen 7.', ctx('novabook air'));
  expectOk('Look at the Pixelon Slate Pro 12 (M2 chip, 120Hz) or the Lumio ProArt 27 4K with USB-C 90W, Full HD is not enough.', ctx(''));
  expectOk('SoundCore X40 offers ANC and IP54; Bluetooth 5.3 on the SoundCore Lite 20. Zentra Tab S9 is IP68.', ctx(''));
  expectOk('Best Gaming Laptop Under 70k: Zentra Vision 15 with a 144Hz display, Windows 11 and Wi-Fi 6.', ctx('gaming laptop under 70k'));
});

// ---- 2. things the guard must catch
test('Acer Predator example fails', function () {
  expectFail('If you want something cheaper, try the Acer Predator Helios 300 at ₹57,990.', ctx('anything cheaper?', ['Zentra Vision 15', 'Pixelon Slim 14']), /Acer|57,990/);
});
test('invented price on a real product fails', function () {
  expectFail('The Zentra Vision 15 is now just ₹59,990 with 16GB RAM.', ctx('gaming laptop', ['Zentra Vision 15']), /59,990/);
});
test('invented plain comma price fails', function () {
  expectFail('NovaBook Air 14 is available for 47,500 this week.', ctx('novabook air'), /47,500/);
});
test('invented "Zentra Vision 99" fails', function () {
  expectFail('For heavy editing get the Zentra Vision 99 at ₹68,990.', ctx('video editing laptop'), /Zentra Vision 99/);
});
test('invented "Nova Pods 3" fails', function () {
  expectFail('Try the Nova Pods 3 for workouts.', ctx('gym earbuds'), /Nova Pods 3/);
});
test('invented variant "Pixelon P8 Pro" fails', function () {
  expectFail('The Pixelon P8 Pro has a 200MP camera.', ctx('best camera phone'), /Pixelon P8 Pro/);
});
test('outside brand not asked about fails (Samsung Galaxy)', function () {
  expectFail('You could also look at the Samsung Galaxy S24.', ctx('best phone'), /Samsung|Galaxy/);
});
test('outside brand mentioned positively even if user asked fails', function () {
  expectFail('The iPhone 15 is a great choice at ₹79,900.', ctx('Do you have the iPhone 15?'), /iPhone|79,900/);
});
test('unknown brand-like product name fails ("Predator Helios 300" alone)', function () {
  expectFail('A good pick is the Predator Helios 300.', ctx('gaming laptop'));
});
test('empty and very short replies fail', function () {
  expectFail('', ctx('hi'), /empty/);
  expectFail('  ok ', ctx('hi'), /empty/);
  expectFail(null, ctx('hi'), /empty/);
});

// ---- 3. allowed edge cases
test('"we don\'t carry iPhone 15" passes when the user asked about iPhone', function () {
  expectOk("Sorry, we don't carry the iPhone 15. The closest phones we stock are the Zentra Z5 Pro (₹39,999) and Vertex Edge Ultra (₹89,999).", ctx('do you have iPhone 15?'));
  expectOk('The iPhone 15 is not in our catalog, but the Nova Phone 12 Pro (₹54,999) is close.', ctx('iphone 15 price?'));
});
test('price-difference sentence passes', function () {
  expectOk('The NovaBook Air 14 is ₹26,000 cheaper than the NovaBook Pro 15.', ctx('compare them', ['NovaBook Air 14', 'NovaBook Pro 15']));
  expectOk('Pixelon Slim 14 costs ₹7,990 less than Zentra Vision 15.', ctx('anything cheaper?', ['Zentra Vision 15', 'Pixelon Slim 14']));
});
test('price difference with empty allowed list passes via catalog pair in a "more/less" sentence', function () {
  expectOk('Zentra Vision 15 costs ₹7,990 more than Pixelon Slim 14.', ctx('which is pricier?'));
});
test('random unexplained amount is not excused as a difference', function () {
  expectFail('Total cost: ₹7,777.', ctx('price?', ['Zentra Vision 15', 'Pixelon Slim 14']), /7,777/);
});
test('budget echo "under ₹70,000" passes', function () {
  expectOk('Under ₹70,000, the Zentra Vision 15 (₹68,990) is the best pick for video editing.', ctx('Which laptop is best for video editing under 70k?'));
  expectOk('Within your ₹1,00,000 budget the Pixelon Blaze 15 (₹89,990) fits.', ctx('gaming laptop under 1 lakh'));
  expectOk('Within your Rs 60,000 budget the NovaBook Air 14 works.', ctx('laptop under 60000 for coding'));
});
test('ambiguous English words are not brands ("noise cancellation", "nothing", "galaxy of features")', function () {
  expectOk('Noise Cancellation: the Zentra Voyage ANC blocks noise well. Nothing else comes close at ₹9,499.', ctx('travel headphones'));
  expectOk('Nothing beats the Vertex Sonic Infinity for battery (80hr).', ctx('longest battery headset'));
});
test('user-named outside product echoed in a negative sentence passes (PS5)', function () {
  expectOk("We don't sell the PS5 — TechMart carries laptops, phones, tablets, audio, watches and monitors.", ctx('PS5'));
});
// ---- 4. price and spec binding to the product named in the clause
test('Nova Tab 11 with another product\'s price and wrong specs fails', function () {
  var c = ctx('cheap tablet', ['Nova Tab 11', 'Lumio Pad Mini', 'Arcwave Tab Go', 'Pixelon View 24']);
  var r = G.checkAnswer('The Nova Tab 11 is ₹9,999 and comes with 2GB RAM and 32GB storage.', c);
  assert.ok(!r.ok);
  assert.ok(r.problems.some(function (p) { return /9,999.*Nova Tab 11|Nova Tab 11.*9,999/.test(p); }), JSON.stringify(r.problems));
  assert.ok(r.problems.some(function (p) { return /2GB RAM/.test(p); }), JSON.stringify(r.problems));
  assert.ok(r.problems.some(function (p) { return /32GB storage/.test(p); }), JSON.stringify(r.problems));
  expectFail('Nova Tab 11 is ₹9,999.', ctx('cheap tablet'), /Nova Tab 11/); // bound even with an empty allowed list
});
test('price formats bound to the named product ("X at ₹Y", "X for ₹Y", "X costs ₹Y", "X (₹Y)") pass', function () {
  expectOk('Get the Zentra Vision 15 at ₹68,990, or the Pixelon Slim 14 for ₹61,000. The NovaBook Air 14 costs ₹52,000 and the Arcwave Campus 14 (₹33,990) is cheapest.', ctx('laptop'));
});
test('unbound price outside the products shown to the model fails when allowed is set', function () {
  expectFail('Prices start at ₹21,999 for this kind of setup.', ctx('gaming laptop', ['Zentra Vision 15', 'Pixelon Slim 14']), /21,999/);
  expectOk('Prices start at ₹61,000 for this kind of setup.', ctx('gaming laptop', ['Zentra Vision 15', 'Pixelon Slim 14']));
});
test('wrong single spec next to a product fails (RAM, GPU, battery, CPU, refresh, IP, weight, screen)', function () {
  expectFail('The Zentra Vision 15 has 32GB RAM.', ctx('laptop'), /32GB RAM/);
  expectFail('The Pixelon Slim 14 has an RTX 4060.', ctx('laptop'), /RTX 4060/);
  expectFail('SoundCore X40 gives you 50 hours of battery.', ctx('earbuds'), /50 hours/);
  expectFail('The NovaBook Air 14 runs an Intel i7.', ctx('laptop'), /i7/);
  expectFail('Vertex Strike 27 refreshes at 240Hz.', ctx('monitor'), /240Hz/);
  expectFail('Arcwave Pulse Sport is rated IP68.', ctx('earbuds'), /IP68/);
  expectFail('The Arcwave Campus 14 weighs just 0.9 kg.', ctx('laptop'), /0\.9 kg/);
  expectFail('Nova Phone 12 has a 6.9-inch screen.', ctx('phone'), /6\.9-inch/);
});
test('every product with its own price and full spec string passes', function () {
  catalog.forEach(function (p) {
    expectOk('The ' + p.name + ' is ' + E.inr(p.price) + ' and offers ' + p.specs + '.', ctx('', [p.name]));
    expectOk(p.name + "'s " + p.specs.split(', ')[0] + ' stands out.', ctx(''));
  });
});
test('two-product sentence with correct specs passes', function () {
  expectOk('The NovaBook Air 14 has 8GB RAM and a 10hr battery, while the NovaBook Pro 15 has 16GB RAM, an RTX 3050 and an 8hr battery.', ctx('compare them', ['NovaBook Air 14', 'NovaBook Pro 15']));
  expectOk('Zentra Vision 15 (₹68,990) has an RTX 4050 and 144Hz display, and Pixelon Slim 14 (₹61,000) has a 12hr battery and Intel i5.', ctx('compare'));
  expectOk('Pixelon Slim 14 has a 12hr battery vs 7hr battery on the Zentra Vision 15.', ctx('compare', ['Zentra Vision 15', 'Pixelon Slim 14']));
});
test('possessive "Arcwave Campus 14\'s 14-hour battery" passes', function () {
  expectOk("The Arcwave Campus 14's 14-hour battery and 1.2 kg weight make it ideal for students.", ctx('student laptop'));
  expectOk('The Arcwave Campus 14 14-hour battery is the longest here.', ctx('student laptop'));
  expectOk('Nova Watch 3’s 7-day battery is great.', ctx('watch'));
});

// ---- 5. round 3: "cheaper at ₹X", difference direction, pronouns, contradictions
var TABLETS = ['Nova Tab 11', 'Lumio Pad Mini', 'Arcwave Tab Go', 'Zentra Tab S9'];
test('"<product> is ₹D cheaper at ₹X" binds ₹X to the product (fails)', function () {
  expectFail('The Nova Tab 11 is ₹2,000 cheaper at ₹9,499.', ctx('anything cheaper?', TABLETS), /9,499.*Nova Tab 11/);
  expectFail('The Nova Tab 11 is ₹3,000 cheaper at ₹8,499.', ctx('anything cheaper?', TABLETS), /8,499/);
  expectFail('The Nova Tab 11 is ₹2,000 cheaper.', ctx('anything cheaper?', TABLETS), /2,000/); // no ₹2,000 gap from Nova Tab 11
});
test('"at just / priced at / for only / now ₹X" with the wrong price fails', function () {
  expectFail('Grab the Nova Tab 11 at just ₹15,999.', ctx('tablet'), /Nova Tab 11/);
  expectFail('The Lumio Pad Mini is priced at ₹11,499.', ctx('tablet'), /Lumio Pad Mini/);
  expectFail('You can get the Zentra Tab S9 for only ₹21,999.', ctx('tablet'), /Zentra Tab S9/);
  expectFail('The Pixelon Slate Pro 12 is now ₹42,999.', ctx('tablet'), /Pixelon Slate Pro 12/);
});
test('correct "cheaper at" / "priced at" / "for only" sentences pass', function () {
  expectOk('The Lumio Pad Mini is ₹6,000 cheaper at ₹15,999.', ctx('anything cheaper?', TABLETS));
  expectOk('The Nova Tab 11 is priced at ₹21,999, and the Arcwave Tab Go is yours for only ₹11,499.', ctx('tablet'));
  expectOk('The Zentra Tab S9 is now ₹42,999 and the Lumio Pad Mini at just ₹15,999.', ctx('tablet'));
});
test('difference direction: "It\'s also ₹6,990 cheaper than the Pixelon Slim 14" about Zentra Vision 15 fails', function () {
  var c = ctx('video editing laptop', ['Zentra Vision 15', 'Pixelon Slim 14']);
  expectFail('The Zentra Vision 15 is our best pick at ₹68,990. It\'s also ₹6,990 cheaper than the Pixelon Slim 14.', c, /cheaper than Pixelon Slim 14/);
  expectFail('The Zentra Vision 15 is our best pick at ₹68,990. It\'s also ₹7,990 cheaper than the Pixelon Slim 14.', c, /more expensive/);
  expectFail('Zentra Vision 15 is ₹7,990 cheaper than Pixelon Slim 14.', c);
  expectFail('Pixelon Slim 14 is ₹7,990 more expensive than the Zentra Vision 15.', c);
});
test('difference direction: correct cheaper / more expensive / saves you sentences pass', function () {
  var c = ctx('compare', ['Zentra Vision 15', 'Pixelon Slim 14']);
  expectOk('The Pixelon Slim 14 is ₹7,990 cheaper than the Zentra Vision 15.', c);
  expectOk('The Zentra Vision 15 is ₹7,990 more expensive than the Pixelon Slim 14.', c);
  expectOk('Zentra Vision 15 is ₹7,990 pricier than Pixelon Slim 14.', c);
  expectOk('The Zentra Vision 15 leads on graphics. It is ₹7,990 costlier than the Pixelon Slim 14.', c);
  expectOk('Choosing the Pixelon Slim 14 over the Zentra Vision 15 saves you ₹7,990.', c);
});
test('"saves you ₹D" with the wrong gap fails', function () {
  expectFail('Choosing the Pixelon Slim 14 over the Zentra Vision 15 saves you ₹5,000.', ctx('compare', ['Zentra Vision 15', 'Pixelon Slim 14']), /saving/);
});
test('pronoun spec claims bind to the previous product ("It has 3GB RAM" after Nova Tab 11 fails)', function () {
  expectFail('The Nova Tab 11 is a solid pick. It has 3GB RAM.', ctx('tablet'), /Nova Tab 11.*3GB RAM/);
  expectFail('Consider the Zentra Vision 15. It comes with an RTX 4060.', ctx('laptop'), /RTX 4060/);
  expectFail('Consider the Arcwave Campus 14. With 16GB RAM, it flies.', ctx('laptop'), /16GB RAM/);
  expectFail('Look at the SoundCore X40. It\'s got a 45hr battery.', ctx('earbuds'), /45hr/);
});
test('pronoun spec claims with correct values pass', function () {
  expectOk('The Nova Tab 11 is a solid pick. It has 6GB RAM, 128GB storage and a 12hr battery.', ctx('tablet'));
  expectOk('Consider the Zentra Vision 15. It comes with an RTX 4050 and a 144Hz display. It offers 16GB RAM.', ctx('laptop'));
  expectOk('Consider the NovaBook Air 14. With 16GB RAM, the Pixelon Slim 14 is better for multitasking.', ctx('laptop'));
  expectOk('Compare the NovaBook Air 14 and Pixelon Slim 14. It has 16GB RAM.', ctx('laptop')); // ambiguous "It": not bound
});
test('contradiction with engine "already the most affordable" fails', function () {
  var c = ctx('anything cheaper?', TABLETS);
  c.engineAnswer = 'The **Arcwave Tab Go** (₹11,499) is already the most affordable tablet we sell.';
  expectFail('For something cheaper, try the Lumio Pad Mini at ₹15,999.', c, /already the most affordable/);
  expectFail('The Lumio Pad Mini is a more affordable choice.', c, /Lumio Pad Mini/);
});
test('agreeing with engine "already the cheapest" passes', function () {
  var c = ctx('anything cheaper?', TABLETS);
  c.engineAnswer = 'The Arcwave Tab Go is already the cheapest tablet in our catalog (₹11,499).';
  expectOk('The Arcwave Tab Go is already our cheapest tablet at ₹11,499 — nothing is cheaper.', c);
  expectOk('Nothing is cheaper than the Arcwave Tab Go (₹11,499); the Lumio Pad Mini costs ₹15,999.', c);
});

test('allowedFromConv collects retrieved products', function () {
  var c = E.converse('earbuds with ANC under ₹5,000', catalog, null, { stage: 3, k: 5 });
  var a = G.allowedFromConv(c, catalog);
  assert.ok(a.length >= 1 && a.every(function (p) { return p && p.id; }));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
