// The page's only network access: the generated files next to it, by
// relative URL (Pages serves the site under /sportbonnii/).

const FILES = ['events', 'clubs', 'sports', 'status', 'meta'];

async function getJson(name) {
  const res = await fetch(`data/${name}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`data/${name}.json: HTTP ${res.status}`);
  return res.json();
}

/** { events, window, clubs, platforms, sports, status, meta } */
export async function loadData() {
  const [events, clubs, sports, status, meta] = await Promise.all(FILES.map(getJson));
  return {
    events: events.events,
    window: events.window,
    clubs: clubs.clubs,
    platforms: clubs.platforms,
    sports: sports.sports,
    status,
    meta,
  };
}
