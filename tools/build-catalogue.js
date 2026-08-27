// BUILD STEP: the full hotel catalogue of pingwin.co.il → data/catalogue.json
//
// Why this exists (Tomer, 26/08/2026): until now the bot knew exactly 40
// hotels — the ones that carry room commitments in the winter 26/27 workbook.
// Everything else Pingwin sells was invisible: a customer asking for St. Anton
// was answered with Ischgl and Mayrhofen, because the resort had no hotels in
// our data at all.
//
// Tomer's rule: on dates that are not under a "מכירת התחייבויות בלבד"
// restriction, hotels OUTSIDE the commitments table can be sold — subject to
// confirmation with the hotel. So the bot needs to know they exist.
//
// What this file is NOT: availability. A catalogue hotel has no free rooms,
// no dates and no price here. It can be named ("בסנט אנטון אנחנו עובדים עם
// קרל שרנץ ונסראיינרהוף") and handed to a rep — never quoted.
//
// Source: the destination pages on pingwin.co.il, read on 26/08/2026:
//   /חופשת סקי באוסטריה.html · /חופשת סקי בצרפת.html
//   /חופשת סקי באנדורה.html  · /חופשת סקי בבולגריה.html
// Each row below is that page's own hotel name, siteID and board line, copied
// verbatim. Excluded on Tomer's instruction: Club Med, and the private chalets
// (the "N אורחים על בסיס לינה בלבד" whole-house rentals). Italy is an
// information page with no bookable hotels, so nothing was taken from it.
//
// Run: node tools/build-catalogue.js

const fs = require('fs');
const path = require('path');

// [name, siteID, resort, board line as the site writes it]
const AUSTRIA = {
  'Mayrhofen': [
    ['Sport & Spa Hotel Strass', 269, 'ארוחת בוקר או חצי פנסיון, עד 4 אורחים'],
    ['Hotel Ferienhof', 2116, 'חדרים זוגיים ולשלושה אורחים'],
    ['Alpenhof Kristal', 1408, 'חדרים 2-3 על בסיס ארוחת בוקר'],
    ['Hotel Waldheim', 1897, 'חדר זוגי על בסיס ארוחת בוקר'],
    ['Post Residence', 1528, 'לינה, ארוחת בוקר או חצי פנסיון, עד 8 אורחים'],
    ['Berghof Hotel', 1246, 'חצי פנסיון'],
    ['Der Siegeler', 985, 'ארוחת בוקר'],
    ['Landhaus Roscher', 2079, 'לינה וארוחת בוקר'],
    ['Pension Kumbi', 1966, 'ארוחת בוקר'],
    ['Hotel Strolz', 1917, 'חצי פנסיון'],
    ['Apartment Tuxer', 2080, 'עד 5 אורחים, לינה בלבד'],
  ],
  'Ischgl': [
    ['Hotel Fliana - Ischgl', 363, 'חצי פנסיון, עד 4 בחדר'],
    ['Sporthotel Silvretta', 1590, '5 כוכבים, ארוחת בוקר, עד 6 אורחים'],
    ['Madlein', 1374, 'ארוחת בוקר'],
    ['Kristall Hotel', 1359, 'לינה וארוחת בוקר, עד 3 אורחים'],
    ['Montanara', 1581, 'חדרים ודירות עד 8 אורחים, לינה וארוחת בוקר'],
    ['Schlosshof', 1257, 'ארוחת בוקר, עד 3 אורחים'],
    ['Mutmanor', 1234, 'לינה וארוחת בוקר, 2-3 אורחים'],
    ['Garni Castel', 2093, 'ארוחת בוקר'],
    ['Solaria Ischgl', 2097, 'חצי פנסיון'],
    ['Hotel Arnika', 2114, 'חדרים עד 4 אורחים, ארוחת בוקר'],
  ],
  'Saalbach': [
    ['Alpin Resort & Spa', 168, 'פנסיון מלא + כיבוד אפרה סקי + שתייה קלה וחריפה חופשי'],
    ['Hotel Die Sonne', 1624, 'הכל כלול + שתייה קלה חמה וחריפה חופשית'],
    ["Sport Hotel Berger's", 1458, 'חצי פנסיון, עד 4 אורחים בחדר'],
    ['Saalbacher Hof', 2007, 'חצי פנסיון'],
    ['Panther Hotel', 1260, 'חצי פנסיון, חדרים לעד 3 אורחים'],
    ['Konig Hotel', 1370, 'חצי פנסיון, רוב החדרים ל-2-3 אורחים'],
    ['JUFA Alpenhotel Saalbach', 1985, 'חצי פנסיון, עד 2 אורחים בחדר'],
  ],
  'Hinterglemm': [
    ['Dorfhotel Glucksschhmiede', 407, 'עד 4 אורחים, ארוחת בוקר'],
    ['Almrausch Hotel', 2096, 'עד 4 אורחים, חצי פנסיון'],
  ],
  'St. Anton': [
    ['Karl Schranz', 739, 'חצי פנסיון, עד 3 נופשים בחדר'],
    ['Hotel Nassereinerhof', 1251, 'חצי פנסיון, חדרים לאירוח של עד 5'],
  ],
  'Zell am See': [
    ['St Georg Hotel', 285, 'ארוחת בוקר, עד 4 בחדר'],
    ['Hotel Lebzelter', 741, 'לינה וארוחת בוקר, עד 3 אורחים'],
    ['Der Schmittenhof', 1537, 'חצי פנסיון, עד 4 אורחים'],
    ['Botique Hotel Martha', 1538, 'לינה וארוחת בוקר, עד 4 אורחים'],
    ['Der Schutthof', 1671, 'ארוחת בוקר, אפשרות לחצי פנסיון'],
    ['Hotel Latini', 1672, 'ארוחת בוקר'],
    ['Hotel Neue Post', 1826, 'לינה וארוחת בוקר, עד 4 בחדר'],
    ['Salzburgerhof Zell', 2153, 'חצי פנסיון + כיבוד צהריים אפרה סקי'],
    ['AlpenParks Apart Central', 2127, 'דירות מאובזרות, 4-8 אורחים'],
  ],
  'Katschberg': [
    ['Falkensteiner Club Funimation', 2154, 'הכל כלול'],
  ],
};

const FRANCE = {
  'Val Thorens': [
    ['Plein Sud', 1288, 'לינה בלבד, ארוחת בוקר או חצי פנסיון'],
    ['Hotel Kashmir', 1665, 'ארוחת בוקר'],
    ['Residence Kashmir', 1974, 'דירות עם מטבחון'],
    ['Residence Montana', 1293, 'לינה בלבד, יחידות עם מטבחון'],
    ['Cheval Blanc', 1292, 'לינה בלבד, אפשרות לארוחת בוקר או חצי פנסיון'],
    ['Oxalys Residence', 1402, 'לינה בלבד, יחידות לעד 8 אורחים'],
    ['Les Balcons Val Thorens', 1386, 'דירות לאירוח של עד 18 אורחים'],
    ['Hotel 3 Vallees', 1299, 'ארוחת בוקר, עד 4 בחדר'],
    ['Fitz Roy', 919, 'חצי פנסיון, עד 4 בחדר'],
    ['Tourotel Appart', 817, 'לינה בלבד, יחידות לעד 6 אורחים'],
    ['Pashmina', 1439, 'חדרים עד 6 אורחים ודירות עד 10'],
    ['Le Val Thorens', 1451, 'חצי פנסיון, חדרים לעד 4 אורחים'],
    ['Le Sherpa', 1478, 'ארוחת בוקר, חצי פנסיון או פנסיון מלא'],
    ['Fahrenheit 7', 1502, 'לינה וארוחת בוקר'],
  ],
  'Tignes': [
    ['Club Belambra Val claret', 2152, 'הכל כלול'],
    ['Residence Ynycio', 1973, 'מלון דירות, לינה בלבד'],
    ['Hameau du Borsat', 454, 'לינה בלבד, עד 6 בדירה'],
    ['Residence Le Taos', 1992, 'לינה בלבד'],
    ['CGH La Ferme du Val Claret', 1791, 'דירות, לינה בלבד'],
    ['CGH Le Nevada', 1788, 'דירות, לינה בלבד'],
    ['CGH Telemark', 1775, 'דירות, לינה בלבד'],
    ['Hotel Le Taos', 1460, 'לינה וארוחת בוקר'],
    ['Diva', 898, 'חצי פנסיון כולל יין בארוחות'],
  ],
  'Les Menuires': [
    ['Club Du Soleil L.M', 1195, 'פנסיון מלא ויין בארוחות'],
    ['Club Belambra Neige Et Ciel', 1289, 'חצי פנסיון, חדרים לעד 5 אורחים'],
    ['Club Belambra Les Bruyeres', 1436, 'חצי פנסיון, חדרים ל-3 מבוגרים'],
    ['Chalet Hotel Kaya', 1433, 'לינה וארוחת בוקר'],
  ],
  'Les Arcs': [
    ["Res' Prestige Edenarc", 1513, 'יחידות של 2 עד 8 אורחים'],
    ['Club Belambra Du Golf', 1440, 'הכל כלול'],
  ],
  "Alpe d'Huez": [
    ["Residence Prestige l'Eclose", 1962, 'לינה בלבד'],
    ['Royal Ours Blanc', 1605, 'ארוחת בוקר, עד זוג + 2 ילדים'],
    ['Prestige Residence Phoenix', 2099, 'חדרים עד 8 אורחים'],
    ["CGH Le Cristal de l'Alpe", 1790, 'דירות, לינה בלבד'],
    ['Pic Blanc', 1600, 'ארוחת בוקר, אפשרות לחצי פנסיון'],
  ],
  'Les 2 Alpes': [
    ['Club Du Soleil L2A', 1673, 'פנסיון מלא כולל יין בארוחות'],
    ['Club Belambra Les Cretes', 1844, 'הכל כלול'],
    ["Belambra L'Oree des Pistes", 1963, 'חצי פנסיון'],
    ['Hotel Les Melezes', 1783, 'חצי פנסיון, אפשרות לפנסיון מלא'],
  ],
  "Val d'Isere": [
    ["Kandahar Val D'isere", 2014, 'ארוחת בוקר'],
    ['Hotel Ski Lodge', 1916, 'חדרים לזוג ולשלושה, חצי פנסיון'],
    ['Hotel Ormelune', 1785, 'לינה וארוחת בוקר'],
    ['Hotel Avenue Lodge', 1577, 'ארוחת בוקר'],
  ],
  'La Plagne': [
    ['Res. Prestige Front de Neige', 2098, 'לינה בלבד'],
    ['CGH White Pearl Lodge & Spa', 1981, 'דירות עד 8 אורחים'],
    ['CGH Les Granges du Soleil', 1980, 'דירות עד 8 אורחים'],
    ['Les Balcons Belle Plagne', 1514, 'לינה בלבד, אפשרות לחצי פנסיון'],
    ['Terra Nova', 903, 'חצי פנסיון'],
  ],
  'Oz en Oisans': [['Club Du Soleil - Oz', 1278, 'פנסיון מלא ויין בארוחות']],
  'Flaine Grand Massif': [['Club Belambra - Panorama', 2048, 'הכל כלול']],
  'Avoriaz': [['Club Belambra Les Cimes', 1949, 'הכל כלול']],
  'Montgenevre': [['Club Du Soleil - Montgenevre', 2115, 'חדרים ל-1-4 אורחים, פנסיון מלא']],
};

const ANDORRA = {
  'Pas de la Casa': [
    ["Font D'argent Pas", 984, 'חצי פנסיון, אפשרות ל-3 אורחים בחדר'],
    ['Magic Pas', 444, 'חצי פנסיון, עד 4 אורחים בחדר'],
    ['Hotel Grand Pas', 445, 'חצי פנסיון'],
    ['Kandahar', 1045, 'ארוחת בוקר, עד 4 אורחים בחדר'],
    ['Camel Lot', 1294, 'חצי פנסיון'],
    ['Frontera Blanca Apart', 1661, 'דירות, לינה בלבד'],
  ],
  'Soldeu': [
    ['Lodge Park Hotel', 243, 'חצי פנסיון, עד 3 אורחים בחדר או זוג + שני ילדים'],
    ["Font D'argent Canillo", 857, 'חצי פנסיון, עד 3 בחדר'],
  ],
};

const BULGARIA = {
  'Bansko': [
    ['Vihren Royal Palace spa', 1107, 'ארוחת בוקר, סקי פס מקומי'],
    ['Casa Karina', 1435, 'חצי פנסיון + כיבוד קל ושתייה חופשית אחה"צ, חדרים לעד 5'],
    // the same hotel on a second page, for stays shorter than a week. It is a
    // booking page, not a hotel, and a customer asking about Bansko must never
    // be told about it as if it were one more option.
    ['Casa Karina Short Stay', 1445, 'חצי פנסיון + כיבוד קל ושתייה חופשית אחה"צ', 'Casa Karina'],
    ['Regnum Ski hotel & Spa', 1765, 'ארוחת בוקר, חדרים לעד 5, סקי פס מקומי'],
    ['Riverside Boutique Hotel', 1819, 'חצי פנסיון, חדרים לזוג עד זוג + שני ילדים'],
    ['MPM Sport Hotel', 2077, 'ארוחת בוקר או חצי פנסיון, חדרים עד 4 אורחים'],
    ['Grand Hotel Therme - Banya', 2078, 'חדרים זוגיים ודירות עד 8 אורחים, חצי פנסיון או הכל כלול'],
    ['Amira Hotel', 1503, 'חדרים וסוויטות לעד 3 מבוגרים, ארוחת בוקר או חצי פנסיון'],
    ['Hotel MPM Guiness', 1571, 'חצי פנסיון, חדרים לשניים ועד שישה'],
    ['Ores Boutique Hotel', 1914, 'ארוחת בוקר או חצי פנסיון, סקי פס מקומי'],
    ['Friends hotel', 2071, 'חצי פנסיון, סקי פס מקומי'],
    ['Four Points by Sheraton', 2074, 'סקי פס מקומי'],
  ],
  'Borovets': [
    ['Iceberg Hotel', 16, 'לינה וארוחת בוקר, סקי פס מקומי'],
    ['Hotel Rila', 1161, 'ארוחת בוקר או חצי פנסיון'],
    ['Hotel Iglika', 19, 'חצי פנסיון וכיבוד אפרה סקי קל, סקי פס מקומי'],
    ['Flora Hotel', 20, 'סקי פס מקומי'],
  ],
};

// one table for everyone — config/resort-names.json via data/resort-names.js
const { resortHe } = require('../data/resort-names.js');

const BY_COUNTRY = { austria: AUSTRIA, france: FRANCE, andorra: ANDORRA, bulgaria: BULGARIA };

// Which of these already carry room commitments — those are the ones the
// search can offer with a real date and a real room. The workbook writes hotel
// names its own way ("Strass", "Golf", "FONT PAS"), so the join is an explicit
// table rather than fuzzy matching: a wrong guess here would either hide rooms
// we have or promise rooms we do not.
// Left side: the name in data/availability.json (= the workbook).
// Right side: the name on the pingwin.co.il page.
const COMMITMENT_ALIAS = {
  // Mayrhofen — "מלון אחד עם שני אגפים: Strass ו-Sport"
  'Strass': 'Sport & Spa Hotel Strass', 'Sport': 'Sport & Spa Hotel Strass',
  'Hotel Ferienhof': 'Hotel Ferienhof', 'Alpenhof Kristal': 'Alpenhof Kristal',
  'Pension Kumbichlhof': 'Pension Kumbi', 'Waldheim': 'Hotel Waldheim',
  'Berghof': 'Berghof Hotel', 'Strolz': 'Hotel Strolz',
  'Landhaus Roscher': 'Landhaus Roscher', 'Tuxer': 'Apartment Tuxer',
  // Ischgl
  'SCHLOSSHOF': 'Schlosshof', 'Mutmanor': 'Mutmanor', 'Castel': 'Garni Castel',
  // Val Thorens
  'Cheval Blanc (allotment)': 'Cheval Blanc',
  'Res Village Montana (allotment)': 'Residence Montana',
  'Plein Sud (allotment)': 'Plein Sud',
  'Residence Oxalys': 'Oxalys Residence', 'Hotel Kashmir': 'Hotel Kashmir',
  // France — Belambra and Club du Soleil, as the workbook shortens them
  'Belambra Val Claret': 'Club Belambra Val claret',
  'Belambra Tignes Val Claret': 'Club Belambra Val claret',
  'Belambra Les Cretes L2A 1800': 'Club Belambra Les Cretes',
  "Belambra L'Oree des Pistes": "Belambra L'Oree des Pistes",
  'Golf': 'Club Belambra Du Golf',
  // the workbook names the massif, the site names the property; Flaine has one
  'Belambra Grand Massif': 'Club Belambra - Panorama',
  'Belambra Avoriaz': 'Club Belambra Les Cimes',
  'Edenarc - Arc 1800': "Res' Prestige Edenarc",
  "l'Eclose Alpe d'Huez": "Residence Prestige l'Eclose",
  'Ynycio': 'Residence Ynycio',
  'Club Soleil Oz': 'Club Du Soleil - Oz',
  'Club Soleil Les 2 Alpes': 'Club Du Soleil L2A',
  'Club Soleil Montgenevre': 'Club Du Soleil - Montgenevre',
  'Club Soleil Les Menuires': 'Club Du Soleil L.M',
  // Andorra
  'FONT PAS': "Font D'argent Pas", 'MAGIC PAS': 'Magic Pas',
  'GRAND PAS': 'Hotel Grand Pas', 'LODGE PARK (Allotment)': 'Lodge Park Hotel',
  // Bulgaria
  'Casa Karina': 'Casa Karina', 'Vihren': 'Vihren Royal Palace spa',
  'Regnum': 'Regnum Ski hotel & Spa', 'Rila': 'Hotel Rila',
};

function build() {
  const committed = new Map();   // catalogue name → the workbook names that feed it
  let workbookNames = [];
  try {
    workbookNames = [...new Set((require('../data/availability.json').units || []).map(u => u.hotel))];
  } catch (e) { console.error('no availability.json — every row will read as catalogue-only'); }
  for (const w of workbookNames) {
    const target = COMMITMENT_ALIAS[w];
    if (!target) { console.error('  ! no catalogue entry for workbook hotel: ' + w); continue; }
    committed.set(target, [...(committed.get(target) || []), w]);
  }

  const hotels = [];
  for (const [country, byResort] of Object.entries(BY_COUNTRY)) {
    for (const [resort, rows] of Object.entries(byResort)) {
      for (const [name, siteID, board_he, sameAs] of rows) {
        const hit = committed.get(name);
        hotels.push({
          name, siteID, resort, resort_he: resortHe(resort), country,
          board_he,
          // another booking page for a hotel already in this list — kept so the
          // link can reach it, hidden from everything a customer reads
          same_as: sameAs || null,
          // true = the workbook holds free rooms for it, so the search can offer
          // it with a date. false = we sell it, but only a rep can confirm.
          commitment: !!hit,
          commitment_names: hit || null,
          page: `https://www.pingwin.co.il/${encodeURIComponent(name).replace(/%20/g, '+')}.html?siteID=${siteID}`,
        });
      }
    }
  }
  return hotels;
}

const hotels = build();
const out = {
  _comment: 'כל המלונות שפינגווין מוכרת, מדפי היעדים ב-pingwin.co.il. לא כולל קלאב מד ולא כולל שאלה פרטיים (הוראת תומר, 26/08/2026).',
  _rule_he: 'מלון עם commitment=false אינו במאגר ההתחייבויות: אפשר להציע אותו בתאריכים שאינם תחת "מכירת התחייבויות בלבד", בכפוף לאישור מול המלון — אבל לעולם לא לצטט עליו זמינות, חדר או מחיר. הבוט מזכיר את שמו ומעביר לנציג.',
  _source: 'דפי היעדים ב-pingwin.co.il, נשלפו 26/08/2026',
  _generated_by: 'tools/build-catalogue.js',
  counts: {
    total: hotels.length,
    with_commitments: hotels.filter(h => h.commitment).length,
    catalogue_only: hotels.filter(h => !h.commitment).length,
    resorts: new Set(hotels.map(h => h.resort)).size,
  },
  hotels,
};
const P = path.join(__dirname, '..', 'data', 'catalogue.json');
fs.writeFileSync(P, JSON.stringify(out, null, 1));
console.log(`catalogue: ${out.counts.total} hotels in ${out.counts.resorts} resorts — ` +
  `${out.counts.with_commitments} with commitments, ${out.counts.catalogue_only} catalogue only`);
const byResort = {};
for (const h of hotels) (byResort[h.resort_he] = byResort[h.resort_he] || []).push(h.commitment ? 1 : 0);
for (const [r, xs] of Object.entries(byResort)) {
  console.log(`  ${r.padEnd(18)} ${String(xs.length).padStart(3)} (${xs.filter(Boolean).length} עם התחייבויות)`);
}
