// The soundtrack that ships with the game: everything in music/.
//
// Vite resolves this glob at build time into real, hashed asset URLs, so
// "adding a built-in track" is just dropping a file into that folder — there
// is no registry here to keep in step with it.
const files = import.meta.glob('../../music/*.{mp3,wav}', { eager: true, query: '?url', import: 'default' });

// `01-cathedral-of-ash.mp3` -> `Cathedral of Ash`. The numeric prefix is a
// sort key, not part of the title, so it doesn't belong on screen.
function titleOf(file) {
  return file
    .replace(/\.[^.]+$/, '')
    .replace(/^\d+[-_ ]*/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b(Of|The|And|A|An|In|On)\b/g, (w) => w.toLowerCase())
    .replace(/^./, (c) => c.toUpperCase());
}

export const BUNDLED_TRACKS = Object.entries(files).map(([path, url]) => {
  const file = path.split('/').pop();
  return {
    id: `b:${file}`,
    name: titleOf(file),
    sortKey: file,
    url,
    source: 'bundled',
    size: 0,
    duration: 0,
  };
});
