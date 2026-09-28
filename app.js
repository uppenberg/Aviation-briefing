const GAS_WEB_APP_URL = "HÄR_KLISTRAR_DU_IN_DIN_WEBBSPELAR_URL_FRÅN_GOOGLE";
const STORAGE_KEY = 'aviation_viewer_db';

let db = loadDatabase();

window.onload = function() {
  // Försök hämta färsk data från Google Sheets om vi är online
  if (navigator.onLine) {
    syncWithGoogleSheet();
  } else {
    renderApp();
    showStatus('⚠️ Offline-läge: Visar cachad data från senaste synk.', 'red');
  }
};

function loadDatabase() {
  const data = localStorage.getItem(STORAGE_KEY);
  return data ? JSON.parse(data) : { activeSheet: 'Standard', sheets: {} };
}

function saveDatabase() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

async function syncWithGoogleSheet() {
  showStatus('Synkar med Google Sheets...', 'loading');
  try {
    const response = await fetch(GAS_WEB_APP_URL);
    const serverData = await response.json();
    
    // Uppdatera lokal cache med det vi fick från Google Sheet
    db.sheets = serverData.sheets;
    
    // Om aktiv flik inte finns kvar, välj första bästa
    const visibleSheets = Object.keys(db.sheets);
    if (!db.activeSheet || !db.sheets[db.activeSheet]) {
      db.activeSheet = visibleSheets[0] || '';
    }

    saveDatabase();
    showStatus('✔ Synkad med Google Sheets!', 'green');
    renderApp();
  } catch (err) {
    showStatus('⚠️ Kunde inte nå Google Sheets. Använder lokal cache.', 'red');
    renderApp(); // Fallback till det som finns sparat lokalt
  }
}
