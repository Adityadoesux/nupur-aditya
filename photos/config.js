/* Edit this file to configure the photos page. */
window.WP_CONFIG = {
  // Paste your Apps Script Web App URL here after deploying (ends in /exec).
  // Leave empty to run the page in demo mode with sample photos.
  SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwkcAWt7XHmbEL7zxRuiisJLpqdAW1L928ZTAON6XiBsucRcmpvJft17gBx24ZjzvM5/exec',

  COUPLE: 'Nupur & Aditya',

  // Must match ALBUMS in apps-script/Code.gs (same names, same order).
  ALBUMS: [
    { id: 'Mehendi',    label: 'Mehendi',    date: '2026-11-30', when: '30 Nov' },
    { id: 'Engagement', label: 'Engagement', date: '2026-12-01', when: '1 Dec' },
    { id: 'Wedding',    label: 'Wedding',    date: '2026-12-02', when: '2 Dec' }
  ],

  MAX_FILE_MB: 150,
  PARALLEL_UPLOADS: 2
};
