// Exercise the real weather cache, request queue, state update and card markup.
// Only external responses and unrelated chart/NOTAM services are replaced.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const source = process.env.REFRESH_TEST_HEAD
  ? execFileSync('git', ['show', 'HEAD:app.js'], { encoding: 'utf8' })
  : fs.readFileSync('app.js', 'utf8');

function setup({ now = '2026-11-19T12:19:59Z', batch = true } = {}) {
  let clock = Date.parse(now);
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const storage = new Map();
  const nodes = new Map();
  const getElementById = id => {
    if (!nodes.has(id)) nodes.set(id, {
      innerHTML: '', textContent: '', classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, removeAttribute() {}, querySelectorAll: () => []
    });
    return nodes.get(id);
  };
  const requests = [];
  const metar = 'METAR ESSA 191220Z 24012KT 9999 BKN030 05/02 Q1008';
  const taf = 'TAF ESSA 191220Z 1912/2012 24012KT 9999 BKN030';
  const context = vm.createContext({
    window: {}, document: { addEventListener() {}, getElementById },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    Date: Clock, URL, console, performance,
    setTimeout: callback => { queueMicrotask(callback); return 1; }, clearTimeout() {},
    fetch: async value => {
      const url = new URL(value);
      requests.push(url);
      const product = url.searchParams.get('product') || 'metar';
      if (product === 'weather-batch' && !batch) return { status: 404, ok: false, text: async () => '' };
      const body = product === 'weather-batch' ? JSON.stringify({ reports: { ESSA: { metar, taf } } }) : product === 'taf' ? taf : metar;
      return { status: 200, ok: true, text: async () => body };
    }
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    state.airports = [{ icao: 'ESSA',
      metar: { raw: 'METAR ESSA 191200Z 18005KT 9999 SCT040 04/02 Q1007', time: '191200Z' },
      taf: { raw: 'TAF ESSA 190920Z 1909/2009 18005KT 9999 SCT040', time: '190920Z' }
    }];
    state.groups = [{ id: 'test', name: 'Test', airports: ['ESSA'] }];
    state.activeGroup = 'test';
    scheduleMetarExpiry = () => {};
    refreshNswc = async () => true;
    refreshOwnedAwos = async () => 0;
    fetchFreshNotams = async () => null;
    fetchOurAirportsRunways = async () => [];
    fetchOurAirportsVariation = async () => null;
    logInfo = () => {};
    renderCards();
  `, context);
  return {
    context, requests, storage,
    advance: ms => { clock += ms; },
    refresh: () => vm.runInContext('refreshAll()', context),
    text: () => getElementById('airport-grid').innerHTML.replace(/<[^>]*>/g, ''),
    saved: () => JSON.parse(storage.get('aviation-briefing-v2')),
    metar, taf
  };
}

for (const batch of [true, false]) {
  test(`first card displays fetched METAR/TAF on first refresh (${batch ? 'batch' : 'fallback'})`, async () => {
    const app = setup({ now: '2026-11-19T12:21:00Z', batch });
    await app.refresh();
    assert.ok(app.requests.length > 0);
    assert.ok(app.text().includes(app.metar));
    assert.ok(app.text().includes(app.taf));
    assert.equal(app.saved().airports[0].metar.raw, app.metar);
    assert.equal(app.saved().airports[0].taf.raw, app.taf);
  });
}

test('first card displays newer local cached text on first refresh without a request', async () => {
  const app = setup();
  for (const product of ['metar', 'taf']) {
    app.storage.set(`aviation-briefing-weather-ESSA-${product}`, JSON.stringify({ raw: app[product], time: '191220Z' }));
  }
  await app.refresh();
  assert.equal(app.requests.length, 0);
  assert.ok(app.text().includes(app.metar));
  assert.ok(app.text().includes(app.taf));
});

test('two clicks across cache-age thresholds reproduce old text then new text', async () => {
  const app = setup();
  await app.refresh();
  assert.equal(app.requests.length, 0, 'first click reuses cached weather');
  assert.ok(app.text().includes('191200Z'));
  assert.ok(app.text().includes('190920Z'));
  app.advance(2000);
  await app.refresh();
  assert.equal(app.requests.length, 1, 'second click now fetches weather');
  assert.ok(app.text().includes(app.metar));
  assert.ok(app.text().includes(app.taf));
});

test('first card shows fetched text while unrelated AWOS is still pending', async () => {
  const app = setup({ now: '2026-11-19T12:21:00Z' });
  vm.runInContext('refreshOwnedAwos = () => new Promise(resolve => { globalThis.finishAwos = resolve; });', app.context);
  const pending = app.refresh();
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(app.saved().airports[0].metar.raw, app.metar);
    assert.equal(app.saved().airports[0].taf.raw, app.taf);
    assert.ok(app.text().includes(app.metar), 'cached METAR must already be in the rendered card');
    assert.ok(app.text().includes(app.taf), 'cached TAF must already be in the rendered card');
  } finally {
    app.context.finishAwos(0);
    await pending;
  }
});

test('ESNU first in the Umeå preset updates on the first refresh', async () => {
  const app = setup({ now: '2026-11-19T12:21:00Z' });
  const preset = JSON.parse(fs.readFileSync('presets/umea.json', 'utf8'));
  app.context.presetGroup = preset.groups[0];
  app.context.fetch = async value => {
    const url = new URL(value);
    app.requests.push(url);
    const reports = Object.fromEntries(url.searchParams.get('ids').split(',').map(icao => [icao, {
      metar: app.metar.replace('ESSA', icao), taf: app.taf.replace('ESSA', icao)
    }]));
    return { ok: true, status: 200, text: async () => JSON.stringify({ reports }) };
  };
  vm.runInContext(`
    const old = state.airports[0];
    state.groups = [presetGroup];
    state.activeGroup = presetGroup.id;
    state.airports = presetGroup.airports.map(icao => ({
      icao, metar: { ...old.metar, raw: old.metar.raw.replace('ESSA', icao) },
      taf: { ...old.taf, raw: old.taf.raw.replace('ESSA', icao) }
    }));
    ensureBuiltinGroups();
    renderCards();
  `, app.context);
  await app.refresh();
  const text = app.text();
  assert.ok(text.indexOf('ESNU') < text.indexOf('ESNZ'));
  assert.ok(text.includes(app.metar.replace('ESSA', 'ESNU')));
  assert.ok(text.includes(app.taf.replace('ESSA', 'ESNU')));
  assert.equal(app.saved().airports[0].icao, 'ESNU');
  assert.equal(app.saved().airports[0].metar.raw, app.metar.replace('ESSA', 'ESNU'));
});

function setupExpiredHttpCache(batch = true) {
  const app = setup({ now: '2026-11-19T12:21:00Z' });
  let elapsed = 0;
  const fresh = { metar: app.metar.replace('ESSA', 'ESNU'), taf: app.taf.replace('ESSA', 'ESNU') };
  const old = { metar: 'METAR ESNU 191100Z 18005KT 9999 SCT040 04/02 Q1007', taf: 'TAF ESNU 190900Z 1909/2009 18005KT 9999 SCT040' };
  vm.runInContext(`
    state.airports = [{ icao: 'ESNU', metar: { raw: ${JSON.stringify(old.metar)}, time: '191100Z' }, taf: { raw: ${JSON.stringify(old.taf)}, time: '190900Z' } }];
    state.groups[0].airports = ['ESNU'];
    renderCards();
  `, app.context);
  app.context.fetch = async (value, options = {}) => {
    const url = new URL(value);
    app.requests.push(url);
    // A still-fresh HTTP response can contain an expired observation.
    const useCached = elapsed < 60000 && !['no-store', 'reload', 'no-cache'].includes(options.cache);
    const report = useCached ? old : fresh;
    const product = url.searchParams.get('product') || 'metar';
    if (product === 'weather-batch' && !batch) return { ok: false, status: 404, text: async () => '' };
    const body = product === 'weather-batch' ? JSON.stringify({ reports: { ESNU: report } }) : report[product];
    return { ok: true, status: 200, text: async () => body };
  };
  return { app, fresh, old, elapse(ms) { elapsed += ms; app.advance(ms); } };
}

test('ESNU shows fresh weather at startup and after tab switches despite an expired HTTP-cached report', async () => {
  const { app, fresh, elapse } = setupExpiredHttpCache();
  await vm.runInContext('refreshAll({ quiet: true })', app.context);
  assert.ok(app.text().includes(fresh.metar));
  assert.ok(!app.text().includes('[EXPIRED]'));
  vm.runInContext(`
    state.groups.push({ id: 'other', name: 'Other', airports: [] });
    state.activeGroup = 'other'; renderCards();
    state.activeGroup = 'test'; renderCards();
  `, app.context);
  assert.ok(app.text().includes(fresh.metar));
  elapse(61000);
  await app.refresh();
  assert.ok(app.text().includes(fresh.metar));
});

test('single-airport fallback also bypasses the expired ESNU HTTP response at startup', async () => {
  const { app, fresh } = setupExpiredHttpCache(false);
  await vm.runInContext('refreshAll({ quiet: true })', app.context);
  assert.ok(app.text().includes(fresh.metar), 'expired local weather must trigger a network fetch, not reuse an HTTP response');
});
