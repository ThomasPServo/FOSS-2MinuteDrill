// The 32 NFL teams by nflverse abbreviation: place, nickname and two identifying colours
// (used for swatches, end zones and special-teams dots; no logos).

const TEAMS = {
  ARI: ['Arizona', 'Cardinals', '#97233f', '#ffb612'],
  ATL: ['Atlanta', 'Falcons', '#a71930', '#101820'],
  BAL: ['Baltimore', 'Ravens', '#241773', '#9e7c0c'],
  BUF: ['Buffalo', 'Bills', '#00338d', '#c60c30'],
  CAR: ['Carolina', 'Panthers', '#0085ca', '#101820'],
  CHI: ['Chicago', 'Bears', '#0b162a', '#c83803'],
  CIN: ['Cincinnati', 'Bengals', '#fb4f14', '#101820'],
  CLE: ['Cleveland', 'Browns', '#311d00', '#ff3c00'],
  DAL: ['Dallas', 'Cowboys', '#003594', '#869397'],
  DEN: ['Denver', 'Broncos', '#fb4f14', '#002244'],
  DET: ['Detroit', 'Lions', '#0076b6', '#b0b7bc'],
  GB: ['Green Bay', 'Packers', '#203731', '#ffb612'],
  HOU: ['Houston', 'Texans', '#03202f', '#a71930'],
  IND: ['Indianapolis', 'Colts', '#002c5f', '#a2aaad'],
  JAX: ['Jacksonville', 'Jaguars', '#006778', '#d7a22a'],
  KC: ['Kansas City', 'Chiefs', '#e31837', '#ffb81c'],
  LA: ['Los Angeles', 'Rams', '#003594', '#ffa300'],
  LAC: ['Los Angeles', 'Chargers', '#0080c6', '#ffc20e'],
  LV: ['Las Vegas', 'Raiders', '#101820', '#a5acaf'],
  MIA: ['Miami', 'Dolphins', '#008e97', '#fc4c02'],
  MIN: ['Minnesota', 'Vikings', '#4f2683', '#ffc62f'],
  NE: ['New England', 'Patriots', '#002244', '#c60c30'],
  NO: ['New Orleans', 'Saints', '#d3bc8d', '#101820'],
  NYG: ['New York', 'Giants', '#0b2265', '#a71930'],
  NYJ: ['New York', 'Jets', '#125740', '#ffffff'],
  PHI: ['Philadelphia', 'Eagles', '#004c54', '#a5acaf'],
  PIT: ['Pittsburgh', 'Steelers', '#ffb612', '#101820'],
  SEA: ['Seattle', 'Seahawks', '#002244', '#69be28'],
  SF: ['San Francisco', '49ers', '#aa0000', '#b3995d'],
  TB: ['Tampa Bay', 'Buccaneers', '#d50a0a', '#34302b'],
  TEN: ['Tennessee', 'Titans', '#0c2340', '#4b92db'],
  WAS: ['Washington', 'Commanders', '#5a1414', '#ffb612'],
};

/** Team info for an abbreviation; unknown codes get a neutral fallback. */
export function team(abbr) {
  const t = TEAMS[abbr];
  if (!t) return { abbr, place: abbr, name: abbr, full: abbr, color: '#55607a', alt: '#c9d1e0' };
  const [place, name, color, alt] = t;
  return { abbr, place, name, full: `${place} ${name}`, color, alt };
}

/** Relative luminance of a #rrggbb colour (0 dark … 1 light). */
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** Black or white, whichever reads better on `hex`. */
export const inkOn = (hex) => (luminance(hex) > 0.4 ? '#0b1020' : '#ffffff');
