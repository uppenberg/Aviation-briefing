// LocalStorage Nyckel
const STORAGE_KEY = 'aviation_viewer_db';

// Standard-data om inget finns lagrat
const defaultData = {
  activeSheet: 'Standard',
  sheets: {
    'Standard': {
      depTime: 'NOW',
      arrTime: 'NOW',
      icaos: ['ESNU', 'ESSA']
    },
    '_DoldFlik': { // Döljs automatiskt p.g.a. understreck i namnet
      depTime: 'NOW',
      arrTime: 'NOW',
      icaos: ['ESGG']
    }
  },
  weatherCache: {},
  notamCache: {}
};

let db = loadDatabase();

window.onload = function() {
  renderApp();
};

// --- DATABASHANTERING (LOCALSTORAGE) ---
function loadDatabase() {
  const data = localStorage.getItem(STORAGE_KEY);
  return data ? JSON.parse(data) : defaultData;
}

function saveDatabase() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

// Hämtar synliga flikar (filtrerar bort alla som börjar med '_')
function getAllSheets() {
  return Object.keys(db.sheets).filter(name => !name.startsWith('_'));
}

// --- HUVUDKÖRNING/RENDERINGS-LOGIK ---
function renderApp(targetSheet) {
  if (targetSheet) {
    db.activeSheet = targetSheet;
  }
  
  const visibleSheets = getAllSheets();
  if (!visibleSheets.includes(db.activeSheet)) {
    db.activeSheet = visibleSheets[0] || '';
  }
  
  saveDatabase();

  const currentSheetData = db.sheets[db.activeSheet] || { depTime: 'NOW', arrTime: 'NOW', icaos: [] };

  // Uppdatera flikväljaren (visar endast synliga flikar)
  const selector = document.getElementById('sheetSelector');
  selector.innerHTML = '';
  visibleSheets.forEach(sheetName => {
    const opt = document.createElement('option');
    opt.value = sheetName;
    opt.text = sheetName;
    if (sheetName === db.activeSheet) opt.selected = true;
    selector.appendChild(opt);
  });

  // Tidsfält
  setupTimeInput('depTime', currentSheetData.depTime);
  setupTimeInput('arrTime', currentSheetData.arrTime);

  // Bygg tabell
  renderTable(currentSheetData.icaos);
}

function renderTable(icaos) {
  const contentDiv = document.getElementById('content');
  if (!icaos || icaos.length === 0) {
    contentDiv.innerHTML = 'Inga flygplatser hittades i fliken "' + db.activeSheet + '".';
    contentDiv.classList.remove('loading');
    return;
  }

  let html = '<div class="table-container"><table>';
  html += '<tr><th class="col-icao">ICAO</th><th class="col-metar">METAR</th><th class="col-taf">TAF</th><th class="col-notam">NOTAM</th></tr>';

  icaos.forEach(icao => {
    const wData = (db.weatherCache[icao]) || {};
    const notamData = (db.notamCache[icao]) || [];

    const metarHtml = wData.metarHtml || '<span style="color:#aaa;">-</span>';
    const tafHtml = wData.tafHtml || '<span style="color:#aaa;">-</span>';
    const metarNote = wData.metarNote || '';
    const tafNote = wData.tafNote || '';

    const metarClass = 'col-metar ' + (metarNote ? 'has-note' : '');
    const metarAttr = metarNote ? 'data-note="' + escapeHtml(metarNote) + '"' : '';

    const tafClass = 'col-taf ' + (tafNote ? 'has-note' : '');
    const tafAttr = tafNote ? 'data-note="' + escapeHtml(tafNote) + '"' : '';

    let notamCellHtml = "";
    if (notamData && notamData.length > 0) {
      notamData.forEach((notamText, n) => {
        notamCellHtml += '<div class="has-note notam-badge" data-note="' + escapeHtml(notamText) + '">📌 ' + (n + 1) + '</div>';
      });
    } else {
      notamCellHtml = '<span style="color: #aaa;">-</span>';
    }

    html += '<tr>';
    html += '<td class="col-icao" onclick="toggleDeleteButton(\'btn-' + icao + '\')">';
    html += '<span>' + icao + '</span>';
    html += '<button id="btn-' + icao + '" class="delete-row-btn" onclick="handleDeleteIcao(event, \'' + icao + '\')">❌</button>';
    html += '</td>';
    html += '<td class="' + metarClass + '" ' + metarAttr + '>' + metarHtml + '</td>';
    html += '<td class="' + tafClass + '" ' + tafAttr + '>' + tafHtml + '</td>';
    html += '<td class="col-notam">' + notamCellHtml + '</td>';
    html += '</tr>';
  });

  html += '</table></div>';
  contentDiv.innerHTML = html;
  contentDiv.classList.remove('loading');
}

// --- FLIK- OCH ICAO-HANTERING ---
function handleSheetChange() {
  const selected = document.getElementById('sheetSelector').value;
  renderApp(selected);
}

function handleCreateSheet() {
  const nameInput = document.getElementById('newSheetName');
  const sheetName = nameInput.value.trim();
  if (!sheetName) return;

  if (db.sheets[sheetName]) {
    alert("En flik med detta namn finns redan.");
    return;
  }

  db.sheets[sheetName] = {
    depTime: 'NOW',
    arrTime: 'NOW',
    icaos: []
  };

  nameInput.value = '';
  showStatus('✔ Fliken "' + sheetName + '" skapad!', 'green');
  
  // Om den skapades med '_' döljs den automatiskt från väljaren
  if (sheetName.startsWith('_')) {
    alert('Fliken skapades men är dold eftersom den börjar med "_".');
    renderApp();
  } else {
    renderApp(sheetName);
  }
}

function handleDeleteSheet() {
  const visibleSheets = getAllSheets();
  if (visibleSheets.length <= 1) {
    alert("Du kan inte ta bort den sista synliga fliken.");
    return;
  }

  const confirmed = confirm("⚠️ VARNING: Är du säker på att du vill ta bort hela fliken \"" + db.activeSheet + "\"?");
  if (!confirmed) return;

  delete db.sheets[db.activeSheet];
  const remainingSheets = getAllSheets();
  
  showStatus('✔ Fliken har tagits bort.', 'green');
  renderApp(remainingSheets[0]);
}

function handleAddIcao() {
  const input = document.getElementById('newIcao');
  const icao = input.value.trim().toUpperCase();
  if (!icao || !/^[A-Z0-9]{4}$/.test(icao)) {
    alert("Ange en giltig ICAO-kod (4 tecken).");
    return;
  }

  const currentIcaos = db.sheets[db.activeSheet].icaos;
  if (!currentIcaos.includes(icao)) {
    currentIcaos.push(icao);
    saveDatabase();
  }

  input.value = '';
  showStatus('✔ ' + icao + ' tillagd!', 'green');
  renderApp();
  handleUpdateWeather();
}

function handleDeleteIcao(event, icao) {
  event.stopPropagation();
  const confirmed = confirm("Är du säker på att du vill ta bort " + icao + "?");
  if (!confirmed) return;

  const currentIcaos = db.sheets[db.activeSheet].icaos;
  db.sheets[db.activeSheet].icaos = currentIcaos.filter(code => code !== icao);
  saveDatabase();

  showStatus('✔ ' + icao + ' har tagits bort.', 'green');
  renderApp();
}

function handleSaveTimes() {
  const depInput = document.getElementById('depTime').value.trim();
  const arrInput = document.getElementById('arrTime').value.trim();

  db.sheets[db.activeSheet].depTime = depInput.toUpperCase() === "NOW" ? "NOW" : depInput;
  db.sheets[db.activeSheet].arrTime = arrInput.toUpperCase() === "NOW" ? "NOW" : arrInput;

  saveDatabase();
  showStatus('✔ Flight times sparade!', 'green');
  handleUpdateWeather();
}

// --- DIREKT API-HÄMTNING ---
async function handleUpdateWeather() {
  const icaos = db.sheets[db.activeSheet].icaos;
  if (!icaos || icaos.length === 0) return;

  showStatus('Uppdaterar METAR & TAF via NOAA/AviationWeather...', 'loading');

  try {
    const icaoStr = icaos.join(',');
    
    const [metarRes, tafRes] = await Promise.all([
      fetch(`https://aviationweather.gov/api/data/metar?ids=${icaoStr}&format=raw`),
      fetch(`https://aviationweather.gov/api/data/taf?ids=${icaoStr}&format=raw`)
    ]);

    const metarText = await metarRes.text();
    const tafText = await tafRes.text();

    icaos.forEach(icao => {
      if (!db.weatherCache[icao]) db.weatherCache[icao] = {};

      const metarMatch = metarText.split('\n').find(l => l.includes(icao));
      const tafMatch = tafText.split('\n').find(l => l.includes(icao));

      db.weatherCache[icao].metarHtml = metarMatch ? escapeHtml(metarMatch) : 'Ingen METAR';
      db.weatherCache[icao].tafHtml = tafMatch ? escapeHtml(tafMatch) : 'Ingen TAF';
    });

    saveDatabase();
    showStatus('✔ METAR & TAF uppdaterat!', 'green');
    renderApp();
  } catch (err) {
    showStatus('Fel vid hämtning av väder: ' + err.message, 'red');
  }
}

async function handleUpdateNotams() {
  showStatus('NOTAM-hämtning kräver anpassat API-anrop eller proxy...', 'loading');
  setTimeout(() => {
    showStatus('✔ NOTAM uppdaterade (Simulerad).', 'green');
  }, 1000);
}

// --- HJÄLPFUNKTIONER ---
function setupTimeInput(id, value) {
  const input = document.getElementById(id);
  input.value = value || "NOW";

  if (input.value.toUpperCase() === "NOW") {
    input.classList.add("is-now");
  } else {
    input.classList.remove("is-now");
  }

  input.onfocus = function() {
    if (this.value.toUpperCase() === "NOW") {
      this.value = "";
      this.classList.remove("is-now");
    }
  };

  input.onblur = function() {
    if (this.value.trim() === "") {
      this.value = "NOW";
      this.classList.add("is-now");
    }
  };
}

function toggleDeleteButton(btnId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.style.display = btn.style.display === 'inline-block' ? 'none' : 'inline-block';
}

function showStatus(msg, type) {
  const statusDiv = document.getElementById('status');
  if (type === 'loading') {
    statusDiv.innerHTML = '<p class="loading">' + msg + '</p>';
  } else if (type === 'green') {
    statusDiv.innerHTML = '<p style="color: green; font-weight: bold; font-size: 12px;">' + msg + '</p>';
  } else if (type === 'red') {
    statusDiv.innerHTML = '<p style="color: red; font-weight: bold; font-size: 12px;">' + msg + '</p>';
  }
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, '&quot;');
}
