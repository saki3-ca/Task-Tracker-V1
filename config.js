// Configuration for external deployment (e.g. GitHub Pages / Vercel / AI Studio)
// When running inside Google Apps Script, google.script.run is used automatically.
// When hosted externally, set your published Web App URL below or use the in-app connection modal:
window.CONFIG = {
    // Replace with your Google Apps Script Web App exec URL
    // e.g. "https://script.google.com/macros/s/AKfycbx.../exec"
    // If left empty, the application automatically runs in Preview / Local Engine mode.
    APPS_SCRIPT_URL: localStorage.getItem('acnabin_apps_script_url') || ""
};

