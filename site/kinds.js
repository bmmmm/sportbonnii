// Event kinds: what a date is for. One list for the pipeline (classification,
// data contract), the page (filter chips, badges) and the feeds (CATEGORIES).
export const KINDS = [
  { id: 'spiel', label: 'Spiele & Wettkämpfe', short: 'Spiel', emoji: '🏆' },
  { id: 'training', label: 'Training', short: 'Training', emoji: '💪' },
  { id: 'veranstaltung', label: 'Veranstaltungen', short: 'Veranstaltung', emoji: '🎉' },
];
export const KIND_IDS = KINDS.map((k) => k.id);
/** What a venue can be reserved for; a venue without `use` serves both. */
export const VENUE_USES = ['spiel', 'training'];
