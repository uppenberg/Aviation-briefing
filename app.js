const STORAGE_KEY = 'aviation-briefing-v2';
const APP_VERSION = window.AVIATION_BRIEFING_VERSION || 'dev';
const WEATHER_WORKER_URL = 'https://metar-proxy.uppenberg1.workers.dev/';
const NSWC_IMAGE_URL = 'https://aro.lfv.se/tor/nswc2aro.gif?814183';
const NSWC_SAVED_URL_KEY = 'aviation-briefing-nswc-image-url';
const RUNWAY_CACHE_PREFIX = 'aviation-briefing-runways-';
const RUNWAY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const METAR_REFRESH_AGE_MS = 20 * 60 * 1000;
const TAF_REFRESH_AGE_MS = 3 * 60 * 60 * 1000;
const NOTAM_REFRESH_AGE_MS = 5 * 60 * 1000;
const OURAIRPORTS_RUNWAYS_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv';
const OURAIRPORTS_NAVAIDS_URL = 'https://davidmegginson.github.io/ourairports-data/navaids.csv';
const OURAIRPORTS_AIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const DEFAULT_NEARBY_RADIUS_NM = 100;
const ALL_SWEDEN_GROUP_ID = 'builtin-all-sweden';
const ALL_FINLAND_GROUP_ID = 'builtin-all-finland';
const ALL_NORWAY_GROUP_ID = 'builtin-all-norway';
const SWEDEN_METAR_ICAOS = `ESCF ESCM ESDF ESGG ESGJ ESGP ESGT ESIA ESIB ESKM ESKN ESKS ESMK ESMQ ESMS ESMT ESMV ESMX ESND ESNG ESNK ESNL ESNN ESNO ESNQ ESNS ESNU ESNV ESNX ESNZ ESOE ESOH ESOK ESOW ESPA ESPE ESSA ESSB ESSD ESSL ESSP ESST ESSU ESSV ESTA ESTL ESUP ESUT`.split(' ').sort();
const FINLAND_AD2_ICAOS = `EFET EFHA EFHK EFIV EFJO EFJY EFKE EFKI EFKK EFKS EFKT EFKU EFLP EFMA EFMI EFOU EFPO EFRO EFSA EFSI EFTP EFTU EFUT EFVA`.split(' ').sort();
const NORWAY_AD2_ICAOS = `ENAL ENAN ENAS ENAT ENBL ENBN ENBO ENBR ENBS ENBV ENCN ENDU ENEG ENEV ENFG ENFL ENGK ENGM ENHD ENHF ENHK ENHV ENKB ENKJ ENKR ENLK ENMH ENML ENMS ENNA ENNM ENNO ENOL ENOV ENRA ENRE ENRM ENRO ENRS ENSB ENSD ENSG ENSH ENSK ENSO ENSR ENSS ENST ENTC ENTO ENVA ENVD ENZV ENRY`.split(' ').sort();
const BUILTIN_GROUPS = [
  { id: ALL_SWEDEN_GROUP_ID, name: 'All Sweden', color: '#31566f', airports: SWEDEN_METAR_ICAOS },
  { id: ALL_FINLAND_GROUP_ID, name: 'All Finland', color: '#385b75', airports: FINLAND_AD2_ICAOS },
  { id: ALL_NORWAY_GROUP_ID, name: 'All Norway', color: '#6f3c46', airports: NORWAY_AD2_ICAOS }
];
const BUILTIN_AIRPORT_ICAOS = new Set(BUILTIN_GROUPS.flatMap(group => group.airports));
let airportCsvPromise = null;
let runwayCsvPromise = null;
let navaidCsvPromise = null;
let notamRequestQueue = Promise.resolve();
let lastNotamRequestAt = 0;
const state = {
  airports: [],
  groups: [],
  tabOrder: [],
  activeGroup: null,
  departureTime: '',
  arrivalTime: '',
  arrivalTimeAuto: false,
  selected: new Set(),
  sidebarOpen: false,
  busy: new Set(),
  expandedWind: new Set(),
  expandedHistory: new Set(),
  historyLoading: new Set(),
  nearbyMode: false,
  nearbyResults: [],
  nearbyLoading: false,
  nearbyRadiusNm: DEFAULT_NEARBY_RADIUS_NM,
  nearbyDestination: '',
  nearbyOrigin: 'Choose origin',
  nearbyHasSearched: false
};

document.addEventListener('DOMContentLoaded', init);

function init() {
  document.getElementById('app-version').textContent = `v${APP_VERSION}`;
  if (window.isSecureContext && 'serviceWorker' in navigator) {
    checkForUpdates({ automatic: true });
  }
  loadState();
  document.getElementById('dep-time').value = state.departureTime;
  document.getElementById('arr-time').value = state.arrivalTime;
  document.getElementById('airport-search').addEventListener('submit', handleSearch);
  document.getElementById('refresh-all').addEventListener('click', () => refreshAll());
  document.getElementById('nearby-taf').addEventListener('click', toggleNearbyView);
  document.getElementById('nearby-destination-form').addEventListener('submit', event => {
    event.preventDefault();
    state.nearbyDestination = document.getElementById('nearby-destination').value.trim().toUpperCase();
    saveState();
    findNearbyTafAirports({ refresh: true, origin: 'destination' });
  });
  document.getElementById('nearby-use-location').addEventListener('click', () => findNearbyTafAirports({ refresh: true, origin: 'gps' }));
  document.getElementById('open-nswc').addEventListener('click', openNswc);
  document.getElementById('close-nswc').addEventListener('click', closeNswc);
  document.getElementById('refresh-nswc').addEventListener('click', refreshNswc);
  document.getElementById('nswc-overlay').addEventListener('click', event => {
    if (event.target.id === 'nswc-overlay') closeNswc();
  });
  document.getElementById('nswc-image').addEventListener('load', rememberNswcImageUrl);
  document.getElementById('nswc-image').addEventListener('error', () => {
    document.getElementById('nswc-status').textContent = 'Could not load chart. Try Refresh.';
  });
  document.getElementById('nearby-destination').addEventListener('input', event => {
    const input = event.currentTarget;
    const pos = input.selectionStart;
    input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    input.setSelectionRange(pos, pos);
  });
  document.getElementById('nearby-destination').addEventListener('click', event => event.currentTarget.select());
  document.getElementById('open-settings').addEventListener('click', openSettings);
  document.getElementById('close-settings').addEventListener('click', closeSettings);
  document.getElementById('cancel-settings').addEventListener('click', closeSettings);
  document.getElementById('settings-overlay').addEventListener('click', event => {
    if (event.target.id === 'settings-overlay') closeSettings();
  });
  document.getElementById('settings-form').addEventListener('submit', saveSettings);
  document.getElementById('preset-list').addEventListener('click', event => {
    const button = event.target.closest('[data-preset-file]');
    if (button) addPreset(button.dataset.presetFile, button.dataset.presetName);
  });
  document.getElementById('check-updates').addEventListener('click', checkForUpdates);
  document.getElementById('reload-for-update').addEventListener('click', () => window.location.reload());
  document.getElementById('install-update').addEventListener('click', () => window.location.reload());
  document.getElementById('dismiss-update').addEventListener('click', () => {
    document.getElementById('app-update-prompt').hidden = true;
  });
  document.getElementById('export-saved-inputs').addEventListener('click', exportSavedInputs);
  document.getElementById('import-saved-inputs').addEventListener('click', () => {
    const input = document.getElementById('import-saved-inputs-file');
    input.value = '';
    input.click();
  });
  document.getElementById('import-saved-inputs-file').addEventListener('change', importSavedInputs);
  document.getElementById('close-notam').addEventListener('click', closeNotamPanel);
  document.getElementById('notam-overlay').addEventListener('click', event => {
    if (event.target.id === 'notam-overlay') closeNotamPanel();
  });
  document.getElementById('nearby-radius').addEventListener('click', event => event.currentTarget.select());
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeSettings();
      closeNotamPanel();
      closeNswc();
    }
  });
  document.getElementById('create-group').addEventListener('click', createGroupFromSelection);
  document.getElementById('open-sidebar').addEventListener('click', () => setSidebar(!state.sidebarOpen));
  document.getElementById('close-sidebar').addEventListener('click', () => setSidebar(false));
  document.getElementById('sidebar-scrim').addEventListener('click', () => setSidebar(false));
  document.getElementById('add-suggested').addEventListener('click', () => addAirport('ESSA'));
  ['dep-time', 'arr-time'].forEach(id => {
    const input = document.getElementById(id);
    input.addEventListener('focus', event => event.currentTarget.select());
    input.addEventListener('click', event => event.currentTarget.select());
  });
  document.getElementById('dep-time').addEventListener('change', event => {
    commitFlightTime(event.currentTarget, 'departureTime');
  });
  document.getElementById('arr-time').addEventListener('change', event => {
    commitFlightTime(event.currentTarget, 'arrivalTime');
  });
  document.getElementById('clear-times').addEventListener('click', () => {
    state.departureTime = '';
    state.arrivalTime = '';
    state.arrivalTimeAuto = false;
    saveState();
    renderCards();
  });
  document.getElementById('airport-input').addEventListener('input', event => {
    const input = event.currentTarget;
    const pos = input.selectionStart;
    input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    input.setSelectionRange(pos, pos);
  });
  render();
  if (state.airports.length) refreshAll({ quiet: true });
}

function getSavedNswcImageUrl() {
  try {
    const saved = localStorage.getItem(NSWC_SAVED_URL_KEY);
    const url = saved ? new URL(saved) : null;
    return url?.origin === 'https://aro.lfv.se' && url.pathname === '/tor/nswc2aro.gif' ? url.href : NSWC_IMAGE_URL;
  } catch {
    return NSWC_IMAGE_URL;
  }
}

async function openNswc() {
  const overlay = document.getElementById('nswc-overlay');
  const image = document.getElementById('nswc-image');
  const savedUrl = getSavedNswcImageUrl();
  document.getElementById('nswc-status').textContent = savedUrl === NSWC_IMAGE_URL ? 'Loading latest chart…' : 'Loading saved chart…';
  overlay.hidden = false;
  if (window.isSecureContext && 'serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await Promise.race([
          new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })),
          new Promise(resolve => setTimeout(resolve, 2000))
        ]);
      }
    } catch { /* Online display remains available if service worker setup fails. */ }
  }
  if (image.src === savedUrl && image.complete && image.naturalWidth > 0) {
    document.getElementById('nswc-status').textContent = navigator.serviceWorker?.controller
      ? 'Showing locally saved chart.'
      : 'Chart loaded.';
  } else {
    image.src = savedUrl;
  }
}

function closeNswc() {
  document.getElementById('nswc-overlay').hidden = true;
}

function rememberNswcImageUrl() {
  const image = document.getElementById('nswc-image');
  if (!image.currentSrc) return;
  try { localStorage.setItem(NSWC_SAVED_URL_KEY, image.currentSrc); } catch { /* Keep the image visible when storage is unavailable. */ }
  document.getElementById('nswc-status').textContent = navigator.serviceWorker?.controller
    ? 'Chart saved locally for offline viewing.'
    : 'Chart loaded. Offline saving requires the installed app.';
}

function refreshNswc() {
  const status = document.getElementById('nswc-status');
  const url = new URL(NSWC_IMAGE_URL);
  url.searchParams.set('refresh', String(Date.now()));
  status.textContent = 'Refreshing chart…';
  const latest = new Image();
  latest.referrerPolicy = 'no-referrer';
  latest.onload = () => {
    const image = document.getElementById('nswc-image');
    image.src = latest.src;
    try { localStorage.setItem(NSWC_SAVED_URL_KEY, latest.src); } catch { /* Cache API still keeps the fetched image when available. */ }
    status.textContent = navigator.serviceWorker?.controller
      ? `Updated ${new Date().toISOString().slice(11, 16)}Z · saved locally`
      : `Updated ${new Date().toISOString().slice(11, 16)}Z`;
  };
  latest.onerror = () => { status.textContent = 'Refresh failed; showing the previously saved chart if available.'; };
  latest.src = url.href;
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    state.airports = Array.isArray(saved.airports) ? saved.airports
      .filter(item => item && /^[A-Z]{4}$/.test(item.icao))
      .map(item => ({
        icao: item.icao,
        ...(item.builtinOnly === true || item.swedenBuiltinOnly === true ? { builtinOnly: true } : {}),
        ...(isCachedReport(item.metar) ? { metar: restoreCachedReport(item.metar) } : {}),
        ...(isCachedReport(item.taf) ? { taf: restoreCachedReport(item.taf) } : {}),
        ...(isCachedNotams(item.notams) ? { notams: item.notams } : {})
      })) : [];
    state.groups = Array.isArray(saved.groups) ? saved.groups.filter(group => group && typeof group.id === 'string' && typeof group.name === 'string') : [];
    state.tabOrder = Array.isArray(saved.tabOrder) ? saved.tabOrder.filter(id => typeof id === 'string') : [];
    state.groups.forEach(group => { group.airports = Array.isArray(group.airports) ? [...new Set(group.airports.filter(icao => state.airports.some(item => item.icao === icao)))] : []; });
    ensureBuiltinGroups();
    ensureAirportGroupMembership();
    const defaultGroupId = ensureDefaultGeneralGroup();
    state.activeGroup = saved.activeGroup || defaultGroupId;
    state.departureTime = typeof saved.departureTime === 'string' ? saved.departureTime : '';
    state.arrivalTime = typeof saved.arrivalTime === 'string' ? saved.arrivalTime : '';
    state.arrivalTimeAuto = saved.arrivalTimeAuto === true && Boolean(state.arrivalTime);
    state.nearbyRadiusNm = Number.isFinite(saved.nearbyRadiusNm) && saved.nearbyRadiusNm >= 1 && saved.nearbyRadiusNm <= 1000
      ? saved.nearbyRadiusNm : DEFAULT_NEARBY_RADIUS_NM;
    state.nearbyDestination = typeof saved.nearbyDestination === 'string' && /^[A-Z]{4}$/.test(saved.nearbyDestination) ? saved.nearbyDestination : '';
    if (!state.groups.some(group => group.id === state.activeGroup)) state.activeGroup = defaultGroupId;
    saveState();
  } catch (error) {
    console.warn('Could not load saved briefing:', error);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
    airports: state.airports.map(({ icao, builtinOnly, metar, taf, notams }) => ({
      icao,
      ...(builtinOnly ? { builtinOnly: true } : {}),
      ...(isCachedReport(metar) ? { metar: serializeCachedReport(metar) } : {}),
      ...(isCachedReport(taf) ? { taf: serializeCachedReport(taf) } : {}),
      ...(isCachedNotams(notams) ? { notams } : {})
    })),
    groups: state.groups,
    tabOrder: getSidebarTabIds(),
    activeGroup: state.activeGroup,
    departureTime: state.departureTime,
    arrivalTime: state.arrivalTime,
    arrivalTimeAuto: state.arrivalTimeAuto,
    nearbyRadiusNm: state.nearbyRadiusNm,
    nearbyDestination: state.nearbyDestination
    }));
  } catch (error) {
    console.warn('Could not save the briefing weather cache:', error);
  }
  document.getElementById('dep-time').value = state.departureTime;
  document.getElementById('arr-time').value = state.arrivalTime;
  document.getElementById('nearby-destination').value = state.nearbyDestination;
}

function isCachedReport(report) {
  return report && typeof report.raw === 'string' && report.raw.trim().length > 0;
}

function isCachedNotams(notams) {
  return notams && Array.isArray(notams.allNotams) && Array.isArray(notams.filteredNotams);
}

function ensureAirportGroupMembership() {
  const userAirports = state.airports.filter(airport => !airport.builtinOnly);
  let userGroups = state.groups.filter(group => !isBuiltinGroup(group.id));
  if (userAirports.length && !userGroups.length) {
    const general = { id: createGroupId(), name: 'General', airports: [] };
    state.groups.push(general);
    userGroups = [general];
  }
  for (const airport of userAirports) {
    if (!userGroups.some(group => group.airports.includes(airport.icao))) userGroups[0]?.airports.push(airport.icao);
  }
}

function ensureDefaultGeneralGroup() {
  let general = state.groups.find(group => !isBuiltinGroup(group.id) && group.name.trim().toLowerCase() === 'general');
  if (!general) {
    general = { id: createGroupId(), name: 'General', airports: [] };
    state.groups.push(general);
  }
  return general.id;
}

function isBuiltinGroup(groupId) {
  return BUILTIN_GROUPS.some(group => group.id === groupId);
}

function builtinFlagClass(groupId) {
  if (groupId === ALL_SWEDEN_GROUP_ID) return 'flag-sweden';
  if (groupId === ALL_FINLAND_GROUP_ID) return 'flag-finland';
  if (groupId === ALL_NORWAY_GROUP_ID) return 'flag-norway';
  return '';
}

function ensureBuiltinGroups() {
  for (const definition of BUILTIN_GROUPS) {
    let group = state.groups.find(item => item.id === definition.id);
    if (!group) {
      group = { id: definition.id, name: definition.name, color: definition.color, airports: [] };
      state.groups.push(group);
    }
    group.name = definition.name;
    group.color = definition.color;
    group.airports = [...definition.airports];
    for (const icao of definition.airports) {
      let airport = state.airports.find(item => item.icao === icao);
      if (!airport) {
        airport = { icao, builtinOnly: true };
        state.airports.push(airport);
      } else if (state.groups.some(item => !isBuiltinGroup(item.id) && item.airports.includes(icao))) {
        airport.builtinOnly = false;
      }
    }
  }
}

function createGroupId() {
  let id;
  do { id = `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }
  while (state.groups.some(group => group.id === id));
  return id;
}

function restoreCachedReport(report) {
  return {
    raw: report.raw,
    time: typeof report.time === 'string' ? report.time : '',
    ...(Number.isFinite(report.retrievedAt) ? { retrievedAt: report.retrievedAt } : {})
  };
}

function serializeCachedReport(report) {
  return {
    raw: report.raw,
    time: report.time || '',
    ...(Number.isFinite(report.retrievedAt) ? { retrievedAt: report.retrievedAt } : {})
  };
}

function openSettings() {
  const overlay = document.getElementById('settings-overlay');
  const input = document.getElementById('nearby-radius');
  input.value = String(state.nearbyRadiusNm);
  overlay.hidden = false;
  loadPresets();
}

function closeSettings() {
  document.getElementById('settings-overlay').hidden = true;
}

async function loadPresets() {
  const list = document.getElementById('preset-list');
  const status = document.getElementById('preset-status');
  list.innerHTML = '<span class="settings-help">Loading presets…</span>';
  status.textContent = '';
  try {
    const response = await fetch('./presets/index.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalog = await response.json();
    const presets = Array.isArray(catalog.presets) ? catalog.presets.filter(preset =>
      preset && typeof preset.name === 'string' && typeof preset.file === 'string' && /^[A-Za-z0-9_-]+\.json$/.test(preset.file)
    ) : [];
    list.innerHTML = presets.length
      ? presets.map(preset => `<button class="button preset-button" type="button" data-preset-file="${escapeHtml(preset.file)}" data-preset-name="${escapeHtml(preset.name)}">＋ ${escapeHtml(preset.name)}</button>`).join('')
      : '<span class="settings-help">No presets added yet. Add JSON files under presets and list them in presets/index.json.</span>';
  } catch (error) {
    list.innerHTML = '<span class="settings-help">Presets could not be loaded. Open the app through HTTPS or localhost.</span>';
    status.textContent = error.message;
  }
}

async function addPreset(file, name) {
  const status = document.getElementById('preset-status');
  try {
    const response = await fetch(`./presets/${encodeURIComponent(file)}`);
    if (!response.ok) throw new Error(`Could not load ${name} (HTTP ${response.status}).`);
    const preset = await response.json();
    if (preset?.format !== 'aviation-briefing-saved-inputs' || preset.version !== 1 || !Array.isArray(preset.airports) || !Array.isArray(preset.groups)) {
      throw new Error(`${name} is not a supported saved-inputs JSON file.`);
    }
    if (!window.confirm(`Add missing airports and merge groups from “${name}”? Existing airports and groups will be kept.`)) return;
    const airportCodes = new Set(preset.airports.map(code => String(code).trim().toUpperCase()).filter(code => /^[A-Z]{4}$/.test(code)));
    preset.groups.forEach(group => {
      if (Array.isArray(group?.airports)) group.airports.forEach(code => {
        const icao = String(code).trim().toUpperCase();
        if (/^[A-Z]{4}$/.test(icao)) airportCodes.add(icao);
      });
    });
    const existingCodes = new Set(state.airports.map(airport => airport.icao));
    const addedCodes = [...airportCodes].filter(icao => !existingCodes.has(icao));
    addedCodes.forEach(icao => state.airports.push({ icao }));
    for (const sourceGroup of preset.groups) {
      if (!sourceGroup || typeof sourceGroup.name !== 'string' || !sourceGroup.name.trim()) continue;
      const groupName = sourceGroup.name.trim().slice(0, 48);
      // Reuse the exported group when IDs match; across installations the ID may
      // differ, so fall back to the group name. Preset metadata should be applied
      // in either case so its tab label and color survive adding/merging it.
      let targetGroup = (typeof sourceGroup.id === 'string'
        ? state.groups.find(group => group.id === sourceGroup.id)
        : null) || state.groups.find(group => group.name.trim().toLowerCase() === groupName.toLowerCase());
      if (!targetGroup) {
        targetGroup = {
          id: createGroupId(),
          name: groupName,
          color: typeof sourceGroup.color === 'string' && /^#[0-9a-f]{6}$/i.test(sourceGroup.color) ? sourceGroup.color : '#203735',
          airports: []
        };
        state.groups.push(targetGroup);
      } else {
        targetGroup.name = groupName;
        if (typeof sourceGroup.color === 'string' && /^#[0-9a-f]{6}$/i.test(sourceGroup.color)) {
          targetGroup.color = sourceGroup.color;
        }
      }
      const members = Array.isArray(sourceGroup.airports) ? sourceGroup.airports : [];
      members.forEach(code => {
        const icao = String(code).trim().toUpperCase();
        if (airportCodes.has(icao) && !targetGroup.airports.includes(icao)) targetGroup.airports.push(icao);
      });
    }
    ensureAirportGroupMembership();
    saveState();
    render();
    closeSettings();
    if (addedCodes.length) Promise.all(addedCodes.map(icao => refreshAirport(icao, { renderStart: false, renderFinish: false }))).then(() => renderCards());
    showStatus(`Added ${addedCodes.length} airport${addedCodes.length === 1 ? '' : 's'} from ${name}; existing cards and groups were kept.`);
  } catch (error) {
    status.textContent = error.message || `Could not add ${name}.`;
  }
}

async function checkForUpdates({ automatic = false } = {}) {
  const button = document.getElementById('check-updates');
  const status = document.getElementById('update-status');
  const reloadButton = document.getElementById('reload-for-update');
  reloadButton.hidden = true;
  if (!window.isSecureContext || !('serviceWorker' in navigator)) {
    if (!automatic) status.textContent = 'Update checks require the app to be open from its secure website or installed PWA.';
    return;
  }
  if (!automatic) {
    button.disabled = true;
    status.textContent = 'Checking for updates…';
  }
  try {
    const hadController = Boolean(navigator.serviceWorker.controller);
    const registration = await navigator.serviceWorker.getRegistration() || await navigator.serviceWorker.register('./sw.js');
    const activeBefore = registration.active;
    let updateFound = Boolean(registration.waiting);
    let installingWorker = registration.installing;
    registration.addEventListener('updatefound', () => {
      updateFound = true;
      installingWorker = registration.installing;
    }, { once: true });
    await registration.update();
    installingWorker ||= registration.installing;
    if (installingWorker && installingWorker !== activeBefore && !registration.waiting) {
      await Promise.race([
        new Promise(resolve => {
          if (['activated', 'redundant'].includes(installingWorker.state)) return resolve();
          installingWorker.addEventListener('statechange', () => {
            if (['activated', 'redundant'].includes(installingWorker.state)) resolve();
          });
        }),
        new Promise(resolve => setTimeout(resolve, 15000))
      ]);
    }
    const updatedWorkerActive = Boolean(hadController && updateFound && registration.active && registration.active !== activeBefore);
    if (hadController && (registration.waiting || updatedWorkerActive)) {
      status.textContent = `A new version is ready. Current version: v${APP_VERSION}.`;
      reloadButton.hidden = false;
      document.getElementById('app-update-prompt').hidden = false;
    } else {
      if (!automatic) status.textContent = `You are using the latest available version (v${APP_VERSION}).`;
    }
  } catch (error) {
    if (!automatic) status.textContent = 'Could not check for updates. Check your internet connection and try again.';
    console.warn('Could not check for app updates:', error);
  } finally {
    if (!automatic) button.disabled = false;
  }
}

function saveSettings(event) {
  event.preventDefault();
  const input = document.getElementById('nearby-radius');
  const radius = Number(input.value);
  if (!Number.isFinite(radius) || radius < 1 || radius > 1000) {
    input.setCustomValidity('Enter a distance from 1 to 1,000 NM.');
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  const shouldRefreshNearby = state.nearbyMode && state.nearbyHasSearched && radius !== state.nearbyRadiusNm;
  state.nearbyRadiusNm = radius;
  saveState();
  closeSettings();
  if (shouldRefreshNearby) {
    findNearbyTafAirports({ refresh: true, origin: state.nearbyOrigin === 'GPS' ? 'gps' : 'destination' });
  } else {
    renderCards();
  }
}

function exportSavedInputs() {
  const exported = {
    format: 'aviation-briefing-saved-inputs',
    version: 1,
    exportedAt: new Date().toISOString(),
    airports: state.airports.filter(airport => !airport.builtinOnly).map(airport => airport.icao),
    groups: state.groups.filter(group => !isBuiltinGroup(group.id)).map(group => ({ id: group.id, name: group.name, color: group.color || '#203735', airports: [...group.airports] })),
    tabOrder: getSidebarTabIds(),
    activeGroup: isBuiltinGroup(state.activeGroup) ? null : state.activeGroup,
    nearby: {
      radiusNm: state.nearbyRadiusNm,
      destinationIcao: state.nearbyDestination
    }
  };
  const blob = new Blob([`${JSON.stringify(exported, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `aviation-briefing-inputs-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importSavedInputs(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  if (!window.confirm('Importing this backup will replace your saved airports, groups, and Nearby settings. DEP and ARR times will stay as currently saved on this device. Continue?')) {
    input.value = '';
    return;
  }
  try {
    const backup = JSON.parse(await file.text());
    if (backup?.format !== 'aviation-briefing-saved-inputs' || backup.version !== 1 || !Array.isArray(backup.airports) || !Array.isArray(backup.groups)) {
      throw new Error('This file is not a supported Aviation Briefing backup.');
    }
    const airportCodes = [...new Set(backup.airports.map(code => String(code).trim().toUpperCase()).filter(code => /^[A-Z]{4}$/.test(code)))];
    const airportSet = new Set(airportCodes);
    const groupIds = new Set();
    const groups = backup.groups.filter(group => group && typeof group.name === 'string').map((group, index) => {
      let id = typeof group.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(group.id) ? group.id : `imported-${Date.now()}-${index}`;
      if (groupIds.has(id)) id = `imported-${Date.now()}-${index}`;
      groupIds.add(id);
      const airports = Array.isArray(group.airports)
        ? [...new Set(group.airports.map(code => String(code).trim().toUpperCase()).filter(code => airportSet.has(code)))]
        : [];
      const color = typeof group.color === 'string' && /^#[0-9a-f]{6}$/i.test(group.color) ? group.color : '#203735';
      return { id, name: group.name.trim().slice(0, 48), color, airports };
    }).filter(group => group.name);
    const radius = backup.nearby?.radiusNm;
    if (radius !== undefined && (!Number.isFinite(radius) || radius < 1 || radius > 1000)) throw new Error('The Nearby radius in this backup is invalid.');
    const destination = typeof backup.nearby?.destinationIcao === 'string'
      ? backup.nearby.destinationIcao.trim().toUpperCase()
      : '';

    state.airports = airportCodes.map(icao => ({ icao }));
    state.groups = groups;
    ensureBuiltinGroups();
    ensureAirportGroupMembership();
    const defaultGroupId = ensureDefaultGeneralGroup();
    state.tabOrder = Array.isArray(backup.tabOrder) ? backup.tabOrder.filter(id => typeof id === 'string') : [];
    state.activeGroup = state.groups.some(group => group.id === backup.activeGroup) ? backup.activeGroup : defaultGroupId;
    state.nearbyRadiusNm = radius ?? DEFAULT_NEARBY_RADIUS_NM;
    state.nearbyDestination = /^[A-Z]{4}$/.test(destination) ? destination : '';
    state.nearbyMode = false;
    state.nearbyResults = [];
    state.nearbyHasSearched = false;
    state.selected.clear();
    state.expandedWind.clear();
    saveState();
    render();
    closeSettings();
    const userAirports = state.airports.filter(airport => !airport.builtinOnly);
    if (userAirports.length) refreshAirportBatch(userAirports, { quiet: true });
    showStatus('Saved inputs imported.');
  } catch (error) {
    showStatus(error?.message || 'Could not import saved inputs.', true);
  } finally {
    input.value = '';
  }
}

function commitFlightTime(input, stateKey) {
  const normalized = normalizeFlightTime(input.value);
  if (normalized === null) {
    input.value = state[stateKey];
    showStatus('Enter a time as HH or HH:MM, for example 20 or 20:30.', true);
    return;
  }
  input.value = normalized;
  state[stateKey] = normalized;
  if (stateKey === 'departureTime') {
    if (normalized && (!state.arrivalTime || state.arrivalTimeAuto)) {
      state.arrivalTime = addFlightHours(normalized, 3);
      state.arrivalTimeAuto = true;
    } else if (!normalized && state.arrivalTimeAuto) {
      state.arrivalTime = '';
      state.arrivalTimeAuto = false;
    }
  } else {
    state.arrivalTimeAuto = false;
  }
  saveState();
  renderCards();
}

function addFlightHours(time, hours) {
  const [hour, minute] = time.split(':').map(Number);
  const totalMinutes = (hour * 60 + minute + hours * 60) % (24 * 60);
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
}

function normalizeFlightTime(value) {
  const text = value.trim();
  if (!text) return '';
  let hours;
  let minutes;
  if (/^\d{1,2}$/.test(text)) {
    hours = Number(text);
    minutes = 0;
  } else if (/^\d{3,4}$/.test(text)) {
    hours = Number(text.slice(0, -2));
    minutes = Number(text.slice(-2));
  } else if (/^\d{1,2}:\d{0,2}$/.test(text)) {
    const [hourText, minuteText] = text.split(':');
    hours = Number(hourText);
    minutes = minuteText ? Number(minuteText) : 0;
  } else {
    return null;
  }
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function formatWeatherMarkup(raw, product = 'metar', airport = null) {
  let html = escapeHtml(raw);
  html = html.replace(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/g, (match, direction, speed, gust) =>
    formatCrosswindWind(match, direction, speed, gust || speed, airport));
  const visibilityColor = value => product === 'metar'
    ? value < 400 ? '#ff55dc' : value <= 549 ? '#ff6969' : value <= 800 ? '#ffae5c' : value <= 1400 ? '#e6ca62' : '#70dfa3'
    : value < 550 ? '#ff55dc' : value < 1400 ? '#ff6969' : value < 2300 ? '#ffae5c' : '#70dfa3';
  html = html.replace(/R\d{2}[LCR]?\/[PM]?(\d{3,4})/g, (match, value) => `<span style="color:${visibilityColor(Number(value))};font-weight:700">${match}</span>`);
  html = html.replace(/\b(OVC|BKN)(\d{3})(CB)?\b/g, (match, type, value, convective = '') => {
    const hundredsOfFeet = Number(value);
    const color = product === 'metar'
      ? hundredsOfFeet < 2 ? '#ff6969'
        : hundredsOfFeet === 2 ? null
          : hundredsOfFeet <= 4 ? '#ffae5c'
            : hundredsOfFeet <= 30 ? '#e6ca62' : '#70dfa3'
      : hundredsOfFeet < 2 ? null
        : hundredsOfFeet <= 3 ? '#ff6969'
        : hundredsOfFeet <= 8 ? '#ffae5c'
          : hundredsOfFeet < 24 ? '#e6ca62' : '#70dfa3';
    const cloudLayer = color
      ? `<span style="color:${color};font-weight:700">${type}${value}</span>`
      : `${type}${value}`;
    const convectiveMarker = convective ? `<span style="color:#ffae5c;font-weight:700">${convective}</span>` : '';
    return color || convective ? `${cloudLayer}${convectiveMarker}` : match;
  });
  html = html.replace(/(^|\s)(\d{4})(?=\s|$)/g, (match, prefix, digits) => `<span style="color:${visibilityColor(Number(digits))};font-weight:700">${prefix}${digits}</span>`);
  const wordColors = { TCU: '#ffae5c', TS: '#e879e4', FG: '#ffae5c', CAVOK: '#70dfa3' };
  html = html.replace(/\b(TCU|CAVOK|TS|FG)\b/g, word => `<span style="color:${wordColors[word]};font-weight:700">${word}</span>`);
  return html;
}

function formatTafForFlightWindow(raw, airport) {
  const info = getPossibleAlternateWindow();
  const slices = getTafWindowSlices(raw, info);
  if (!slices.length) return formatWeatherMarkup(raw, 'taf', airport);
  const ranges = slices.filter(slice => slice.highlight).map(slice => ({ start: slice.start, end: slice.end }));
  if (ranges.length) {
    const firstSelected = Math.min(...ranges.map(range => range.start));
    for (const component of ['wind', 'visibility', 'cloud', 'weather']) {
      const presentInSelectedGroups = ranges.some(range => getTafComponentRanges(raw.slice(range.start, range.end), component).length);
      if (presentInSelectedGroups) continue;
      const inheritedComponent = findInheritedTafComponent(raw, slices, firstSelected, component);
      if (inheritedComponent) ranges.push({ ...inheritedComponent, inheritedComponent: component });
    }
  }
  const baseWind = extractWindForWindow(raw, info).find(wind => wind.source === 'BASE');
  if (baseWind) {
    const marker = /(?:^|\s)(?:FM\d{6}|BECMG\s+\d{4}\/\d{4}|TEMPO\s+\d{4}\/\d{4}|PROB\d{2}(?:\s+TEMPO)?\s+\d{4}\/\d{4})/;
    const baseEnd = raw.match(marker)?.index ?? raw.length;
    const baseText = raw.slice(0, baseEnd);
    const windMatch = /(?:^|\s)(?:\d{3}|VRB)\d{2,3}(?:G\d{2,3})?KT(?=\s|$)/.exec(baseText);
    if (windMatch) {
      const start = windMatch.index + (/^\s/.test(windMatch[0]) ? 1 : 0);
      const end = start + windMatch[0].trim().length;
      const alreadyHighlighted = ranges.some(range => start >= range.start && end <= range.end);
      if (!alreadyHighlighted) ranges.push({ start, end });
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  let html = '';
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    html += formatWeatherMarkup(raw.slice(cursor, range.start), 'taf', airport);
    const title = range.inheritedComponent
      ? `${range.inheritedComponent[0].toUpperCase()}${range.inheritedComponent.slice(1)} carried forward from the preceding prevailing TAF group`
      : 'TAF period or wind group applicable during the selected assessment window';
    html += `<mark class="taf-flight-window" title="${title}">${formatWeatherMarkup(raw.slice(range.start, range.end), 'taf', airport)}</mark>`;
    cursor = range.end;
  }
  html += formatWeatherMarkup(raw.slice(cursor), 'taf', airport);
  return html;
}

function getTafVisibilityRanges(text) {
  return [...text.matchAll(/(?<!\/)\b\d{4}\b(?!\/)|\bCAVOK\b/g)]
    .map(match => ({ start: match.index, end: match.index + match[0].length }));
}

function getTafComponentRanges(text, component) {
  const patterns = {
    wind: /\b(?:\d{3}|VRB)\d{2,3}(?:G\d{2,3})?KT\b/g,
    visibility: /(?<!\/)\b\d{4}\b(?!\/)|\bCAVOK\b/g,
    cloud: /\b(?:FEW|SCT|BKN|OVC)\d{3}(?:CB|TCU)?\b|\b(?:SKC|NSC|NCD|VV\d{3})\b|\bCAVOK\b/g,
    weather: /\b(?:[+-])?(?:(?:MI|PR|BC|DR|BL|SH|TS|FZ)?(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)|TS|CB|TCU)\b|\bCAVOK\b/g
  };
  return [...text.matchAll(patterns[component])]
    .map(match => ({ start: match.index, end: match.index + match[0].length }));
}

function findInheritedTafComponent(raw, slices, beforeIndex, component) {
  const priorPrevailingSlices = slices
    .filter(slice => slice.end <= beforeIndex && ['BASE', 'FM', 'BECMG'].includes(slice.kind))
    .sort((a, b) => b.end - a.end);
  for (const slice of priorPrevailingSlices) {
    const componentRanges = getTafComponentRanges(raw.slice(slice.start, slice.end), component);
    if (componentRanges.length) {
      const last = componentRanges[componentRanges.length - 1];
      return { start: slice.start + last.start, end: slice.start + last.end };
    }
  }
  return null;
}

function formatCrosswindWind(windText, direction, speed, gust, airport) {
  const crosswind = getMaximumCrosswindComponent(direction, Number(speed), Number(gust), airport);
  if (crosswind === null) return windText;
  const color = crosswind > 25 ? '#ff6969' : crosswind >= 20 ? '#ffae5c' : crosswind >= 14 ? '#e6ca62' : '#70dfa3';
  return `<span style="color:${color};font-weight:700" title="Maximum runway crosswind component including gusts: ${crosswind} kt">${windText}</span>`;
}

function getMaximumCrosswindComponent(direction, speed, gust, airport) {
  const windDirection = direction === 'VRB' ? null : Number(direction);
  const maxWind = Math.max(speed || 0, gust || 0);
  const runways = (airport?.runways || []).filter(runway => runway.headingDegT !== null && runway.headingDegT !== undefined && Number.isFinite(Number(runway.headingDegT)));
  if (!runways.length) return null;
  if (windDirection === null) return maxWind;
  return Math.max(...runways.map(runway => {
    const heading = Number(runway.headingDegT);
    const angle = ((windDirection - heading + 540) % 360) - 180;
    return Math.abs(Math.round(maxWind * Math.sin(angle * Math.PI / 180)));
  }));
}

function showStatus(message, isError = false) {
  const status = document.getElementById('status-message');
  status.textContent = message;
  status.classList.toggle('error', isError);
  status.classList.add('visible');
  clearTimeout(showStatus.timeout);
  showStatus.timeout = setTimeout(() => status.classList.remove('visible'), 4500);
}

function handleSearch(event) {
  event.preventDefault();
  const input = document.getElementById('airport-input');
  const icao = input.value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(icao)) {
    showStatus('Enter a valid four-letter ICAO code.', true);
    input.focus();
    return;
  }
  const activeGroup = state.groups.find(group => group.id === state.activeGroup);
  if (!state.nearbyMode && activeGroup?.airports.includes(icao)) {
    input.value = '';
    scrollToAirportCard(icao);
    showStatus(`${icao} is already in ${activeGroup.name}.`);
    return;
  }
  const added = addAirport(icao);
  if (added) input.value = '';
}

function scrollToAirportCard(icao) {
  requestAnimationFrame(() => {
    const card = [...document.querySelectorAll('[data-airport]')].find(element => element.dataset.airport === icao);
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function isAirportInUserBriefing(icao) {
  return state.airports.some(item => item.icao === icao && !item.builtinOnly);
}

function addAirport(icao) {
  const existingAirport = state.airports.find(item => item.icao === icao);
  if (existingAirport) {
    const activeGroup = state.groups.find(group => group.id === state.activeGroup);
    if (activeGroup && !activeGroup.airports.includes(icao)) {
      if (!isBuiltinGroup(activeGroup.id)) existingAirport.builtinOnly = false;
      activeGroup.airports.push(icao);
      saveState();
      render();
      showStatus(`${icao} added to ${activeGroup.name}.`);
      return true;
    }
    if (existingAirport.builtinOnly && (!activeGroup || isBuiltinGroup(activeGroup.id))) {
      existingAirport.builtinOnly = false;
      ensureAirportGroupMembership();
      saveState();
      render();
      showStatus(`${icao} added to your briefing.`);
      return true;
    }
    showStatus(activeGroup
      ? `${icao} is already in ${activeGroup.name}.`
      : `${icao} is already in your briefing.`);
    return false;
  }
  state.airports.push({ icao });
  ensureAirportGroupMembership();
  const activeGroup = state.groups.find(group => group.id === state.activeGroup);
  if (activeGroup && !isBuiltinGroup(activeGroup.id) && !activeGroup.airports.includes(icao)) activeGroup.airports.push(icao);
  saveState();
  render();
  showStatus(`${icao} added.`);
  refreshAirport(icao);
  return true;
}

function removeAirport(icao) {
  if (BUILTIN_AIRPORT_ICAOS.has(icao)) {
    const airport = state.airports.find(item => item.icao === icao);
    if (airport) airport.builtinOnly = true;
    state.groups.forEach(group => { if (!isBuiltinGroup(group.id)) group.airports = group.airports.filter(code => code !== icao); });
    state.selected.delete(icao);
    ensureAirportGroupMembership();
    saveState();
    render();
    return;
  }
  state.airports = state.airports.filter(item => item.icao !== icao);
  state.groups.forEach(group => { group.airports = group.airports.filter(code => code !== icao); });
  state.selected.delete(icao);
  saveState();
  render();
}

function airportsInActiveGroup() {
  if (!state.activeGroup) return state.airports.filter(item => !item.builtinOnly);
  const group = state.groups.find(item => item.id === state.activeGroup);
  if (group && isBuiltinGroup(group.id)) {
    const airportByCode = new Map(state.airports.map(airport => [airport.icao, airport]));
    return group.airports.map(icao => airportByCode.get(icao)).filter(Boolean);
  }
  return group ? state.airports.filter(item => group.airports.includes(item.icao)) : state.airports;
}

function render() {
  renderSidebar();
  renderCards();
  document.getElementById('group-count').textContent = String(state.groups.length);
  document.getElementById('selection-count').textContent = `${state.selected.size} cards selected`;
}

function renderSidebar() {
  const list = document.getElementById('group-list');
  const groups = state.groups.map(group => `<div class="group-item ${state.activeGroup === group.id ? 'active' : ''} ${isBuiltinGroup(group.id) ? `builtin-group ${builtinFlagClass(group.id)}` : ''}" data-group-row="${escapeHtml(group.id)}" data-reorder-group="${escapeHtml(group.id)}" style="--group-color:${/^#[0-9a-f]{6}$/i.test(group.color || '') ? group.color : '#203735'}">
      <span class="group-drag-handle" title="Drag to reorder tabs" aria-label="Drag ${escapeHtml(group.name)} to reorder">⠿</span>
      <button class="group-item-name" role="tab" aria-controls="airport-grid" aria-selected="${state.activeGroup === group.id}" data-group="${escapeHtml(group.id)}" title="Show group">${escapeHtml(group.name)}</button>
      <span class="group-item-count" data-group-count="${escapeHtml(group.id)}">${group.airports.length}</span>
      ${isBuiltinGroup(group.id) ? '' : `<input class="group-color" type="color" value="${/^#[0-9a-f]{6}$/i.test(group.color || '') ? group.color : '#203735'}" data-group-color="${escapeHtml(group.id)}" aria-label="Choose color for ${escapeHtml(group.name)}" title="Choose group color">
      <button class="icon-button group-rename" data-rename-group="${escapeHtml(group.id)}" aria-label="Rename group ${escapeHtml(group.name)}" title="Rename group">✎</button>
      <button class="icon-button group-delete" data-delete-group="${escapeHtml(group.id)}" aria-label="Delete group ${escapeHtml(group.name)}" title="Delete group">×</button>`}
    </div>`);
  const tabMap = new Map(state.groups.map((group, index) => [group.id, groups[index]]));
  list.innerHTML = getSidebarTabIds().map(id => tabMap.get(id)).filter(Boolean).join('');
  list.querySelectorAll('[data-group]').forEach(button => button.addEventListener('click', () => {
    state.activeGroup = button.dataset.group;
    saveState();
    render();
    if (window.innerWidth < 1050) setSidebar(false);
  }));
  list.querySelectorAll('[data-delete-group]').forEach(button => button.addEventListener('click', () => deleteGroup(button.dataset.deleteGroup)));
  list.querySelectorAll('[data-rename-group]').forEach(button => button.addEventListener('click', () => beginGroupRename(button.dataset.renameGroup)));
  list.querySelectorAll('[data-group-color]').forEach(input => input.addEventListener('input', () => {
    const group = state.groups.find(item => item.id === input.dataset.groupColor);
    if (!group) return;
    group.color = input.value;
    const row = input.closest('[data-group-row]');
    row.style.setProperty('--group-color', input.value);
    saveState();
  }));
  list.querySelectorAll('[data-reorder-group]').forEach(row => {
    const handle = row.querySelector('.group-drag-handle');
    handle.draggable = window.matchMedia('(pointer: fine)').matches;
    handle.addEventListener('dragstart', event => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', row.dataset.reorderGroup);
      row.classList.add('dragging');
    });
    handle.addEventListener('dragend', () => list.querySelectorAll('.group-item').forEach(item => item.classList.remove('dragging', 'drag-over')));
    let touchTargetId = '';
    handle.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' && handle.draggable) return;
      touchTargetId = '';
      handle.setPointerCapture(event.pointerId);
      row.classList.add('dragging');
    });
    handle.addEventListener('pointermove', event => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-reorder-group]');
      touchTargetId = target?.dataset.reorderGroup || '';
      list.querySelectorAll('[data-reorder-group]').forEach(item => item.classList.toggle('drag-over', item.dataset.reorderGroup === touchTargetId));
      event.preventDefault();
    });
    handle.addEventListener('pointerup', event => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      handle.releasePointerCapture(event.pointerId);
      row.classList.remove('dragging');
      list.querySelectorAll('[data-reorder-group]').forEach(item => item.classList.remove('drag-over'));
      if (touchTargetId) reorderGroups(row.dataset.reorderGroup, touchTargetId);
      touchTargetId = '';
    });
    handle.addEventListener('pointercancel', () => {
      row.classList.remove('dragging');
      list.querySelectorAll('[data-reorder-group]').forEach(item => item.classList.remove('drag-over'));
      touchTargetId = '';
    });
    row.addEventListener('dragover', event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.querySelectorAll('[data-reorder-group]').forEach(item => item.classList.toggle('drag-over', item === row));
    });
    row.addEventListener('drop', event => {
      event.preventDefault();
      reorderGroups(event.dataTransfer.getData('text/plain'), row.dataset.reorderGroup);
    });
  });
}

function renderCards() {
  const grid = document.getElementById('airport-grid');
  const airports = state.nearbyMode ? state.nearbyResults : airportsInActiveGroup();
  const empty = document.getElementById('empty-state');
  const selectedTime = state.arrivalTime || state.departureTime;
  document.getElementById('flight-time-note').textContent = getFlightWindow()
    ? `TAF periods overlapping ${state.departureTime}–${state.arrivalTime} UTC are highlighted. Possible alternates are assessed within this window.`
    : selectedTime
      ? `TAF is assessed for ${selectedTime} UTC${state.arrivalTime ? ' (ARR)' : ' (DEP)'}. Enter both DEP and ARR to highlight the full time window.`
      : 'Possible alternates are assessed from now through the next 3 hours UTC. Enter DEP and ARR to set a different assessment window.';
  const group = state.groups.find(item => item.id === state.activeGroup);
  document.getElementById('view-title').textContent = state.nearbyMode ? 'Nearby Possible Alternates' : group ? group.name : 'Airports';
  document.getElementById('view-eyebrow').textContent = state.nearbyMode ? `${state.nearbyOrigin.toUpperCase()} · WITHIN ${state.nearbyRadiusNm} NM` : group ? 'YOUR GROUP' : 'YOUR OVERVIEW';
  document.getElementById('view-subtitle').textContent = state.nearbyMode
    ? state.nearbyLoading ? 'Checking nearby TAFs against your planning minima…' : `${airports.length} possible alternate${airports.length === 1 ? '' : 's'} meeting your planning minima, sorted by distance.`
    : group ? `${group.airports.length} airport${group.airports.length === 1 ? '' : 's'} in this group.` : 'Weather at your airports, all in one place.';
  grid.innerHTML = state.nearbyMode
    ? airports.map(airport => renderCard(airport, true)).join('')
    : airports.map(airport => renderCard(airport)).join('');
  if (state.nearbyMode && state.nearbyLoading && !airports.length) {
    grid.innerHTML = '<p class="nearby-message">Finding airports and checking TAFs against your planning minima…</p>';
  }
  if (state.nearbyMode && !state.nearbyLoading && !airports.length) {
    grid.innerHTML = state.nearbyHasSearched
      ? '<p class="nearby-message">No nearby airports meet your planning minima at the selected time.</p>'
      : '<p class="nearby-message">Enter a destination ICAO and search, or choose Use my location to search from GPS.</p>';
  }
  grid.querySelectorAll('[data-notam-airport]').forEach(button => button.addEventListener('click', () => {
    openNotamPanel(button.dataset.notamAirport, button.dataset.notamType);
  }));
  grid.querySelectorAll('[data-history-toggle]').forEach(button => button.addEventListener('click', () => {
    toggleMetarHistory(button.dataset.historyToggle);
  }));
  grid.querySelectorAll('.weather-condition').forEach(button => button.addEventListener('click', () => {
    showStatus(button.dataset.tooltip);
  }));
  document.getElementById('nearby-taf').classList.toggle('active', state.nearbyMode);
  document.getElementById('nearby-icon').textContent = state.nearbyMode ? '←' : '⌖';
  document.getElementById('nearby-label-full').textContent = state.nearbyMode ? 'Back to Airports' : 'Nearby Possible Alternates';
  document.getElementById('nearby-label-short').textContent = state.nearbyMode ? 'Airports' : 'Nearby';
  document.getElementById('nearby-taf').title = state.nearbyMode ? 'Return to your airport cards' : `Find possible alternates within ${state.nearbyRadiusNm} NM`;
  document.getElementById('nearby-destination-form').hidden = !state.nearbyMode;
  empty.classList.toggle('visible', !state.nearbyMode && airports.length === 0);
  if (state.nearbyMode) {
    grid.querySelectorAll('[data-wind-toggle]').forEach(button => button.addEventListener('click', () => {
      const key = button.dataset.windToggle;
      if (state.expandedWind.has(key)) state.expandedWind.delete(key);
      else state.expandedWind.add(key);
      renderCards();
    }));
    grid.querySelectorAll('[data-add-nearby]').forEach(button => button.addEventListener('click', () => {
      const airport = state.nearbyResults.find(item => item.icao === button.dataset.addNearby);
      if (airport && !isAirportInUserBriefing(airport.icao)) addAirport(airport.icao);
      button.textContent = 'Added';
      button.disabled = true;
    }));
    return;
  }
  grid.querySelectorAll('[data-select]').forEach(input => input.addEventListener('change', () => {
    if (input.checked) state.selected.add(input.dataset.select);
    else state.selected.delete(input.dataset.select);
    document.getElementById('selection-count').textContent = `${state.selected.size} cards selected`;
  }));
  grid.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => removeAirport(button.dataset.remove)));
  grid.querySelectorAll('[data-membership-icao]').forEach(input => input.addEventListener('change', () => updateAirportGroupMembership(input)));
  grid.querySelectorAll('[data-wind-toggle]').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.windToggle;
    if (state.expandedWind.has(key)) state.expandedWind.delete(key);
    else state.expandedWind.add(key);
    renderCards();
  }));
  grid.querySelectorAll('.drag-handle').forEach(handle => handle.addEventListener('dragstart', event => {
    const card = handle.closest('.airport-card');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.dataset.airport);
    card.classList.add('dragging');
  }));
  grid.querySelectorAll('.drag-handle').forEach(handle => handle.addEventListener('dragend', () => {
    grid.querySelectorAll('.airport-card').forEach(card => card.classList.remove('dragging', 'drag-over'));
  }));
  grid.querySelectorAll('.airport-card').forEach(card => {
    card.addEventListener('dragover', event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      grid.querySelectorAll('.airport-card').forEach(other => other.classList.toggle('drag-over', other === card));
    });
    card.addEventListener('drop', event => {
      event.preventDefault();
      const sourceIcao = event.dataTransfer.getData('text/plain');
      reorderVisibleAirports(sourceIcao, card.dataset.airport);
    });
  });
}

function toggleNearbyView() {
  if (state.nearbyLoading) return;
  state.nearbyMode = !state.nearbyMode;
  state.nearbyResults = [];
  state.nearbyHasSearched = false;
  if (state.nearbyMode) state.nearbyOrigin = 'Choose origin';
  renderCards();
}

async function findNearbyTafAirports(options = {}) {
  if (state.nearbyLoading) return;
  const assessmentWindow = getNearbyAssessmentWindow();
  state.nearbyMode = true;
  state.nearbyResults = [];
  state.nearbyLoading = true;
  state.nearbyHasSearched = true;
  state.activeGroup = null;
  renderCards();
  try {
    const airports = await fetchNearbyAirportIndex();
    let origin;
    if (options.origin === 'destination') {
      if (!/^[A-Z]{4}$/.test(state.nearbyDestination)) throw new Error('Enter a valid four-letter destination ICAO code.');
      origin = airports.find(airport => airport.icao === state.nearbyDestination);
      if (!origin) throw new Error(`No coordinates found for ${state.nearbyDestination}.`);
    } else {
      if (!navigator.geolocation) throw new Error('GPS location is not available in this browser.');
      const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 }));
      origin = { lat: position.coords.latitude, lon: position.coords.longitude };
    }
    state.nearbyOrigin = origin.icao || 'GPS';
    renderCards();
    const nearby = airports.map(airport => ({ ...airport, distance: distanceNm(origin.lat, origin.lon, airport.lat, airport.lon) }))
      .filter(airport => airport.icao !== origin.icao && airport.distance <= state.nearbyRadiusNm)
      .sort((a, b) => a.distance - b.distance);
    let next = 0;
    const workers = Array.from({ length: Math.min(6, nearby.length) }, async () => {
      while (next < nearby.length) {
        const airport = nearby[next++];
        try {
          const taf = await fetchFreshWeather(airport.icao, 'taf');
          if (isCachedReport(taf)) {
            const report = { ...taf, retrievedAt: Date.now() };
            if (!isTafExpired(report) && assessPossibleAlternate(report.raw, assessmentWindow)?.possible) {
              const savedAirport = state.airports.find(item => item.icao === airport.icao);
              const [metarResult, runwayResult, variationResult, notamResult] = await Promise.allSettled([
                fetchFreshWeather(airport.icao, 'metar'),
                fetchOurAirportsRunways(airport.icao),
                fetchOurAirportsVariation(airport.icao),
                fetchFreshNotams(airport.icao, savedAirport)
              ]);
              const metar = metarResult.status === 'fulfilled' && isCachedReport(metarResult.value)
                ? { ...metarResult.value, retrievedAt: Date.now() }
                : { error: 'No METAR available.' };
              if (savedAirport && notamResult.status === 'fulfilled') {
                savedAirport.notams = notamResult.value;
                saveState();
              }
              state.nearbyResults.push({
                ...airport,
                taf: report,
                metar,
                notams: notamResult.status === 'fulfilled' ? notamResult.value : savedAirport?.notams,
                runways: runwayResult.status === 'fulfilled' ? runwayResult.value : [],
                magneticVariation: variationResult.status === 'fulfilled' ? variationResult.value : null
              });
              state.nearbyResults.sort((a, b) => a.distance - b.distance);
              renderCards();
            }
          }
        } catch (error) {
          console.warn(`Could not check TAF for ${airport.icao}:`, error);
        }
      }
    });
    await Promise.all(workers);
  } catch (error) {
    const message = error?.code === 1 ? 'Allow location access to search nearby airports.'
      : error?.code === 3 ? 'GPS location request timed out.'
        : error?.message || 'Could not search nearby airports.';
    showStatus(message, true);
  } finally {
    state.nearbyLoading = false;
    renderCards();
  }
}

async function fetchNearbyAirportIndex() {
  if (!airportCsvPromise) {
    airportCsvPromise = fetch(OURAIRPORTS_AIRPORTS_URL)
      .then(response => { if (!response.ok) throw new Error(`Airport list returned HTTP ${response.status}`); return response.text(); })
      .then(parseAirportCoordinates)
      .catch(error => { airportCsvPromise = null; throw error; });
  }
  return airportCsvPromise;
}

function parseAirportCoordinates(csvText) {
  const lines = csvText.split(/\r?\n/);
  const headers = splitCsvLine(lines[0] || '');
  const field = name => headers.indexOf(name);
  const icaoIndex = field('icao_code');
  const gpsIndex = field('gps_code');
  const typeIndex = field('type');
  const latIndex = field('latitude_deg');
  const lonIndex = field('longitude_deg');
  if ([typeIndex, latIndex, lonIndex].some(index => index < 0) || (icaoIndex < 0 && gpsIndex < 0)) throw new Error('Airport list is missing coordinate columns.');
  const result = new Map();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const row = splitCsvLine(line);
    const icao = [row[icaoIndex], row[gpsIndex]].map(value => (value || '').trim().toUpperCase()).find(value => /^[A-Z]{4}$/.test(value)) || '';
    const lat = Number.parseFloat(row[latIndex]);
    const lon = Number.parseFloat(row[lonIndex]);
    if (/^[A-Z]{4}$/.test(icao) && /^(small|medium|large)_airport$/.test(row[typeIndex] || '') && Number.isFinite(lat) && Number.isFinite(lon)) result.set(icao, { icao, lat, lon });
  }
  return [...result.values()];
}

function distanceNm(lat1, lon1, lat2, lon2) {
  const radians = degrees => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function renderCard(airport, nearby = false) {
  const metar = airport.metar || {};
  const taf = airport.taf || {};
  const tafExpired = isTafExpired(taf);
  const loading = state.busy.has(airport.icao);
  const metarText = metar.raw || (loading ? 'Loading current observation…' : metar.error || 'No METAR available.');
  const tafText = taf.raw || (loading ? 'Loading forecast…' : taf.error || 'No TAF available.');
  const notams = isCachedNotams(airport.notams) ? airport.notams : null;
  const notamActions = notams?.allNotams.length
    ? `${renderNotamButton(airport.icao, 'notam', `NOTAM ${notams.allNotams.length}`)}${notams.filteredNotams.length ? renderNotamButton(airport.icao, 'hours', `OP HRS ${notams.filteredNotams.length}`) : ''}`
    : '';
  const alternateBadge = nearby || isPossibleAlternate(airport) ? ' <span class="alternate-badge">[Possible alternate]</span>' : '';
  const cardActions = nearby
    ? `<button class="button nearby-add" type="button" data-add-nearby="${airport.icao}" ${isAirportInUserBriefing(airport.icao) ? 'disabled' : ''}>${isAirportInUserBriefing(airport.icao) ? 'Added' : '＋ Add to briefing'}</button>`
    : `${renderGroupMembership(airport.icao)}<button class="icon-button" data-remove="${airport.icao}" title="Remove ${airport.icao}" aria-label="Remove ${airport.icao}">×</button>`;
  const cardIdentification = nearby
    ? `<div class="airport-ident"><h2 class="airport-code">${airport.icao}${alternateBadge}${notamActions}</h2><p class="nearby-distance">${airport.distance.toFixed(1)} NM away</p></div>`
    : `<input class="card-select" type="checkbox" data-select="${airport.icao}" aria-label="Select ${airport.icao}" ${state.selected.has(airport.icao) ? 'checked' : ''}><div class="airport-ident"><h2 class="airport-code">${airport.icao}${alternateBadge}${notamActions}</h2></div>`;
  return `<article class="airport-card" data-airport="${airport.icao}">
    <header class="card-head">
      ${nearby ? '' : `<button class="drag-handle" type="button" draggable="true" aria-label="Drag to move ${airport.icao}" title="Drag to reorder">⠿</button>`}
      ${cardIdentification}
      <div class="card-actions">${cardActions}</div>
    </header>
    <section class="weather-block">
      ${renderWeatherToggle(airport.icao, 'metar', 'METAR', metar.time, metar.raw ? formatWeatherMarkup(metar.raw, 'metar', airport) : escapeHtml(metarText), metar.error ? 'error' : metar.raw ? '' : 'placeholder', metar.raw ? getWeatherConditionColors(metar.raw, 'metar') : null)}
      ${renderWeatherRunwayPanel(airport, 'metar')}
      ${renderMetarHistoryPanel(airport)}
    </section>
    <section class="weather-block taf-block">
      ${renderWeatherToggle(airport.icao, 'taf', 'TAF', taf.time, taf.raw ? formatTafForFlightWindow(taf.raw, airport) : escapeHtml(tafText), taf.error ? 'error' : taf.raw ? '' : 'placeholder', taf.raw ? getWeatherConditionColors(taf.raw, 'taf') : null, tafExpired ? '<span class="taf-expired" title="TAF validity period has ended">[EXPIRED]</span>' : '')}
      ${renderWeatherRunwayPanel(airport, 'taf')}
      ${renderAlternateAssessment(airport)}
    </section>
  </article>`;
}

function renderNotamButton(icao, type, label) {
  return ` <button class="notam-badge" type="button" data-notam-airport="${icao}" data-notam-type="${type}">${label}</button>`;
}

function openNotamPanel(icao, type) {
  const airport = state.airports.find(item => item.icao === icao) || state.nearbyResults.find(item => item.icao === icao);
  const notams = airport && isCachedNotams(airport.notams) ? airport.notams : null;
  if (!notams) return;
  const isHours = type === 'hours';
  const items = isHours ? notams.filteredNotams : notams.allNotams;
  document.getElementById('notam-title').textContent = `${icao} · ${isHours ? 'OP HRS' : 'NOTAM'}`;
  const content = document.getElementById('notam-content');
  content.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.textContent = isHours ? 'No operating-hours NOTAMs found.' : 'No active NOTAMs found.';
    content.append(empty);
  } else {
    items.forEach((item, index) => {
      const article = document.createElement('article');
      article.className = 'notam-entry';
      const heading = document.createElement('h3');
      heading.textContent = `${isHours ? 'OP HRS' : `NOTAM ${index + 1}`}`;
      const text = document.createElement('p');
      text.textContent = item;
      article.append(heading, text);
      content.append(article);
    });
  }
  document.getElementById('notam-overlay').hidden = false;
}

function closeNotamPanel() {
  document.getElementById('notam-overlay').hidden = true;
}

function renderGroupMembership(icao) {
  const memberships = state.groups.filter(group => group.airports.includes(icao));
  const options = state.groups.map(group => `<label class="group-membership-option"><input type="checkbox" data-membership-icao="${icao}" data-membership-group="${escapeHtml(group.id)}" ${group.airports.includes(icao) ? 'checked' : ''} ${isBuiltinGroup(group.id) ? 'disabled' : ''}><span>${escapeHtml(group.name)}</span></label>`).join('');
  return `<details class="group-membership"><summary aria-label="Manage groups for ${icao}">Groups ${memberships.length}</summary><div class="group-membership-options">${options || '<span class="group-empty">Add a group in the sidebar.</span>'}</div></details>`;
}

function isPossibleAlternate(airport) {
  const window = getPossibleAlternateWindow();
  return Boolean(airport.taf?.raw && assessPossibleAlternate(airport.taf.raw, window)?.possible);
}

function renderWeatherToggle(icao, product, label, time, report, reportClass, conditionColors, statusTag = '') {
  const key = `${icao}:${product}`;
  const expanded = state.expandedWind.has(key);
  const indicator = conditionColors
    ? `<button class="weather-condition" type="button" style="--ceiling-color:${conditionColors.ceiling};--visibility-color:${conditionColors.visibility}" data-tooltip="Top half: ceiling (${conditionColors.ceilingLabel}). Bottom half: visibility (${conditionColors.visibilityLabel})." title="Top half: ceiling. Bottom half: visibility." aria-label="Explain weather colors: ceiling ${conditionColors.ceilingLabel}; visibility ${conditionColors.visibilityLabel}"></button>`
    : '';
  return `<div class="weather-summary-wrap"><div class="weather-heading"><span class="weather-label">${indicator}${label}${statusTag}</span>${product === 'metar' ? `<button class="history-toggle" type="button" data-history-toggle="${icao}" aria-expanded="${state.expandedHistory.has(icao)}" aria-controls="metar-history-${icao}">History</button>` : ''}<span class="weather-time">${escapeHtml(time || '—')}</span><button class="weather-wind-hint" type="button" data-wind-toggle="${key}" aria-expanded="${expanded}" aria-controls="wind-panel-${key.replace(':', '-')}" title="Show or hide runway wind for ${label}">${expanded ? 'Hide runway wind ▴' : 'Show runway wind ▾'}</button></div><button class="weather-summary" type="button" data-wind-toggle="${key}" aria-expanded="${expanded}" aria-controls="wind-panel-${key.replace(':', '-')}" title="Show or hide runway wind for ${label}"><span class="weather-text ${reportClass}">${report}</span></button></div>`;
}

function getWeatherConditionColors(raw, product) {
  const neutral = '#43515a';
  let relevantText = raw;
  if (product === 'taf') {
    const slices = getTafWindowSlices(raw, getPossibleAlternateWindow());
    if (slices.length) {
      const selected = slices.filter(slice => slice.highlight);
      if (selected.length) {
        relevantText = selected.map(slice => raw.slice(slice.start, slice.end)).join(' ');
        if (!getTafVisibilityRanges(relevantText).length) {
          const firstSelected = Math.min(...selected.map(slice => slice.start));
          const inheritedVisibility = findInheritedTafComponent(raw, slices, firstSelected, 'visibility');
          if (inheritedVisibility) relevantText += ` ${raw.slice(inheritedVisibility.start, inheritedVisibility.end)}`;
        }
      }
    }
  }

  const severityColor = (value, ranges) => ranges.find(range => value >= range.min && value <= range.max) || null;
  const ceilingRanges = product === 'metar'
    ? [
      { min: 0, max: 199, color: '#ff6969', label: 'red', severity: 4 },
      { min: 201, max: 400, color: '#ffae5c', label: 'orange', severity: 3 },
      { min: 401, max: 3000, color: '#e6ca62', label: 'gul', severity: 2 },
      { min: 3001, max: Infinity, color: '#70dfa3', label: 'green', severity: 1 }
    ]
    : [
      { min: 200, max: 399, color: '#ff6969', label: 'red', severity: 4 },
      { min: 400, max: 800, color: '#ffae5c', label: 'orange', severity: 3 },
      { min: 801, max: 2399, color: '#e6ca62', label: 'gul', severity: 2 },
      { min: 2400, max: Infinity, color: '#70dfa3', label: 'green', severity: 1 }
    ];
  const visibilityRanges = product === 'metar'
    ? [
      { min: 0, max: 399, color: '#ff55dc', label: 'magenta', severity: 5 },
      { min: 400, max: 549, color: '#ff6969', label: 'red', severity: 4 },
      { min: 550, max: 800, color: '#ffae5c', label: 'orange', severity: 3 },
      { min: 801, max: 1400, color: '#e6ca62', label: 'gul', severity: 2 },
      { min: 1401, max: Infinity, color: '#70dfa3', label: 'green', severity: 1 }
    ]
    : [
      { min: 0, max: 549, color: '#ff55dc', label: 'magenta', severity: 5 },
      { min: 550, max: 1399, color: '#ff6969', label: 'red', severity: 4 },
      { min: 1400, max: 2299, color: '#ffae5c', label: 'orange', severity: 3 },
      { min: 2300, max: Infinity, color: '#70dfa3', label: 'green', severity: 1 }
    ];

  const ceilingValues = [...relevantText.matchAll(/\b(?:BKN|OVC|VV)(\d{3})\b/g)]
    .map(match => Number(match[1]) * 100)
    .map(value => severityColor(value, ceilingRanges))
    .filter(Boolean);
  const visibilityValues = product === 'metar'
    ? [...relevantText.matchAll(/\b(\d{4})\b|\bR\d{2}[LCR]?\/[PM]?(\d{3,4})\b/g)].map(match => Number(match[1] || match[2]))
    : [...relevantText.matchAll(/(?<!\/)\b(\d{4})\b(?!\/)/g)].map(match => Number(match[1]));
  if (/\bCAVOK\b/.test(relevantText)) visibilityValues.push(9999);
  const visibilityColors = visibilityValues.map(value => severityColor(value, visibilityRanges)).filter(Boolean);
  const worst = values => values.sort((a, b) => b.severity - a.severity)[0];
  const ceiling = worst(ceilingValues);
  const visibility = worst(visibilityColors);
  return {
    ceiling: ceiling?.color || '#70dfa3',
    visibility: visibility?.color || neutral,
    ceilingLabel: ceiling?.label || 'no ceiling',
    visibilityLabel: visibility?.label || 'unavailable'
  };
}

async function refreshAirport(icao, options = {}) {
  if (state.busy.has(icao)) return { notamFailed: false };
  state.busy.add(icao);
  if (options.renderStart !== false) renderCards();
  try {
    const [metarResult, tafResult, notamResult, runwayResult] = await Promise.allSettled([
      fetchFreshWeather(icao, 'metar', state.airports.find(item => item.icao === icao)),
      fetchFreshWeather(icao, 'taf', state.airports.find(item => item.icao === icao)),
      options.skipNotams ? Promise.resolve(null) : fetchFreshNotams(icao, state.airports.find(item => item.icao === icao)),
      options.skipRunways ? Promise.resolve([null, null]) : Promise.allSettled([fetchOurAirportsRunways(icao), fetchOurAirportsVariation(icao)])
    ]);
    const airport = state.airports.find(item => item.icao === icao);
    if (!airport) return { notamFailed: false };
    const updateReport = (product, result) => {
      const current = airport[product];
      if (result.status === 'fulfilled' && isCachedReport(result.value)) {
        airport[product] = { ...result.value, retrievedAt: Date.now() };
        return true;
      }
      if (!isCachedReport(current)) {
        airport[product] = result.status === 'rejected'
          ? { error: `Could not fetch ${product.toUpperCase()}: ${result.reason?.message || 'unknown error'}` }
          : { error: `No ${product.toUpperCase()} available.` };
      }
      return false;
    };
    const metarUpdated = updateReport('metar', metarResult);
    const tafUpdated = updateReport('taf', tafResult);
    if (notamResult.status === 'fulfilled' && notamResult.value) airport.notams = notamResult.value;
    if (metarUpdated || tafUpdated || (notamResult.status === 'fulfilled' && notamResult.value)) saveState();
    const runwayData = runwayResult.status === 'fulfilled' ? runwayResult.value[0] : null;
    const variationData = runwayResult.status === 'fulfilled' ? runwayResult.value[1] : null;
    airport.runways = runwayData?.status === 'fulfilled' ? runwayData.value : [];
    airport.magneticVariation = variationData?.status === 'fulfilled' ? variationData.value : null;
    airport.runwayError = runwayData?.status === 'rejected' ? 'Could not load runway headings from OurAirports.' : '';
    const failed = [metarResult, tafResult].some(result => result.status === 'rejected');
    const notamFailed = notamResult.status === 'rejected';
    if (failed) showStatus(`Could not fetch weather data for ${icao}.`, true);
    if (notamFailed && !options.quiet) showStatus(`Could not refresh NOTAMs for ${icao}; saved NOTAMs are unchanged.`, true);
    document.getElementById('updated-label').textContent = `Last updated ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
    return { notamFailed };
  } catch (error) {
    console.error(`Could not fetch weather for ${icao}:`, error);
    return { notamFailed: false };
  } finally {
    state.busy.delete(icao);
    if (options.renderFinish !== false) renderCards();
  }
}

function renderWeatherRunwayPanel(airport, product) {
  const key = `${airport.icao}:${product}`;
  if (!state.expandedWind.has(key)) return '';
  const isTaf = product === 'taf';
  const targetTime = isTaf ? getFlightTargetTime() : new Date();
  const runwayList = airport.runways || [];
  let rows;
  if (airport.runwayError) {
    rows = `<p class="runway-empty">${escapeHtml(airport.runwayError)}</p>`;
  } else if (!runwayList.length) {
    rows = `<p class="runway-empty">${state.busy.has(airport.icao) ? 'Loading runway headings…' : 'No runways found for this airport in OurAirports.'}</p>`;
  } else {
    const weatherText = isTaf ? airport.taf?.raw || '' : airport.metar?.raw || '';
    const flightWindow = isTaf ? getFlightWindow() : null;
    const winds = flightWindow
      ? extractWindForWindow(weatherText, flightWindow)
      : extractWindForTime(weatherText, targetTime);
    rows = renderWindRunways(runwayList, winds);
  }
  return `<div class="wind-panel" id="wind-panel-${key.replace(':', '-')}">
    ${rows}
  </div>`;
}

function renderWindRunways(runways, winds) {
  if (!winds || winds.length === 0) return '<p class="runway-empty">No wind group could be parsed for the selected time or period.</p>';
  const rows = [];
  runways.forEach(runway => {
    const heading = Number(runway.headingDegT);
    if (runway.headingDegT === null || runway.headingDegT === undefined || !Number.isFinite(heading)) return;
    const scenarios = [];
    winds.forEach(wind => {
      const angle = ((wind.direction - heading + 540) % 360) - 180;
      const headwind = wind.variable ? null : Math.round(wind.speed * Math.cos(angle * Math.PI / 180));
      const crosswind = wind.variable ? wind.speed : Math.abs(Math.round(wind.speed * Math.sin(angle * Math.PI / 180)));
      const gustCrosswind = wind.variable ? wind.gust : Math.abs(Math.round(wind.gust * Math.sin(angle * Math.PI / 180)));
      const hwLabel = headwind === null ? 'HW/TW —' : headwind >= 0 ? `HW ${headwind} kt` : `TW ${Math.abs(headwind)} kt`;
      const xwLabel = wind.variable
        ? `XW up to ${crosswind} kt (VRB)${gustCrosswind > crosswind ? ` · gust ${gustCrosswind} kt` : ''}`
        : `XW ${crosswind} kt${angle > 0 ? ' right' : angle < 0 ? ' left' : ''}${gustCrosswind > crosswind ? ` · gust ${gustCrosswind} kt` : ''}`;
      const variation = Number(runway.magneticVariation);
      const magneticHeading = Number.isFinite(variation) ? (heading - variation + 360) % 360 : null;
      const windDirection = wind.variable ? 'VRB' : `${String(wind.direction).padStart(3, '0')}°`;
      const windSpeed = `${wind.speed}${wind.gust > wind.speed ? `G${wind.gust}` : ''} kt`;
      scenarios.push({ ident: runway.ident, heading, magneticHeading, source: wind.source, windLabel: `${windDirection} ${windSpeed}`, headwind, crosswind, gustCrosswind, hwLabel, xwLabel });
    });
    scenarios.sort((a, b) => b.gustCrosswind - a.gustCrosswind || (a.headwind ?? -Infinity) - (b.headwind ?? -Infinity));
    if (scenarios.length) rows.push(scenarios[0]);
  });
  if (!rows.length) return '<p class="runway-empty">No runways with true headings available for component calculations.</p>';
  rows.sort((a, b) => a.gustCrosswind - b.gustCrosswind || (b.headwind ?? -Infinity) - (a.headwind ?? -Infinity) || a.ident.localeCompare(b.ident));
  const best = rows[0];
  return rows.map(row => {
    const isBest = row === best;
    const heading = row.magneticHeading === null ? '' : ` · ${row.magneticHeading.toFixed(0)}°M`;
    return `<div class="runway-result ${isBest ? 'best' : ''}"><span>RWY ${escapeHtml(row.ident)}${heading}${isBest ? ' <b class="best-runway-badge">BEST</b>' : ''}<small class="runway-wind-used">Wind calculated using ${escapeHtml(row.windLabel)}${row.source && row.source !== 'METAR' ? ` · ${escapeHtml(row.source)}` : ''}</small></span><span>${escapeHtml(row.hwLabel)} · ${escapeHtml(row.xwLabel)}</span></div>`;
  }).join('');
}

function renderMetarHistoryPanel(airport) {
  const icao = airport.icao;
  if (!state.expandedHistory.has(icao)) return '';
  const panelId = `metar-history-${icao}`;
  if (state.historyLoading.has(icao)) return `<div class="history-panel" id="${panelId}"><p class="runway-empty">Loading recent METAR history…</p></div>`;
  if (airport.metarHistoryError) return `<div class="history-panel" id="${panelId}"><p class="runway-empty">${escapeHtml(airport.metarHistoryError)}</p></div>`;
  if (!Array.isArray(airport.metarHistory) || !airport.metarHistory.length) return `<div class="history-panel" id="${panelId}"><p class="runway-empty">No recent METAR history available.</p></div>`;
  const observations = airport.metarHistory.map(observation => {
    return `<article class="history-entry"><p class="history-report">${formatWeatherMarkup(observation.raw, 'metar', airport)}</p></article>`;
  }).join('');
  return `<div class="history-panel" id="${panelId}">${observations}</div>`;
}

async function toggleMetarHistory(icao) {
  if (state.expandedHistory.has(icao)) {
    state.expandedHistory.delete(icao);
    renderCards();
    return;
  }
  state.expandedHistory.add(icao);
  const airport = state.airports.find(item => item.icao === icao) || state.nearbyResults.find(item => item.icao === icao);
  if (!airport) return;
  if (!Array.isArray(airport.metarHistory) && !state.historyLoading.has(icao)) {
    state.historyLoading.add(icao);
    renderCards();
    try {
      airport.metarHistory = await fetchMetarHistory(icao);
      airport.metarHistoryError = '';
    } catch (error) {
      airport.metarHistoryError = `Could not load METAR history: ${error.message}`;
    } finally {
      state.historyLoading.delete(icao);
    }
  }
  renderCards();
}

async function fetchMetarHistory(icao) {
  const url = new URL(WEATHER_WORKER_URL);
  url.searchParams.set('icao', icao);
  url.searchParams.set('product', 'metar-history');
  const response = await fetch(url.toString());
  const body = (await response.text()).trim();
  if (!response.ok) throw new Error(body || `Worker returned HTTP ${response.status}`);
  const reports = body.split(/(?=\b(?:METAR|SPECI)\s+[A-Z0-9]{4}\s+\d{6}Z)/g)
    .map(raw => raw.trim())
    .filter(raw => /^(?:METAR|SPECI)\s+[A-Z0-9]{4}\s+\d{6}Z/.test(raw));
  return reports.map(raw => {
    const match = raw.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
    const epoch = match ? resolveMetarHistoryTimestamp(match.slice(1).map(Number)) : 0;
    return { raw, time: timestampFromMetar(raw), epoch };
  }).sort((a, b) => b.epoch - a.epoch).slice(0, 10);
}

function resolveMetarHistoryTimestamp([day, hour, minute]) {
  const now = new Date();
  const candidates = [-1, 0, 1].map(offset => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, day, hour, minute)));
  return candidates.sort((a, b) => Math.abs(a.getTime() - now.getTime()) - Math.abs(b.getTime() - now.getTime()))[0].getTime();
}

function renderAlternateAssessment(airport) {
  const window = getPossibleAlternateWindow();
  if (!airport.taf?.raw) return '';
  const assessment = assessPossibleAlternate(airport.taf.raw, window);
  if (!assessment) return `<p class="alternate-assessment unavailable">Possible alternate: could not be assessed within the selected time window.</p>`;
  if (assessment.possible) return '';
  const text = `Planning minima not met · ${assessment.reasons.join(', ')}`;
  return `<p class="alternate-assessment not-possible">${escapeHtml(text)}</p>`;
}

function getPossibleAlternateWindow() {
  const selectedWindow = getFlightWindow();
  if (selectedWindow) return selectedWindow;
  const start = new Date();
  return { start, end: new Date(start.getTime() + 3 * 60 * 60 * 1000) };
}

function getFlightWindow() {
  if (!state.departureTime || !state.arrivalTime) return null;
  const parse = value => {
    const match = value.match(/^(\d{2}):(\d{2})$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const dep = parse(state.departureTime);
  const arr = parse(state.arrivalTime);
  if (dep === null || arr === null) return null;
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCMinutes(dep);
  const end = new Date(start);
  end.setUTCHours(Math.floor(arr / 60), arr % 60, 0, 0);
  if (arr <= dep) end.setUTCDate(end.getUTCDate() + 1);
  if (end <= new Date()) {
    start.setUTCDate(start.getUTCDate() + 1);
    end.setUTCDate(end.getUTCDate() + 1);
  }
  return { start, end };
}

function getNearbyAssessmentWindow() {
  return getPossibleAlternateWindow();
}

function getTafWindowSlices(raw, window) {
  if (!raw || !window) return [];
  const validity = raw.match(/\b(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
  if (!validity) return [];
  const validityRange = resolveTafRange(new Date(window.start), validity.slice(1).map(Number), window);
  if (!validityRange) return [];
  const marker = /(?:^|\s)(FM\d{6}|BECMG\s+\d{4}\/\d{4}|TEMPO\s+\d{4}\/\d{4}|PROB\d{2}(?:\s+TEMPO)?\s+\d{4}\/\d{4})/g;
  const blocks = [...raw.matchAll(marker)].map(match => ({ start: match.index + match[0].length - match[1].length, text: match[1] }));
  const groups = [{
    start: 0,
    end: blocks[0]?.start ?? raw.length,
    interval: { start: new Date(validityRange.start), end: new Date(validityRange.end) },
    kind: 'BASE'
  }];
  blocks.forEach((block, index) => {
    const next = blocks[index + 1];
    const fm = block.text.match(/^FM(\d{2})(\d{2})(\d{2})$/);
    let interval;
    let kind;
    if (fm) {
      const start = resolveTafFmDate(validityRange.start, validityRange.end, Number(fm[1]), Number(fm[2]), Number(fm[3]));
      const nextFm = blocks.slice(index + 1).map(item => item.text.match(/^FM(\d{2})(\d{2})(\d{2})$/)).find(Boolean);
      const end = nextFm
        ? resolveTafFmDate(validityRange.start, validityRange.end, Number(nextFm[1]), Number(nextFm[2]), Number(nextFm[3]))
        : validityRange.end;
      interval = start && end ? { start, end } : null;
      kind = 'FM';
    } else {
      const range = block.text.match(/(\d{2})(\d{2})\/(\d{2})(\d{2})/);
      if (range) interval = resolveTafCalendarRange(validityRange.start, range.slice(1).map(Number));
      kind = /^BECMG/.test(block.text) ? 'BECMG' : /^PROB/.test(block.text) ? 'PROB' : 'TEMPO';
    }
    if (interval) groups.push({ start: block.start, end: next?.start ?? raw.length, interval, kind });
  });
  groups.forEach((group, index) => {
    if (group.kind === 'BASE' || group.kind === 'FM') {
      const nextChange = groups.slice(index + 1)
        .filter(item => item.kind === 'FM' || item.kind === 'BECMG')
        .sort((a, b) => a.interval.start - b.interval.start)[0];
      if (nextChange) {
        const effectiveAt = nextChange.kind === 'BECMG' ? nextChange.interval.end : nextChange.interval.start;
        if (group.interval.end > effectiveAt) group.interval.end = effectiveAt;
      }
    } else if (group.kind === 'BECMG') {
      const nextChange = groups.slice(index + 1)
        .filter(item => item.kind === 'FM' || item.kind === 'BECMG')
        .sort((a, b) => a.interval.start - b.interval.start)[0];
      group.interval.end = nextChange
        ? new Date(Math.min(nextChange.interval.start.getTime(), validityRange.end.getTime()))
        : new Date(validityRange.end);
    }
  });
  const slices = [];
  let cursor = 0;
  for (const group of groups) {
    if (group.start > cursor) slices.push({ start: cursor, end: group.start, highlight: false, kind: null });
    slices.push({ start: group.start, end: group.end, highlight: intervalsOverlap(group.interval, window), kind: group.kind });
    cursor = group.end;
  }
  if (cursor < raw.length) slices.push({ start: cursor, end: raw.length, highlight: false, kind: null });
  return slices;
}

function resolveTafRange(reference, parts, flightWindow) {
  const [startDay, startHour, endDay, endHour] = parts;
  for (let monthOffset = -1; monthOffset <= 1; monthOffset++) {
    const year = reference.getUTCFullYear();
    const month = reference.getUTCMonth() + monthOffset;
    const start = new Date(Date.UTC(year, month, startDay, startHour));
    if (start.getUTCDate() !== startDay) continue;
    const endDayCheck = new Date(Date.UTC(year, month, endDay));
    if (endDayCheck.getUTCDate() !== endDay) continue;
    let end = new Date(Date.UTC(year, month, endDay, endHour));
    if (end <= start) {
      end = endDay < startDay
        ? new Date(Date.UTC(year, month + 1, endDay, endHour))
        : new Date(Date.UTC(year, month, endDay + 1, endHour));
    }
    if (end > start && intervalsOverlap({ start, end }, flightWindow)) return { start, end };
  }
  return null;
}

function resolveTafCalendarRange(reference, parts) {
  const [startDay, startHour, endDay, endHour] = parts;
  const candidates = [];
  for (let monthOffset = -1; monthOffset <= 1; monthOffset++) {
    const interval = makeUtcDayInterval(
      reference.getUTCFullYear(),
      reference.getUTCMonth(),
      monthOffset,
      startDay,
      startHour,
      endDay,
      endHour
    );
    if (interval) candidates.push(interval);
  }
  candidates.sort((a, b) => {
    const distance = interval => reference < interval.start
      ? interval.start - reference
      : reference > interval.end ? reference - interval.end : 0;
    return distance(a) - distance(b);
  });
  return candidates[0] || null;
}

function isTafExpired(report, now = new Date()) {
  if (!isCachedReport(report)) return false;
  const validity = report.raw.match(/\b(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
  if (!validity) return false;
  const reference = Number.isFinite(report.retrievedAt) ? new Date(report.retrievedAt) : now;
  const range = resolveTafCalendarRange(reference, validity.slice(1).map(Number));
  return Boolean(range && range.end <= now);
}

function resolveTafDayTime(reference, day, hour, minute, flightWindow) {
  for (let monthOffset = -1; monthOffset <= 1; monthOffset++) {
    const date = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + monthOffset, day, hour, minute));
    if (date >= flightWindow.start - 86400000 && date <= flightWindow.end + 86400000) return date;
  }
  return null;
}

function intervalsOverlap(a, b) {
  return Boolean(a && b && a.start < b.end && b.start < a.end);
}

function assessPossibleAlternate(raw, window) {
  const groups = getTafWindowSlices(raw, window).filter(slice => slice.highlight);
  if (!groups.length) return null;
  const text = groups.map(group => raw.slice(group.start, group.end)).join(' ');
  const reasons = [];
  const validity = raw.match(/\b(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
  const coverage = validity && resolveTafRange(new Date(window.start), validity.slice(1).map(Number), window);
  if (!coverage || coverage.start > window.start || coverage.end < window.end) reasons.push('TAF does not cover the full DEP–ARR window');
  const rvr = [...text.matchAll(/R\d{2}[LCR]?\/([PM]?)(\d{3,4})/g)];
  if (rvr.some(match => Number(match[2]) <= 550 || match[1] === 'M')) reasons.push('RVR ≤ 550 m');
  const vis = [...text.matchAll(/(?:^|\s)(\d{4})(?=\s|$)/g)].map(match => Number(match[1]));
  if (vis.some(value => value < 1400)) reasons.push('visibility below 1,400 m');
  if ([...text.matchAll(/\b(?:BKN|OVC)(\d{3})/g)].some(match => Number(match[1]) <= 3)) reasons.push('BKN/OVC ceiling ≤ 300 ft');
  if (/\bTS\b/.test(text)) reasons.push('thunderstorm (TS)');
  return { possible: reasons.length === 0, reasons: reasons.length ? [...new Set(reasons)] : ['—'] };
}

function getFlightTargetTime() {
  const time = state.arrivalTime || state.departureTime;
  if (!time) return new Date();
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return new Date();
  const target = new Date();
  target.setUTCHours(Number(match[1]), Number(match[2]), 0, 0);
  if (target <= new Date()) target.setUTCDate(target.getUTCDate() + 1);
  return target;
}

async function fetchOurAirportsRunways(icao) {
  const cacheKey = `${RUNWAY_CACHE_PREFIX}${icao}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && cached.expiresAt > Date.now() && Array.isArray(cached.runways)) return cached.runways;
  } catch (error) {
    console.warn(`Could not read the runway cache for ${icao}:`, error);
  }

  if (!runwayCsvPromise) {
    runwayCsvPromise = fetch(OURAIRPORTS_RUNWAYS_URL)
      .then(response => {
        if (!response.ok) throw new Error(`OurAirports svarade HTTP ${response.status}`);
        return response.text();
      })
      .then(parseRunwayCsv)
      .catch(error => {
        runwayCsvPromise = null;
        throw error;
      });
  }

  const index = await runwayCsvPromise;
  const runways = index[icao] || [];
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ expiresAt: Date.now() + RUNWAY_CACHE_TTL_MS, runways }));
  } catch (error) {
    console.warn(`Could not cache runways for ${icao}:`, error);
  }
  return runways;
}

async function fetchOurAirportsVariation(icao) {
  const cacheKey = `${RUNWAY_CACHE_PREFIX}${icao}-variation`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && cached.expiresAt > Date.now()) return cached.variation;
  } catch (error) {
    console.warn(`Could not read the magnetic variation cache for ${icao}:`, error);
  }
  if (!navaidCsvPromise) {
    navaidCsvPromise = fetch(OURAIRPORTS_NAVAIDS_URL)
      .then(response => {
        if (!response.ok) throw new Error(`OurAirports svarade HTTP ${response.status}`);
        return response.text();
      })
      .then(parseNavaidVariations)
      .catch(error => { navaidCsvPromise = null; throw error; });
  }
  const index = await navaidCsvPromise;
  const variation = index[icao] ?? null;
  try { localStorage.setItem(cacheKey, JSON.stringify({ expiresAt: Date.now() + RUNWAY_CACHE_TTL_MS, variation })); } catch (error) { console.warn(`Could not cache magnetic variation for ${icao}:`, error); }
  return variation;
}

function parseNavaidVariations(csvText) {
  const lines = csvText.split(/\r?\n/);
  if (!lines.length) return {};
  const headers = splitCsvLine(lines[0]);
  const airportIndex = headers.indexOf('associated_airport');
  const variationIndex = headers.indexOf('magnetic_variation_deg');
  const typeIndex = headers.indexOf('type');
  const latIndex = headers.indexOf('latitude_deg');
  const lonIndex = headers.indexOf('longitude_deg');
  if ([airportIndex, variationIndex].some(index => index < 0)) throw new Error('OurAirports NAVAID CSV is missing the magnetic variation column.');
  const candidates = {};
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = splitCsvLine(lines[i]);
    const airport = (cols[airportIndex] || '').trim().toUpperCase();
    const variation = Number.parseFloat(cols[variationIndex]);
    if (!airport || !Number.isFinite(variation)) continue;
    const type = cols[typeIndex] || '';
    const priority = /VOR|TACAN/.test(type) ? 0 : /NDB/.test(type) ? 1 : 2;
    const lat = Number.parseFloat(cols[latIndex]);
    const lon = Number.parseFloat(cols[lonIndex]);
    (candidates[airport] ||= []).push({ variation, priority, lat, lon });
  }
  const result = {};
  Object.entries(candidates).forEach(([icao, list]) => {
    list.sort((a, b) => a.priority - b.priority);
    result[icao] = list[0].variation;
  });
  return result;
}

function parseRunwayCsv(csvText) {
  const lines = csvText.split(/\r?\n/);
  if (!lines.length) return {};
  const headers = splitCsvLine(lines[0]);
  const airportIndex = headers.indexOf('airport_ident');
  const leIdentIndex = headers.indexOf('le_ident');
  const leHeadingIndex = headers.indexOf('le_heading_degT');
  const heIdentIndex = headers.indexOf('he_ident');
  const heHeadingIndex = headers.indexOf('he_heading_degT');
  const closedIndex = headers.indexOf('closed');
  if ([airportIndex, leIdentIndex, leHeadingIndex, heIdentIndex, heHeadingIndex].some(index => index < 0)) {
    throw new Error('OurAirports CSV is missing expected columns.');
  }

  const result = {};
  for (let index = 1; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    const columns = splitCsvLine(lines[index]);
    const airport = (columns[airportIndex] || '').trim().toUpperCase();
    const closed = closedIndex >= 0 && ['1', 'true'].includes((columns[closedIndex] || '').trim().toLowerCase());
    if (!airport || closed) continue;
    if (!result[airport]) result[airport] = [];
    for (const [identIndex, headingIndex] of [[leIdentIndex, leHeadingIndex], [heIdentIndex, heHeadingIndex]]) {
      const ident = (columns[identIndex] || '').trim();
      const heading = Number.parseFloat(columns[headingIndex]);
      if (ident) result[airport].push({ ident, headingDegT: Number.isFinite(heading) ? heading : null });
    }
  }
  return result;
}

function splitCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

async function fetchWorkerWeather(icao, product) {
  const url = new URL(WEATHER_WORKER_URL);
  url.searchParams.set('icao', icao);
  if (product !== 'metar') url.searchParams.set('product', product);
  const response = await fetch(url.toString());
  const body = (await response.text()).trim();
  if (!response.ok) throw new Error(`Cloudflare Worker svarade HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
  if (!body) return { raw: '', time: '' };

  const expected = product === 'taf' ? /\bTAF\b/ : /^(?:METAR|SPECI)\b/;
  if (!expected.test(body)) {
    if (/^(?:No data|Error fetching|Missing or invalid)\b/i.test(body)) throw new Error(body.slice(0, 160));
    const preview = body.replace(/\s+/g, ' ').slice(0, 120);
    throw new Error(`Worker returned no ${product.toUpperCase()} for ${icao}${preview ? ` (response: ${preview})` : ' (empty response)'}. Check that the TAF route is deployed.`);
  }
  return { raw: body, time: product === 'metar' ? timestampFromMetar(body) : timestampFromTaf(body) };
}

async function fetchFreshWeather(icao, product, airport = state.airports.find(item => item.icao === icao)) {
  const cached = airport?.[product];
  const maxAge = product === 'metar' ? METAR_REFRESH_AGE_MS : TAF_REFRESH_AGE_MS;
  const timestamp = cached?.time || (product === 'metar' ? timestampFromMetar(cached?.raw) : timestampFromTaf(cached?.raw));
  const reportDate = isCachedReport(cached) ? weatherReportDate(timestamp) : null;
  if (reportDate && Date.now() - reportDate.getTime() < maxAge) return cached;
  return fetchWorkerWeather(icao, product);
}

function weatherReportDate(timestamp, reference = new Date()) {
  const match = String(timestamp || '').match(/^(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;
  const [, dayText, hourText, minuteText] = match;
  const candidates = [];
  for (let monthOffset = -1; monthOffset <= 1; monthOffset++) {
    const candidate = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + monthOffset, Number(dayText), Number(hourText), Number(minuteText)));
    if (candidate.getUTCDate() === Number(dayText) && candidate.getUTCHours() === Number(hourText) && candidate.getUTCMinutes() === Number(minuteText)) candidates.push(candidate);
  }
  return candidates.sort((a, b) => Math.abs(a - reference) - Math.abs(b - reference))[0] || null;
}

async function fetchFreshNotams(icao, airport = state.airports.find(item => item.icao === icao)) {
  const cached = airport?.notams;
  if (isCachedNotams(cached) && Number.isFinite(cached.retrievedAt) && Date.now() - cached.retrievedAt < NOTAM_REFRESH_AGE_MS) return cached;
  return { ...await fetchWorkerNotams(icao), retrievedAt: Date.now() };
}

function fetchWorkerNotams(icao) {
  const request = notamRequestQueue.then(async () => {
    const delay = Math.max(0, 1200 - (Date.now() - lastNotamRequestAt));
    if (lastNotamRequestAt && delay) await new Promise(resolve => setTimeout(resolve, delay));
    lastNotamRequestAt = Date.now();
    return fetchWorkerNotamsNow(icao);
  });
  notamRequestQueue = request.catch(() => {});
  return request;
}

async function fetchWorkerNotamsNow(icao) {
  const url = new URL(WEATHER_WORKER_URL);
  url.searchParams.set('icao', icao);
  url.searchParams.set('product', 'notam');
  const response = await fetch(url.toString());
  const body = await response.text();
  if (!response.ok) throw new Error(`NOTAM proxy returned HTTP ${response.status}`);
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('NOTAM proxy did not return JSON.'); }
  if (!Array.isArray(data?.allNotams) || !Array.isArray(data?.filteredNotams)) {
    throw new Error('NOTAM proxy response is missing allNotams or filteredNotams.');
  }
  return {
    allNotams: data.allNotams.filter(item => typeof item === 'string'),
    filteredNotams: data.filteredNotams.filter(item => typeof item === 'string')
  };
}

function timestampFromMetar(raw) {
  const match = String(raw || '').match(/\b(\d{6}Z)\b/);
  return match ? match[1] : '';
}

function timestampFromTaf(raw) {
  const match = String(raw || '').match(/\bTAF\s+(?:(?:AMD|COR)\s+)?(?:[A-Z0-9]{4}\s+)?(\d{6}Z)\b/);
  return match ? match[1] : '';
}

function extractWindForTime(weatherText, targetTime) {
  if (!weatherText || typeof weatherText !== 'string') return [];
  const parseWind = text => {
    const match = text.match(/(?:^|\s)(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT(?=\s|$)/i);
    if (!match) return null;
    const speed = Number.parseInt(match[2], 10);
    const gust = match[3] ? Number.parseInt(match[3], 10) : speed;
    return {
      direction: match[1] === 'VRB' ? 0 : Number.parseInt(match[1], 10),
      variable: match[1] === 'VRB',
      speed,
      gust,
      raw: match[0].trim()
    };
  };

  if (!/\bTAF\b/.test(weatherText)) {
    const wind = parseWind(weatherText);
    return wind ? [{ ...wind, source: 'METAR' }] : [];
  }

  const validity = weatherText.match(/\b(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
  if (!validity) return [];
  const refDate = targetTime instanceof Date && !Number.isNaN(targetTime.getTime()) ? targetTime : new Date();
  const validityWindow = makeUtcInterval(refDate, Number(validity[1]), Number(validity[2]), Number(validity[3]), Number(validity[4]));
  if (!validityWindow) return [];
  const { start, end } = validityWindow;
  const target = refDate.getTime();

  const trigger = /\b(FM\d{6}|BECMG\s+\d{4}\/\d{4}|TEMPO\s+\d{4}\/\d{4}|PROB\d{2}(?:\s+TEMPO)?\s+\d{4}\/\d{4})/g;
  const blocks = [...weatherText.matchAll(trigger)].map(match => ({ index: match.index, text: match[1] }));
  const baseEnd = blocks.length ? blocks[0].index : weatherText.length;
  const baseWind = parseWind(weatherText.slice(0, baseEnd));
  const baselineChanges = [];
  const activeChanges = [];

  blocks.forEach((block, index) => {
    const nextIndex = blocks[index + 1]?.index ?? weatherText.length;
    const blockText = weatherText.slice(block.index, nextIndex);
    let blockStart;
    let blockEnd;
    let source;
    const fm = block.text.match(/^FM(\d{2})(\d{2})(\d{2})$/);
    const interval = block.text.match(/(\d{2})(\d{2})\/(\d{2})(\d{2})/);

    if (fm) {
      blockStart = resolveTafFmDate(start, end, Number(fm[1]), Number(fm[2]), Number(fm[3]));
      const nextFm = blocks.slice(index + 1).find(candidate => /^FM/.test(candidate.text));
      blockEnd = nextFm
        ? resolveTafFmDate(start, end, Number(nextFm.text.slice(2, 4)), Number(nextFm.text.slice(4, 6)), Number(nextFm.text.slice(6, 8)))
        : end;
      source = 'FM';
    } else if (interval) {
      const window = makeUtcIntervalNear(refDate, Number(interval[1]), Number(interval[2]), Number(interval[3]), Number(interval[4]));
      if (!window) return;
      blockStart = window.start;
      blockEnd = window.end;
      source = /^BECMG/.test(block.text) ? 'BECMG' : /^PROB/.test(block.text) ? 'PROB' : 'TEMPO';
    } else {
      return;
    }

    const wind = parseWind(blockText);
    if (!wind) return;
    if (source === 'FM') {
      if (target >= blockStart.getTime() && target < blockEnd.getTime()) {
        baselineChanges.push({ ...wind, source, effectiveTime: blockStart.getTime() });
      }
      return;
    }
    if (source === 'BECMG') {
      if (target >= blockStart.getTime() && target < blockEnd.getTime()) {
        activeChanges.push({ ...wind, source });
      } else if (target >= blockEnd.getTime()) {
        baselineChanges.push({ ...wind, source, effectiveTime: blockEnd.getTime() });
      }
      return;
    }
    if (target >= blockStart.getTime() && target < blockEnd.getTime()) activeChanges.push({ ...wind, source });
  });

  if (baseWind) baselineChanges.push({ ...baseWind, source: 'BASE', effectiveTime: start.getTime() });
  baselineChanges.sort((a, b) => b.effectiveTime - a.effectiveTime);
  const active = baselineChanges.length ? [baselineChanges[0]] : [];
  active.push(...activeChanges);
  return active;
}

function extractWindForWindow(weatherText, flightWindow) {
  if (!weatherText || !flightWindow || !/\bTAF\b/.test(weatherText)) return [];
  const sampleTimes = [new Date(flightWindow.start), new Date(flightWindow.end.getTime() - 1)];
  const trigger = /\b(FM\d{6}|BECMG\s+\d{4}\/\d{4}|TEMPO\s+\d{4}\/\d{4}|PROB\d{2}(?:\s+TEMPO)?\s+\d{4}\/\d{4})/g;
  for (const match of weatherText.matchAll(trigger)) {
    const group = match[1];
    const fm = group.match(/^FM(\d{2})(\d{2})(\d{2})$/);
    if (fm) {
      const time = resolveTafDayTime(new Date(flightWindow.start), Number(fm[1]), Number(fm[2]), Number(fm[3]), flightWindow);
      if (time && time >= flightWindow.start && time < flightWindow.end) sampleTimes.push(time);
      continue;
    }

    const range = group.match(/(\d{2})(\d{2})\/(\d{2})(\d{2})/);
    if (!range) continue;
    const interval = resolveTafRange(new Date(flightWindow.start), range.slice(1).map(Number), flightWindow);
    if (!interval) continue;
    const start = new Date(Math.max(interval.start.getTime(), flightWindow.start.getTime()));
    const end = new Date(Math.min(interval.end.getTime(), flightWindow.end.getTime()));
    if (start >= end) continue;
    sampleTimes.push(start, new Date(start.getTime() + (end.getTime() - start.getTime()) / 2), new Date(end.getTime() - 1));
  }

  const winds = new Map();
  for (const sampleTime of sampleTimes) {
    for (const wind of extractWindForTime(weatherText, sampleTime)) {
      const key = `${wind.direction}:${wind.speed}:${wind.gust}:${wind.variable}:${wind.source}`;
      winds.set(key, wind);
    }
  }
  return [...winds.values()];
}

function makeUtcInterval(reference, startDay, startHour, endDay, endHour, startMinute = 0, endMinute = 0) {
  const target = reference.getTime();
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();
  const candidates = [];
  for (let startOffset = -1; startOffset <= 1; startOffset++) {
    const interval = makeUtcDayInterval(year, month, startOffset, startDay, startHour, endDay, endHour, startMinute, endMinute);
    if (interval && target >= interval.start.getTime() && target < interval.end.getTime()) candidates.push(interval);
  }
  candidates.sort((a, b) => (a.end - a.start) - (b.end - b.start));
  return candidates[0] || null;
}

function makeUtcIntervalNear(reference, startDay, startHour, endDay, endHour) {
  const target = reference.getTime();
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();
  const intervals = [];
  for (let startOffset = -1; startOffset <= 1; startOffset++) {
    const interval = makeUtcDayInterval(year, month, startOffset, startDay, startHour, endDay, endHour);
    if (interval) intervals.push(interval);
  }
  const active = intervals.filter(interval => target >= interval.start.getTime() && target < interval.end.getTime());
  if (active.length) return active.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  const completed = intervals.filter(interval => interval.end.getTime() <= target);
  completed.sort((a, b) => b.end - a.end);
  return completed[0] || null;
}

function makeUtcDayInterval(year, month, startMonthOffset, startDay, startHour, endDay, endHour, startMinute = 0, endMinute = 0) {
  const start = new Date(Date.UTC(year, month + startMonthOffset, startDay, startHour, startMinute, 0));
  const endMonthOffset = startMonthOffset + (endDay < startDay ? 1 : 0);
  const end = new Date(Date.UTC(year, month + endMonthOffset, endDay, endHour, endMinute, 0));
  if (end <= start && endDay === startDay) end.setUTCDate(end.getUTCDate() + 1);
  return end > start ? { start, end } : null;
}

function resolveTafFmDate(validityStart, validityEnd, day, hour, minute = 0) {
  const candidates = [];
  for (let offset = -1; offset <= 1; offset++) {
    const date = new Date(Date.UTC(validityStart.getUTCFullYear(), validityStart.getUTCMonth() + offset, day, hour, minute, 0));
    if (date >= validityStart && date <= validityEnd) candidates.push(date);
  }
  candidates.sort((a, b) => a - b);
  return candidates[0] || new Date(NaN);
}

async function refreshAll(options = {}) {
  const activeAirports = state.nearbyMode ? [] : airportsInActiveGroup();
  const activeCodes = new Set(activeAirports.map(airport => airport.icao));
  const permanentCodes = new Set(BUILTIN_GROUPS.flatMap(group => group.airports));
  const otherAirports = state.airports.filter(airport => !activeCodes.has(airport.icao) && !airport.builtinOnly);
  const otherCodes = new Set(otherAirports.map(airport => airport.icao));
  const permanentAirports = state.airports.filter(airport => permanentCodes.has(airport.icao) && airport.builtinOnly && !activeCodes.has(airport.icao) && !otherCodes.has(airport.icao));
  const total = new Set([...activeAirports, ...permanentAirports, ...otherAirports].map(airport => airport.icao)).size;
  if (!total) {
    if (!options.quiet) showStatus('Add an airport before refreshing the weather.');
    return;
  }
  if (!options.quiet) showStatus(`Refreshing the active tab first (${activeAirports.length} airport${activeAirports.length === 1 ? '' : 's'}); country tabs follow shortly…`);

  let notamFailures = 0;
  if (activeAirports.length) {
    notamFailures += await refreshAirportBatch(activeAirports, {
      quiet: true,
      render: false,
      builtIn: Boolean(state.activeGroup && isBuiltinGroup(state.activeGroup)),
      skipNotams: false
    });
  }

  if (otherAirports.length) {
    if (!options.quiet) showStatus('Active tab refreshed. Updating your other airport tabs…');
    notamFailures += await refreshAirportBatch(otherAirports, { quiet: true, render: false });
  }

  if (permanentAirports.length) {
    if (!options.quiet) showStatus('Your airport tabs refreshed. Updating All Sweden, All Finland and All Norway…');
    await new Promise(resolve => setTimeout(resolve, 2000));
    notamFailures += await refreshAirportBatch(permanentAirports, { quiet: true, render: false, builtIn: true });
  }

  renderCards();
  if (!options.quiet) showStatus(notamFailures
    ? `Weather updated, but NOTAM refresh failed for ${notamFailures} airport${notamFailures === 1 ? '' : 's'}; saved data was kept.`
    : 'Weather update complete across all groups.', Boolean(notamFailures));
}

async function refreshAirportBatch(airports, options = {}) {
  const uniqueAirports = [...new Map(airports.map(airport => [airport.icao, airport])).values()];
  if (!uniqueAirports.length) return;
  let next = 0;
  let notamFailures = 0;
  const workers = Array.from({ length: Math.min(6, uniqueAirports.length) }, async () => {
    while (next < uniqueAirports.length) {
      const airport = uniqueAirports[next++];
      const builtIn = options.builtIn || airport.builtinOnly;
      const result = await refreshAirport(airport.icao, {
        quiet: true,
        renderStart: false,
        renderFinish: false,
        skipNotams: options.skipNotams ?? builtIn,
        skipRunways: options.skipRunways ?? builtIn
      });
      if (result?.notamFailed) notamFailures += 1;
    }
  });
  const refreshes = Promise.all(workers);
  renderCards();
  await refreshes;
  if (options.render !== false) renderCards();
  return notamFailures;
}

function updateAirportGroupMembership(input) {
  const { membershipIcao: icao, membershipGroup: groupId } = input.dataset;
  const group = state.groups.find(item => item.id === groupId);
  const airport = state.airports.find(item => item.icao === icao);
  if (!group || !airport) return;
  if (!input.checked) {
    if (isBuiltinGroup(groupId)) { input.checked = true; return; }
    const membershipCount = state.groups.filter(item => !isBuiltinGroup(item.id) && item.airports.includes(icao)).length;
    if (membershipCount <= 1) {
      input.checked = true;
      showStatus(`${icao} must remain in at least one group.`, true);
      return;
    }
    group.airports = group.airports.filter(code => code !== icao);
    if (BUILTIN_AIRPORT_ICAOS.has(icao) && !state.groups.some(item => !isBuiltinGroup(item.id) && item.airports.includes(icao))) airport.builtinOnly = true;
  } else if (!group.airports.includes(icao)) {
    if (!isBuiltinGroup(groupId)) airport.builtinOnly = false;
    group.airports.push(icao);
  }
  saveState();
  // Refresh the card's membership checkboxes and the tab counts together.
  // A card can belong to multiple groups, so do not treat checking one group
  // as moving it out of whichever group was previously selected.
  render();
}

function reorderVisibleAirports(sourceIcao, targetIcao) {
  if (!sourceIcao || sourceIcao === targetIcao) return;
  const ordered = airportsInActiveGroup().slice();
  const visibleIds = new Set(ordered.map(airport => airport.icao));
  const from = ordered.findIndex(airport => airport.icao === sourceIcao);
  const to = ordered.findIndex(airport => airport.icao === targetIcao);
  if (from < 0 || to < 0) return;
  ordered.splice(to, 0, ordered.splice(from, 1)[0]);
  let visibleIndex = 0;
  state.airports = state.airports.map(airport => visibleIds.has(airport.icao) ? ordered[visibleIndex++] : airport);
  saveState();
  render();
}

function reorderGroups(sourceGroupId, targetGroupId) {
  if (!sourceGroupId || sourceGroupId === targetGroupId) return;
  const order = getSidebarTabIds();
  const from = order.indexOf(sourceGroupId);
  const to = order.indexOf(targetGroupId);
  if (from < 0 || to < 0) return;
  order.splice(to, 0, order.splice(from, 1)[0]);
  state.tabOrder = order;
  saveState();
  renderSidebar();
}

function getSidebarTabIds() {
  const valid = new Set(state.groups.map(group => group.id));
  const order = state.tabOrder.filter(id => valid.has(id));
  for (const id of valid) if (!order.includes(id)) order.push(id);
  return order;
}

function createGroupFromSelection() {
  const name = window.prompt('What should the group be called?');
  if (!name || !name.trim()) return;
  const group = { id: createGroupId(), name: name.trim().slice(0, 48), airports: [...state.selected] };
  state.groups.push(group);
  state.airports.forEach(airport => { if (group.airports.includes(airport.icao)) airport.builtinOnly = false; });
  state.selected.clear();
  state.activeGroup = group.id;
  saveState();
  render();
  showStatus(`Group ${group.name} created.`);
}

function beginGroupRename(groupId) {
  const group = state.groups.find(item => item.id === groupId);
  if (!group || isBuiltinGroup(group.id)) return;
  const row = document.querySelector(`[data-group-row="${CSS.escape(groupId)}"]`);
  if (!row || row.querySelector('.group-name-input')) return;
  const nameButton = row.querySelector('.group-item-name');
  const renameButton = row.querySelector('.group-rename');
  row.classList.add('editing');
  const input = document.createElement('input');
  input.className = 'group-name-input';
  input.type = 'text';
  input.maxLength = 48;
  input.value = group.name;
  input.setAttribute('aria-label', 'Group name');
  nameButton.replaceWith(input);
  const saveButton = document.createElement('button');
  saveButton.className = 'icon-button group-rename saving';
  saveButton.type = 'button';
  saveButton.textContent = '✓';
  saveButton.title = 'Save group name';
  saveButton.setAttribute('aria-label', 'Save group name');
  renameButton.replaceWith(saveButton);
  const cancel = document.createElement('button');
  cancel.className = 'icon-button group-rename-cancel';
  cancel.type = 'button';
  cancel.textContent = '×';
  cancel.title = 'Cancel';
  cancel.setAttribute('aria-label', 'Cancel renaming');
  saveButton.after(cancel);
  const save = () => {
    const trimmedName = input.value.trim().slice(0, 48);
  if (!trimmedName) {
    showStatus('Group name cannot be empty.');
      input.focus();
    return;
  }
    if (trimmedName === group.name) { renderSidebar(); return; }
  group.name = trimmedName;
  saveState();
  render();
  showStatus(`Group renamed to ${group.name}.`);
  };
  saveButton.addEventListener('click', save);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); save(); }
    if (event.key === 'Escape') renderSidebar();
  });
  cancel.addEventListener('click', () => renderSidebar());
  input.focus();
  input.select();
}

function deleteGroup(groupId) {
  const group = state.groups.find(item => item.id === groupId);
  if (!group || isBuiltinGroup(group.id)) return;
  state.groups = state.groups.filter(item => item.id !== groupId);
  ensureAirportGroupMembership();
  if (state.activeGroup === groupId) state.activeGroup = null;
  saveState();
  render();
  showStatus(`Group ${group.name} deleted.`);
}

function setSidebar(open) {
  state.sidebarOpen = open;
  document.getElementById('sidebar').classList.toggle('open', open);
  document.getElementById('sidebar').setAttribute('aria-hidden', String(!open));
  document.getElementById('sidebar-scrim').classList.toggle('visible', open && window.innerWidth < 1050);
  document.getElementById('open-sidebar').setAttribute('aria-expanded', String(open));
}
