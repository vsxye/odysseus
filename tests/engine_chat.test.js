/*
 * Chat-layer tests for web/engine.js converse().  Plain node, no deps:
 *   node tests/engine_chat.test.js        (-v for transcripts)
 */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const E = require(path.join(__dirname, '..', 'web', 'engine.js'));
const P = require(path.join(__dirname, '..', 'data', 'products.json'));

const VERBOSE = process.argv.includes('-v');
const BY_ID = Object.fromEntries(P.map(p => [p.id, p]));
const KINDS = ['greeting', 'thanks', 'help', 'smalltalk', 'off_topic', 'not_found', 'product_question', 'recommendation', 'list', 'compare', 'catalog_overview', 'clarify'];
const LLM_KINDS = ['product_question', 'recommendation', 'list', 'compare', 'not_found'];
const BRANDS = [...new Set(P.map(p => p.brand))];
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let checks = 0, messages = 0;
const failures = [];
const timings = [];
const chipQueue = []; // [chip, state] pairs produced by tested turns; replayed at the end

function check(name, fn) {
  try { fn(); checks++; } catch (e) { failures.push(name + ': ' + (e && e.message)); }
}

// ------------------------------------------------------------------ generic invariants for every response
function validate(msg, r, label) {
  assert(r && typeof r === 'object', 'result object');
  assert(KINDS.includes(r.kind), 'unknown kind ' + r.kind);
  assert(typeof r.answer === 'string' && r.answer.trim().length > 0, 'answer non-empty');
  assert(Array.isArray(r.products) && r.products.length <= 3, 'products array (<=3)');
  r.products.forEach(c => {
    const p = BY_ID[c.id];
    assert(p, 'product ' + c.id + ' not in catalog');
    assert.strictEqual(c.name, p.name, 'card name matches catalog');
    assert.strictEqual(c.price, p.price, 'card price matches catalog');
    assert.strictEqual(c.category, p.category);
    assert(['Best pick', 'Runner-up', ''].includes(c.badge), 'badge');
    assert(Array.isArray(c.why), 'why array');
  });
  assert(Array.isArray(r.suggestions) && r.suggestions.length === 3 && r.suggestions.every(s => typeof s === 'string' && s.length > 0 && s.length <= 60), 'three suggestion chips');
  const deterministic = /already the most affordable match|^None of our |^Sorry — none of our |^Nothing in our catalog fits|Nothing in our catalog matches \*\*[^*]+\*\* exactly|^That's everything we have/m.test(r.answer);
  assert.strictEqual(r.needs_llm, LLM_KINDS.includes(r.kind) && r.products.length > 0 && !deterministic, 'needs_llm rule');
  assert(r.must_include === null || (typeof r.must_include === 'string' && r.answer.startsWith(r.must_include) && /don't carry/.test(r.must_include)), 'must_include');
  assert(Array.isArray(r.facts_numbers) && (r.kind === 'product_question' || r.facts_numbers.length === 0), 'facts_numbers');
  if (/^Sorry, we don't carry/.test(r.answer)) assert(r.must_include, 'must_include set when answer leads with "we don\'t carry"');
  if (r.needs_llm) {
    assert(r.llm && typeof r.llm.system === 'string' && typeof r.llm.user === 'string', 'llm prompt present');
    assert(/TechMart's friendly shopping assistant/.test(r.llm.system), 'persona');
    assert(/don't answer the question, say so/.test(r.llm.system), 'say-so rule');
    assert(/FACTS YOU MAY USE/.test(r.llm.user), 'facts section');
    assert(E.estimateTokens(r.llm.system + '\n' + r.llm.user) <= 950, 'prompt under ~900 tokens (' + E.estimateTokens(r.llm.system + r.llm.user) + ')');
    const lines = r.llm.user.split('\n').filter(l => /^- .+ \| .+ \| ₹/.test(l));
    assert(lines.length >= 1 && lines.length <= 6, 'prompt lists 1-6 products');
    lines.forEach(l => { const nm = l.slice(2).split(' | ')[0]; assert(P.some(p => p.name === nm), 'prompt product in catalog: ' + nm); });
  } else {
    assert.strictEqual(r.llm, null, 'llm null when not needed');
  }
  assert(typeof r.resolved_query === 'string', 'resolved_query');
  assert(r.state && typeof r.state.turn === 'number' && Array.isArray(r.state.last_ids), 'state shape');
  r.state.last_ids.forEach(id => assert(BY_ID[id], 'state id in catalog'));
  assert.doesNotThrow(() => JSON.stringify(r.state), 'state serialisable');
  if (['recommendation', 'list', 'compare', 'product_question', 'not_found'].includes(r.kind) && r.products.length) assert(r.run && r.run.retrieval, 'run trace present');
  checkAnswerFacts(r.answer);
}

// every "Name — ₹x" / "Name (₹x)" / "Name** at **₹x" in an answer must use the catalog price,
// and every bold phrase that starts with one of our brands must be a real catalog product.
function checkAnswerFacts(answer) {
  P.forEach(p => {
    const re = new RegExp(escRe(p.name) + '(?![\\w])\\**\\s*(?:\\(|—|-|:|,|at|costs)?\\s*\\**\\s*(₹[\\d,]+)', 'g');
    let m;
    while ((m = re.exec(answer))) assert.strictEqual(m[1], E.inr(p.price), 'price for ' + p.name + ' in answer: ' + m[1]);
  });
  const bolds = answer.match(/\*\*([^*]+)\*\*/g) || [];
  bolds.forEach(b => {
    let t = b.slice(2, -2).replace(/^(Best pick|Runner-up|Top pick):\s*/, '').replace(/\s*(—|\().*$/, '').trim();
    const first = t.split(/\s+/)[0];
    if (BRANDS.includes(first) && !/ products$/.test(t) && t.split(/\s+/).length > 1) assert(P.some(p => p.name === t), 'bold product name not in catalog: "' + t + '"');
  });
}

function say(msg, state, opts, label) {
  messages++;
  let r;
  const t0 = process.hrtime.bigint();
  try { r = E.converse(msg, P, state, opts || {}); } catch (e) { failures.push('THROW on ' + JSON.stringify(msg) + ': ' + e.stack); return null; }
  timings.push(Number(process.hrtime.bigint() - t0) / 1e6);
  check('invariants: ' + JSON.stringify(msg), () => validate(msg, r, label));
  if (r && r.suggestions) r.suggestions.forEach(s => chipQueue.push([s, r.state, msg]));
  if (VERBOSE) {
    console.log('\n> ' + msg + '   [' + r.kind + (r.needs_llm ? ', llm' : '') + '] resolved="' + r.resolved_query + '"');
    console.log(r.answer.split('\n').map(l => '  ' + l).join('\n'));
    console.log('  cards: ' + r.products.map(c => c.name + ' ' + E.inr(c.price) + (c.badge ? ' [' + c.badge + ']' : '')).join(' | '));
    console.log('  chips: ' + r.suggestions.join(' | '));
  }
  return r;
}

// conversation helper: [message, expectedKind, extraCheck(r, prev)]
function conversation(name, turns, opts) {
  let state = null, prev = null;
  if (VERBOSE) console.log('\n======== ' + name);
  turns.forEach(([msg, kind, extra]) => {
    const r = say(msg, state, opts);
    if (!r) return;
    check(name + ' / ' + JSON.stringify(msg) + ' kind', () => assert.strictEqual(r.kind, kind, 'expected ' + kind + ', got ' + r.kind + ' (' + r.answer.slice(0, 80) + ')'));
    if (extra) check(name + ' / ' + JSON.stringify(msg) + ' detail', () => extra(r, prev));
    prev = r; state = r.state;
  });
  return state;
}
const ids = r => r.products.map(c => c.id);
const top = r => r.products[0] && r.products[0].id;
const allCat = (r, cats) => r.products.every(c => cats.includes(c.category));

// ================================================================== 1. assignment queries: run() unchanged
const ASSIGNMENT = [
  ['Does the NovaBook Air have enough RAM for coding?', { 1: 'P01,P02', 2: 'P01,P11,P10,P02,P09', 3: 'P01,P11,P10,P02,P09' }],
  ['Which earbuds have the longest battery life?', { 1: 'P03', 2: 'P17,P18,P15,P16,P03', 3: 'P17,P18,P15,P16,P03' }],
  ['I need wireless headphones under ₹10,000 with good battery life', { 1: 'P04,P03', 2: 'P21,P04,P20,P19,P15', 3: 'P21,P04,P20,P19,P15' }],
  ['What laptops do you have for students?', { 1: 'P01,P02', 2: 'P08,P06,P01,P07,P02', 3: 'P08,P06,P01,P07,P02' }],
  ['Which laptop is best for video editing under ₹70,000?', { 1: 'P01', 2: 'P05,P06,P01,P08,P07', 3: 'P05,P06,P01,P08,P07' }]
];
ASSIGNMENT.forEach(([q, byStage]) => {
  [1, 2, 3].forEach(s => check('run() ranking unchanged: stage ' + s + ' ' + q, () => {
    const r = E.run(q, P, { stage: s });
    assert.strictEqual(r.retrieval.results.map(x => x.product.id).join(','), byStage[s]);
  }));
});
// ... and converse() gives the same top pick (stage 3)
const CONVERSE_TOP = { 0: ['product_question', 'P01'], 1: ['recommendation', 'P17'], 2: ['recommendation', 'P21'], 3: ['list', 'P08'], 4: ['recommendation', 'P05'] };
ASSIGNMENT.forEach(([q], i) => {
  const r = say(q, null, { stage: 3 });
  check('converse top pick: ' + q, () => { assert.strictEqual(r.kind, CONVERSE_TOP[i][0]); assert.strictEqual(top(r), CONVERSE_TOP[i][1]); });
});
check('converse Q5 mentions excluded NovaBook Pro 15', () => assert(/NovaBook Pro 15\*\* \(₹78,000\)/.test(say(ASSIGNMENT[4][0], null).answer)));
check('converse RAM/coding answer', () => { const a = say(ASSIGNMENT[0][0], null).answer; assert(/8GB RAM/.test(a) && /coding/.test(a)); });
check('parseQuery unchanged for Q5', () => {
  const pq = E.parseQuery(ASSIGNMENT[4][0], P);
  assert.deepStrictEqual([pq.categories, pq.price_max, pq.use_case, pq.pinned_ids], [['Laptop'], 70000, 'video_editing', []]);
});
check('retrieve() unchanged for Q3', () => assert.strictEqual(E.retrieve(ASSIGNMENT[2][0], P).results[0].product.id, 'P21'));
check('stage 1 converse uses the starter catalog', () => {
  const r = say('Does the NovaBook Air have enough RAM for coding?', null, { stage: 1 });
  assert.strictEqual(r.kind, 'product_question'); assert.strictEqual(top(r), 'P01');
  assert(r.products.every(c => ['P01', 'P02', 'P03', 'P04'].includes(c.id)));
});

// ================================================================== 2. multi-turn conversations
conversation('video editing -> cheaper -> compare -> first one', [
  ['laptop for video editing under 70k', 'recommendation', r => { assert.strictEqual(top(r), 'P05'); assert(allCat(r, ['Laptop'])); assert(r.products.every(c => c.price <= 70000)); }],
  ['anything cheaper?', 'recommendation', r => { assert(allCat(r, ['Laptop'])); assert(r.products.every(c => c.price < 68990)); assert(/video editing/.test(r.resolved_query)); assert(/cheaper than the \*\*Zentra Vision 15\*\*/.test(r.answer)); }],
  ['compare the top two', 'compare', (r, prev) => { assert.deepStrictEqual(ids(r), prev.state.last_ids.slice(0, 2)); assert(/Verdict/.test(r.answer)); assert(/₹/.test(r.answer)); }],
  ['tell me more about the first one', 'product_question', (r, prev) => assert.strictEqual(top(r), prev.state.last_ids[0])]
]);

conversation('greeting', [['hi', 'greeting', r => assert(r.products.length === 0 && !r.needs_llm)]]);

conversation('headphones -> which has ANC', [
  ['wireless headphones under 10000', 'recommendation', r => { assert(allCat(r, ['Headset', 'Earbuds'])); assert(r.products.every(c => c.price <= 10000)); }],
  ['which has ANC?', 'recommendation', r => { assert(r.products.every(c => BY_ID[c.id].attributes.anc === true)); assert(r.products.every(c => c.price <= 10000)); assert(allCat(r, ['Headset', 'Earbuds'])); }],
  ['which is lighter?', 'recommendation', r => assert(r.products.every(c => BY_ID[c.id].attributes.anc === true))]
]);

conversation('iphone', [['do you have iphone 15', 'not_found', r => { assert(/iPhone 15/.test(r.answer)); assert(r.products.length >= 1 && allCat(r, ['Smartphone'])); assert(r.needs_llm); }]]);
conversation('weather', [["what's the weather", 'off_topic', r => assert(/laptops/.test(r.answer) && !r.needs_llm)]]);
conversation('empty', [['', 'clarify'], ['   ', 'clarify']]);
conversation('gibberish', [['asdfgh', 'clarify', r => assert(!r.needs_llm)]]);
conversation('camera phone', [['best phone for camera', 'recommendation', r => { assert.strictEqual(top(r), 'P29'); assert(allCat(r, ['Smartphone'])); }]]);
conversation('cheapest tablet', [['cheapest tablet', 'list', r => { assert.strictEqual(top(r), 'P35'); assert(/₹11,499/.test(r.answer)); }]]);
conversation('typo product', [['novabok air battery', 'product_question', r => { assert.strictEqual(top(r), 'P01'); assert(/10hr battery/.test(r.answer)); }]]);
conversation('compare partial names', [['zentra vision vs pixelon slim', 'compare', r => { assert.deepStrictEqual(ids(r), ['P05', 'P06']); assert(/Pick the \*\*/.test(r.answer)); }]]);

conversation('watch -> gps -> compare -> lighter', [
  ['best smartwatch for running', 'recommendation', r => assert(allCat(r, ['Smartwatch']))],
  ['which has GPS?', 'recommendation', r => assert(r.products.every(c => BY_ID[c.id].attributes.gps === true))],
  ['compare them', 'compare', (r, prev) => assert.deepStrictEqual(ids(r).slice().sort(), prev.state.last_ids.slice(0, 2).sort())],
  ['which is lighter?', 'compare', r => assert(/lighter/.test(r.answer))]
]);

conversation('phones -> budget -> storage -> second -> compare it', [
  ['phones', 'list', r => assert(allCat(r, ['Smartphone']))],
  ['under 30k', 'recommendation', r => { assert(allCat(r, ['Smartphone'])); assert(r.products.every(c => c.price <= 30000)); }],
  ['more storage?', 'recommendation', r => { assert(r.products.every(c => c.price <= 30000)); assert.strictEqual(top(r), 'P25'); }],
  ['the second one', 'product_question', (r, prev) => assert.strictEqual(top(r), prev.state.last_ids[1])],
  ['compare it with zentra z5 pro', 'compare', (r, prev) => { assert(ids(r).includes('P26')); assert(ids(r).includes(prev.state.last_ids[0])); }]
]);

conversation('gaming -> RAM -> coding -> budget -> stock', [
  ['gaming laptop', 'recommendation', r => assert.strictEqual(top(r), 'P11')],
  ['what about with more RAM?', 'recommendation', r => assert(allCat(r, ['Laptop']))],
  ['and for coding?', 'recommendation', r => assert(/coding/.test(r.resolved_query))],
  ['under 1 lakh', 'recommendation', r => { assert(r.products.every(c => c.price <= 100000)); assert(/coding/.test(r.resolved_query)); }],
  ['is it in stock?', 'product_question', (r, prev) => { assert.strictEqual(top(r), prev.state.last_ids[0]); assert(/stock/.test(r.answer)); }]
]);

conversation('hinglish', [
  ['bhai 50k tak accha phone chahiye', 'recommendation', r => { assert(allCat(r, ['Smartphone'])); assert(r.products.every(c => c.price <= 50000)); }],
  ['kaunsa best hai camera ke liye', 'recommendation', r => { assert(allCat(r, ['Smartphone'])); assert(r.products.every(c => c.price <= 50000)); }],
  ['kitne ka hai', 'product_question', (r, prev) => assert.strictEqual(top(r), prev.state.last_ids[0])]
]);

conversation('emoji + greeting + request -> pronoun use-case -> show more', [
  ['Hey there 👋 can u suggest a gaming laptop under 1 lakh??', 'recommendation', r => { assert.strictEqual(top(r), 'P09'); assert(r.products.every(c => c.price <= 100000)); }],
  ['is it good for video editing?', 'product_question', (r, prev) => assert.strictEqual(top(r), prev.state.last_ids[0])],
  ['show more', 'list', (r, prev) => assert(r.products.every(c => !prev.state.last_ids.includes(c.id)))]
]);

conversation('greeting mid-conversation keeps context', [
  ['earbuds under 5000', 'recommendation', r => assert(r.products.every(c => c.price <= 5000 && c.category === 'Earbuds'))],
  ['thanks!', 'thanks'],
  ['anything cheaper?', 'recommendation', (r, prev) => assert(r.products.every(c => c.category === 'Earbuds'))],
  ['what about headsets?', 'recommendation', r => assert(allCat(r, ['Headset']))]
]);

conversation('product -> cheaper -> pricier', [
  ['tell me about the zentra z5 pro', 'product_question', r => assert.strictEqual(top(r), 'P26')],
  ['anything cheaper?', 'recommendation', r => { assert(allCat(r, ['Smartphone'])); assert(r.products.every(c => c.price < 39999)); }],
  ['something more premium', 'recommendation', r => assert(allCat(r, ['Smartphone']))]
]);

// ================================================================== 3. single-turn coverage by kind
const SINGLE = [
  // social
  ['thanks', 'thanks'], ['thank you so much', 'thanks'], ['ok', 'thanks'], ['bye', 'thanks'],
  ['who are you', 'help'], ['what can you do?', 'help'], ['help', 'help'],
  ['tell me a joke', 'smalltalk'], ['how are you?', 'smalltalk'], ['lol', 'smalltalk'], ['kaise ho', 'smalltalk'],
  ['hello', 'greeting'], ['good morning!', 'greeting'], ['namaste 🙏', 'greeting'],
  // off topic
  ['capital of france', 'off_topic'], ['write a poem', 'off_topic'], ['do you sell refrigerators?', 'off_topic'], ['i want a car', 'off_topic'],
  ['who is elon musk', 'off_topic'], ['give me a recipe for pasta', 'off_topic'], ['what is 2 + 2', 'off_topic'], ['buy shoes', 'off_topic'],
  // overview / lists
  ['what do you sell', 'catalog_overview'], ['what categories do you have?', 'catalog_overview'],
  ['show me all tablets', 'list', r => assert(allCat(r, ['Tablet']))],
  ['what monitors do you have', 'list', r => assert(allCat(r, ['Monitor']))],
  ['most expensive laptop', 'list', r => assert.strictEqual(top(r), 'P11')],
  ['cheapest phone', 'list', r => assert.strictEqual(top(r), 'P27')],
  ['zentra laptops', 'list', r => assert(r.products.every(c => BY_ID[c.id].brand === 'Zentra' && c.category === 'Laptop'))],
  ['nova phone', 'list', r => assert(r.products.every(c => BY_ID[c.id].brand === 'Nova'))],
  ['gift for dad under 5000', 'list', r => assert(r.products.every(c => c.price <= 5000))],
  ['do you sell laptops?', 'list', r => assert(allCat(r, ['Laptop']))],
  // not found
  ['ps5', 'not_found', r => assert(allCat(r, ['Laptop']))],
  ['sony headphones', 'not_found', r => assert(allCat(r, ['Headset', 'Earbuds']))],
  ['macbook air for students', 'not_found', r => assert(allCat(r, ['Laptop']))],
  ['samsung galaxy s24 ultra', 'not_found', r => { assert(allCat(r, ['Smartphone'])); assert(/Samsung/.test(r.answer)); }],
  ['do you have cameras', 'not_found', r => assert(allCat(r, ['Smartphone']))],
  ['speaker with anc', 'not_found', r => assert(allCat(r, ['Speaker']))],
  ['do you sell keyboards', 'not_found', r => assert(r.products.length === 0 && !r.needs_llm)],
  ['airpods pro', 'not_found', r => assert(allCat(r, ['Earbuds']))],
  // product questions
  ['does arcwave bass 300 have anc', 'product_question', r => { assert.strictEqual(top(r), 'P19'); assert(/\*\*No\*\*/.test(r.answer)); }],
  ['does the soundcore x40 have anc?', 'product_question', r => { assert.strictEqual(top(r), 'P03'); assert(/\*\*Yes\*\*/.test(r.answer)); }],
  ['is the zentra vision 15 good for gaming', 'product_question', r => assert.strictEqual(top(r), 'P05')],
  ['how much is the vertex forge', 'product_question', r => { assert.strictEqual(top(r), 'P11'); assert(/₹1,59,990/.test(r.answer)); }],
  ['nova phone 12 pro camera', 'product_question', r => assert.strictEqual(top(r), 'P30')],
  ['pixelon p8', 'product_question', r => assert.strictEqual(top(r), 'P25')],
  ['zentera tab s9 weight', 'product_question', r => { assert.strictEqual(top(r), 'P34'); assert(/500 g/.test(r.answer)); }],
  ['NOVABOOK PRO 15 SPECS!!!', 'product_question', r => assert.strictEqual(top(r), 'P02')],
  ['is the pixelon blaze waterproof', 'product_question', r => assert.strictEqual(top(r), 'P09')],
  // compare
  ['compare zentra echo buds 2 and pixelon tune pro', 'compare', r => assert.deepStrictEqual(ids(r), ['P15', 'P16'])],
  ['vertex strike 27 versus zentra curve 32', 'compare', r => assert.deepStrictEqual(ids(r), ['P47', 'P49'])],
  ['difference between nova watch 3 and lumio band 5', 'compare', r => assert.deepStrictEqual(ids(r), ['P36', 'P39'])],
  ['compare gaming laptops', 'compare', r => assert(allCat(r, ['Laptop']))],
  ['compare', 'clarify'],
  // recommendations
  ['gaming laptop', 'recommendation', r => assert.strictEqual(top(r), 'P11')],
  ['tablet for kids', 'recommendation', r => assert.strictEqual(top(r), 'P35')],
  ['earbuds for gym', 'recommendation', r => assert(allCat(r, ['Earbuds']))],
  ['monitor for gaming', 'recommendation', r => assert.strictEqual(top(r), 'P50')],
  ['smartwatch with gps', 'recommendation', r => assert(r.products.every(c => BY_ID[c.id].attributes.gps === true))],
  ['laptop for coding under 60000', 'recommendation', r => assert(r.products.every(c => c.price <= 60000 && c.category === 'Laptop'))],
  ['something for music', 'recommendation', r => assert(allCat(r, ['Headset', 'Earbuds']))],
  ['laptop for office work', 'recommendation', r => assert(allCat(r, ['Laptop']))],
  ['bluetooth speaker for a party', 'recommendation', r => assert(allCat(r, ['Speaker']))],
  ['phone under 20k with good battery', 'recommendation', r => assert(r.products.every(c => c.price <= 20000))],
  // clarify / glossary
  ['I need something good', 'clarify'], ['hmm what should I buy', 'clarify'], ['random words here please', 'clarify'],
  ['what is anc', 'help'], ['what is oled', 'help'],
  ['anything cheaper?', 'clarify']   // no prior state
];
SINGLE.forEach(([msg, kind, extra]) => {
  const r = say(msg, null);
  if (!r) return;
  check('single ' + JSON.stringify(msg) + ' kind', () => assert.strictEqual(r.kind, kind, 'expected ' + kind + ', got ' + r.kind + ' (' + r.answer.slice(0, 90) + ')'));
  if (extra) check('single ' + JSON.stringify(msg) + ' detail', () => extra(r));
});

// ================================================================== 4. robustness
const WEIRD = [null, undefined, 12345, '🙂🙂🙂', '<script>alert(1)</script>', '????', '₹₹₹', 'laptop '.repeat(400), 'a'.repeat(5000),
  'I want a laptop that is good for gaming and also video editing and coding and travel and it should be under 80000 and have a lot of RAM and battery '.repeat(5),
  'compare compare vs vs', '#2', 'the first one', 'it', 'under 0', 'between 10k and 5k laptops', 'LAPTOP', 'Laptop.', 'lapotp for gamng'];
WEIRD.forEach(m => {
  const r = say(m, null);
  check('robust ' + JSON.stringify(String(m).slice(0, 30)), () => assert(r && KINDS.includes(r.kind)));
});
check('garbage state is tolerated', () => {
  const r = E.converse('anything cheaper?', P, { turn: 'x', last_ids: ['ZZZ', null], last_plan: { categories: ['Laptop'] }, last_kind: 'compare' });
  validate('anything cheaper?', r);
  messages++;
});
check('non-object state is tolerated', () => { validate('hi', E.converse('hi', P, 'nonsense')); messages++; });
check('state turn increments', () => {
  const a = E.converse('hi', P, null), b = E.converse('gaming laptop', P, a.state), c = E.converse('thanks', P, b.state);
  messages += 3;
  assert.deepStrictEqual([a.state.turn, b.state.turn, c.state.turn], [1, 2, 3]);
  assert.deepStrictEqual(c.state.last_ids, b.state.last_ids, 'social turn keeps product context');
  assert(b.state.last_plan && b.state.last_plan.categories[0] === 'Laptop');
});

// ================================================================== 4b. regressions from the simulation run
// R1: follow-ups keep the previous (single) category + ANC + budget
conversation('R1 headset ANC cheapest stays on headsets', [
  ['wireless headphones under 10k', 'recommendation'],
  ['which has ANC?', 'recommendation', r => assert(allCat(r, ['Headset']))],
  ['cheapest one', 'recommendation', r => {
    assert(allCat(r, ['Headset']), 'stayed on Headset: ' + r.products.map(c => c.category));
    assert(r.products.every(c => BY_ID[c.id].attributes.anc === true && c.price <= 10000));
    assert.strictEqual(top(r), 'P20'); // Lumio Calm 500, cheapest ANC headset under 10k
  }]
]);
// R2: fitness refinement -> smartwatches + water-resistant sport earbuds only
conversation('R2 gift -> fitness', [
  ['gift under 5000 for dad', 'list'],
  ['he likes fitness', 'recommendation', r => {
    assert(allCat(r, ['Smartwatch', 'Earbuds']), 'got ' + r.products.map(c => c.category));
    assert(r.products.every(c => c.price <= 5000));
    assert(r.products.filter(c => c.category === 'Earbuds').every(c => /IP[X\d][5-9]/.test(BY_ID[c.id].attributes.water_resistance || '')));
  }]
]);
conversation('R2b fresh gym query', [['something for the gym', 'recommendation', r => assert(allCat(r, ['Smartwatch', 'Earbuds']))]]);
// R3: an outside product in a compare / question leads with "we don't carry X"
conversation('R3 macbook vs novabook', [['macbook vs novabook', 'compare', r => {
  assert(/^Sorry, we don't carry the \*\*MacBook\*\*/.test(r.answer), r.answer.slice(0, 80));
  assert(r.products.every(c => /NovaBook/.test(c.name)));
}]]);
conversation('R3b macbook question with a named product', [['is the macbook better than zentra vision 15', 'product_question', r => {
  assert(/^Sorry, we don't carry the \*\*MacBook\*\*/.test(r.answer)); assert.strictEqual(top(r), 'P05');
}]]);
conversation('R3c sony vs ours', [['sony vs soundcore studio pro', 'product_question', r => assert(/don't carry \*\*Sony products\*\*/.test(r.answer))]]);
// R4: long messages use the product-relevant sentence, not the opening filler
conversation('R4 long filler then request', [['Hello I have been thinking about many things today and the weather was nice. '.repeat(25) + 'laptop for video editing under 70000', 'recommendation', r => {
  assert(/video editing/.test(r.resolved_query) && r.resolved_query.length < 200, r.resolved_query.slice(0, 80));
  assert.strictEqual(top(r), 'P05');
}]]);
conversation('R4b long run-on filler', [['blah '.repeat(450) + '. I want a laptop for video editing under 70000', 'recommendation', r => assert.strictEqual(top(r), 'P05')]]);
// R5: no typo-correction of common words into categories; exact category words win
conversation('R5 sql-ish', [["'; DROP TABLE products; -- cheapest phone", 'list', r => { assert(allCat(r, ['Smartphone'])); assert.strictEqual(top(r), 'P27'); }]]);
conversation('R5b table alone', [['table', 'clarify']]);
conversation('R5c tab still means tablet', [['cheapest tab', 'list', r => assert(allCat(r, ['Tablet']))]]);
conversation('R5d real typo still fixed', [['cheapst tabelt', 'list', r => assert(allCat(r, ['Tablet']))]]);
// R6: "cheaper" never shows/sends price-1
conversation('R6 cheaper wording', [
  ['laptop for video editing under 70k', 'recommendation'],
  ['something cheaper', 'recommendation', r => {
    assert(!/68,989/.test(r.answer + r.resolved_query + r.llm.user + JSON.stringify(r.run.retrieval.funnel) + r.run.prompt.user), 'price-1 leaked');
    assert(/cheaper than Zentra Vision 15 \(₹68,990\)/.test(r.resolved_query), r.resolved_query);
    assert(/cheaper than/.test(r.llm.user));
    assert(r.products.every(c => c.price < 68990));
  }],
  ['anything cheaper', 'recommendation', (r, prev) => {
    const p0 = BY_ID[prev.state.last_ids[0]];
    assert(r.products.every(c => c.price < p0.price));
    assert(!new RegExp(E.inr(p0.price - 1).replace(/[₹,]/g, m => '\\' + m)).test(r.answer + r.resolved_query + r.llm.user));
  }],
  ['under 40k', 'recommendation', r => assert(/under ₹40,000/.test(r.resolved_query))]
]);
// R7: markup-only input carries no shopping signal
conversation('R7 markdown garbage', [['**bold** _x_ `code` [link](javascript:alert(1))', 'clarify', r => assert(!r.needs_llm)]]);
conversation('R7b html + url only', [['<img src=x onerror=alert(1)> https://example.com/laptops', 'clarify']]);
conversation('R7c markup around a real request', [['**laptop** for _gaming_ [see](http://x.y)', 'recommendation', r => assert(allCat(r, ['Laptop']))]]);

// ================================================================== 4c. round 3: LLM guard-rails
conversation('R8 cheaper with nothing cheaper -> deterministic, no LLM', [
  ['laptop for video editing under 70k', 'recommendation'],
  ['anything cheaper?', 'recommendation'],
  ['anything cheaper?', 'recommendation'],
  ['anything cheaper?', 'recommendation'],
  ['anything cheaper?', 'recommendation', r => {
    assert(/already the most affordable match/.test(r.answer), r.answer.slice(0, 80));
    assert.strictEqual(r.needs_llm, false); assert.strictEqual(r.llm, null);
  }]
]);
conversation('R8b relaxed budget -> no LLM', [['gaming laptop under 20k', 'recommendation', r => {
  assert(/Nothing in our catalog matches/.test(r.answer)); assert.strictEqual(r.needs_llm, false);
}]]);
conversation('R8c feature filter emptied -> no LLM', [['speaker with anc', 'not_found', r => assert.strictEqual(r.needs_llm, false)]]);
conversation('R9 must_include macbook vs novabook', [['macbook vs novabook', 'compare', r => {
  assert.strictEqual(r.must_include, "Sorry, we don't carry the **MacBook** — TechMart only stocks its own catalog.");
  assert(r.needs_llm && r.llm.user.includes('Start your reply with: ' + r.must_include));
}]]);
conversation('R9b must_include iphone 15', [['do you have iphone 15', 'not_found', r => {
  assert.strictEqual(r.must_include, "Sorry, we don't carry the **iPhone 15** — TechMart only stocks the products in its own catalog.");
  assert(r.llm.user.includes('Start your reply with: ' + r.must_include));
}]]);
conversation('R9c no must_include for normal answers', [['gaming laptop', 'recommendation', r => {
  assert.strictEqual(r.must_include, null); assert(!/Start your reply with/.test(r.llm.user));
}]]);
conversation('R10 prompt has the numbers rule', [['best phone for camera', 'recommendation', r => {
  assert(r.llm.system.includes('Always state the exact key numbers from FACTS (RAM, price, battery, etc.) that answer the question; never invent prices, price differences or specs; only compare prices that appear in FACTS; if FACTS say a product is already the cheapest, say so and do not suggest another.'));
}]]);
conversation('R11 facts_numbers for product questions', [
  ['Does the NovaBook Air have enough RAM for coding?', 'product_question', r => { assert(r.facts_numbers.includes('₹52,000') && r.facts_numbers.includes('8GB'), JSON.stringify(r.facts_numbers)); }],
  ['how much is the vertex forge', 'product_question', r => assert.deepStrictEqual(r.facts_numbers, ['₹1,59,990'])],
  ['novabok air battery', 'product_question', r => assert(r.facts_numbers.includes('10hr') && r.facts_numbers.includes('₹52,000'), JSON.stringify(r.facts_numbers))],
  ['gaming laptop', 'recommendation', r => assert.deepStrictEqual(r.facts_numbers, [])]
]);

// ================================================================== 5. every suggestion chip leads somewhere useful
const seenChip = new Set();
chipQueue.forEach(([chip, state, from]) => {
  const key = chip + '|' + JSON.stringify(state && state.last_ids) + '|' + (state && state.last_kind);
  if (seenChip.has(key)) return;
  seenChip.add(key);
  messages++;
  let r;
  try { r = E.converse(chip, P, state); } catch (e) { failures.push('THROW on chip ' + chip + ': ' + e.message); return; }
  check('chip "' + chip + '" (after "' + from + '")', () => {
    validate(chip, r);
    assert(!['clarify', 'off_topic'].includes(r.kind), 'chip gave ' + r.kind);
  });
});

// ================================================================== 6. performance (< 5 ms typical)
check('performance: median converse() < 5 ms', () => {
  const s = timings.slice().sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  assert(med < 5, 'median ' + med.toFixed(2) + ' ms');
});

// ================================================================== 7. existing scratch test (if present)
const SCRATCH = 'C:/Users/suraj/AppData/Local/Temp/claude/04b4704f6d0aa0e4/3753d6c1-e070-47e6-94be-c05e4316e881/scratchpad/test_engine.js';
if (fs.existsSync(SCRATCH)) {
  check('legacy scratch test_engine.js passes', () => {
    const out = require('child_process').execFileSync(process.execPath, [SCRATCH], { encoding: 'utf8' });
    assert(/ALL ASSERTIONS PASSED/.test(out));
  });
}

// ------------------------------------------------------------------ report
const s = timings.slice().sort((a, b) => a - b);
console.log('\nconverse() messages: ' + messages + ' | checks passed: ' + checks + ' | failures: ' + failures.length +
  ' | latency median ' + s[Math.floor(s.length / 2)].toFixed(2) + ' ms, p95 ' + s[Math.floor(s.length * 0.95)].toFixed(2) + ' ms');
if (failures.length) {
  console.log('\nFAILURES:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log('ALL CHAT TESTS PASSED');
