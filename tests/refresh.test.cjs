const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [],
      innerHTML: '', textContent: ''
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    window: {}, document: { addEventListener() {}, getElementById: element },
    console, performance, setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync('app.js', 'utf8'), context);
  vm.runInContext(`
    state.airports = [{ icao: 'TEST', notams: { allNotams: ['old'], filteredNotams: [] } }];
    state.groups = [{ id: 'test', name: 'Test', airports: ['TEST'] }];
    state.activeGroup = 'test';
    scheduleMetarExpiry = () => {};
    saveState = () => {};
    renderLastSuccessfulUpdate = () => {};
    showStatus = () => {};
    logInfo = () => {};
    renderCard = airport => JSON.stringify({ metar: airport.metar?.raw, notams: airport.notams?.allNotams, runways: airport.runways });
    refreshNswc = async () => true;
    refreshOwnedAwos = () => new Promise(resolve => { globalThis.finishAwos = resolve; });
    fetchFreshWeatherBatch = async airports => new Map(airports.map(a => [a.icao, { metar: { raw: 'new METAR' }, taf: { raw: 'new TAF' } }]));
    fetchFreshNotams = async () => ({ allNotams: ['new'], filteredNotams: [] });
    fetchOurAirportsRunways = async () => ['new runway'];
    fetchOurAirportsVariation = async () => 5;
  `, context);
  return { context, element };
}

for (const beforeBackgroundFinishes of [true, false]) {
  test(`first refresh displays completed active-tab data ${beforeBackgroundFinishes ? 'while AWOS is pending' : 'after all requests finish'}`, async () => {
    const { context, element } = setup();
    const pending = vm.runInContext('refreshAll()', context);
    await new Promise(resolve => setImmediate(resolve));
    if (!beforeBackgroundFinishes) {
      context.finishAwos(0);
      await pending;
    }
    try {
      const visible = JSON.parse(element('airport-grid').innerHTML);
      assert.equal(visible.metar, 'new METAR');
      assert.deepEqual(visible.notams, ['new']);
      assert.deepEqual(visible.runways, ['new runway']);
    } finally {
      context.finishAwos(0);
      await pending;
    }
    assert.equal(element('refresh-all').disabled, false);
  });
}

test('all active-tab METAR and TAF are displayed before slow NOTAM requests finish', async () => {
  const { context, element } = setup();
  vm.runInContext(`
    state.airports = Array.from({ length: 7 }, (_, i) => ({ icao: 'TES' + i, metar: { raw: 'old METAR' }, taf: { raw: 'old TAF' } }));
    state.groups[0].airports = state.airports.map(a => a.icao);
    renderCard = airport => JSON.stringify({ icao: airport.icao, metar: airport.metar.raw, taf: airport.taf.raw }) + '\\n';
    globalThis.releaseNotams = [];
    fetchFreshNotams = () => new Promise(resolve => releaseNotams.push(() => resolve(null)));
  `, context);
  const pending = vm.runInContext('refreshAll()', context);
  await new Promise(resolve => setImmediate(resolve));
  try {
    const visible = element('airport-grid').innerHTML.trim().split('\n').map(JSON.parse);
    assert.equal(visible.length, 7);
    for (const airport of visible) {
      assert.equal(airport.metar, 'new METAR', airport.icao);
      assert.equal(airport.taf, 'new TAF', airport.icao);
    }
  } finally {
    // Releasing one wave permits the remaining airport to enter the worker pool.
    for (let wave = 0; wave < 2; wave++) {
      context.releaseNotams.splice(0).forEach(resolve => resolve());
      await new Promise(resolve => setImmediate(resolve));
    }
    context.finishAwos(0);
    await pending;
  }
});

test('failed METAR keeps saved weather while a successful TAF updates', async () => {
  const { context } = setup();
  await vm.runInContext(`
    state.airports[0].metar = { raw: 'saved METAR' };
    refreshAirport('TEST', { weatherReports: {
      metar: { error: new Error('offline') }, taf: { raw: 'new TAF' }
    } });
  `, context);
  const result = JSON.parse(vm.runInContext('JSON.stringify(state.airports[0])', context));
  assert.equal(result.metar.raw, 'saved METAR');
  assert.equal(result.metar.refreshError, 'offline');
  assert.equal(result.taf.raw, 'new TAF');
});
