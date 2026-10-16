// Inline SVG icons (stroke-based, 24px grid). No icon fonts, no external requests.

import { svgFrom } from './dom.js';

const PATHS = {
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  help: '<circle cx="12" cy="12" r="9.5"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.4-2.7 4.1"/><path d="M12 17.6h.01" stroke-width="2.6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  replay: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3 4v4.5h4.5"/>',
  forward: '<path d="M4 6l7 6-7 6zM13 6l7 6-7 6z"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9.5 2.5h5"/>',
  flame: '<path d="M12 22c4 0 7-2.7 7-6.6 0-4.1-3.3-6.3-4.4-10.4-2.4 1.8-3.4 4-3.2 6.4-1.6-.6-2.6-2-2.7-3.6C6.4 9.7 5 12.3 5 15.4 5 19.3 8 22 12 22z"/>',
  whistle: '<circle cx="8.5" cy="14.5" r="5"/><path d="M12.5 11.5L21 6.5V10l-6 3.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  ratings: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16 16"/>',
};

/** An icon as an SVG element; decorative unless a label is given. */
export function icon(name, label) {
  const el = svgFrom(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`);
  if (label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  el.classList.add('icon', `icon-${name}`);
  return el;
}
