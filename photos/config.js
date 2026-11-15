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

  // Wedding Missions. `day` (optional) must match an ALBUMS id to show a day label.
  MISSIONS: [
    { id: 'm01', icon: '💑', title: 'A selfie with the bride and groom',        hint: 'Find Nupur and Aditya and squeeze into the frame.' },
    { id: 'm02', icon: '🪩', title: 'Dancing like nobody\'s watching',          hint: 'Someone is giving it everything.' },
    { id: 'm03', icon: '💕', title: 'A sweet moment between the couple',        hint: 'A look, a hug, a little whisper.' },
    { id: 'm04', icon: '✨', title: 'The best-dressed guest',                   hint: 'You know exactly who it is.' },
    { id: 'm05', icon: '🤝', title: 'A selfie with someone you met today',      hint: 'New friend, new memory.' },
    { id: 'm06', icon: '🥹', title: 'Someone wiping away happy tears',          hint: 'Catch the emotional moment.' },
    { id: 'm07', icon: '🙏', title: 'Someone giving a blessing',                hint: 'A hand on the head, a quiet word.' },
    { id: 'm08', icon: '👯', title: 'Matching outfits',                         hint: 'Two or more people, same colours.' },
    { id: 'm09', icon: '🌸', title: 'Your favourite decor detail',              hint: 'Flowers, lights, the little things.' },
    { id: 'm10', icon: '🍛', title: 'The food you\'d come back for',            hint: 'That one dish you went back to twice.' },
    { id: 'm11', icon: '👨‍👩‍👧', title: 'A selfie with the couple\'s parents', hint: 'Find Nupur\'s or Aditya\'s mum and dad.' },
    { id: 'm12', icon: '🔥', title: 'The pheras from your seat',                hint: 'Your view of the seven rounds.' },
    { id: 'm13', icon: '📸', title: 'The biggest group photo you can manage',   hint: 'Round up everyone nearby.' },
    { id: 'm14', icon: '🪞', title: 'Your best "first look" outfit selfie',     hint: 'Show off the look before the party starts.' },
    { id: 'm15', icon: '🫶', title: 'A photo with someone from the other side of the family', hint: 'Bride\'s side, meet groom\'s side.' }
  ],

  // Starting schedule (from the invitation). Times are India time (IST).
  // Once live, edit it from the Schedule tab with your admin link; edits are saved in your Google Sheet.
  SCHEDULE: [
    { id: 'e01', icon: '🌿', title: 'Mehendi',            day: '2026-11-30', start: '18:30', end: '22:30', venue: 'RBI Colony, Hauz Khas' },
    { id: 'e02', icon: '💍', title: 'Engagement',         day: '2026-12-01', start: '19:00', end: '23:30', venue: 'Silver Oak Hall, India Habitat Centre' },
    { id: 'e03', icon: '🥁', title: 'Baraat welcome',     day: '2026-12-02', start: '15:00', end: '15:30', venue: 'Jhankar Banquets & Lawns' },
    { id: 'e04', icon: '💐', title: 'Varmala & pheras',   day: '2026-12-02', start: '15:30', end: '19:00', venue: 'Monument Lawn' },
    { id: 'e05', icon: '🥂', title: 'Reception & dinner', day: '2026-12-02', start: '19:00', end: '23:00', venue: 'Monument Lawn' },
    { id: 'e06', icon: '🙏', title: 'Vidai',              day: '2026-12-02', start: '23:00', end: '23:45', venue: 'Monument Lawn' }
  ],

  MAX_FILE_MB: 150,
  PARALLEL_UPLOADS: 2
};
