export const DATA_REV = '20261112v4';

const LABELS = {
  'buildings.geojson': 'Budovy',
  'highways.geojson': 'Ulice',
  'landuse.geojson': 'Plochy',
  'water.geojson': 'Voda',
  'trees.geojson': 'Stromy',
  'furniture.geojson': 'Mobiliář',
  'routes.geojson': 'Trolejbus',
  'pois.json': 'Místa',
  'railways.geojson': 'Železnice',
  'addresses.geojson': 'Adresy',
  'meta.json': 'Popis dat',
  'terrain.bin': 'Terén',
  'terrain-detail.bin': 'Terén břehů',
  'terrain.json': 'Terén',
  'ortho-mobile.jpg': 'Letecký snímek',
  'ortho.jpg': 'Letecký snímek',
};

export function dataUrl(file) {
  return `/data/${file}?v=${DATA_REV}`;
}

export function fileLabel(file) {
  return LABELS[file] || file;
}

export async function fetchBytes(file, onProgress) {
  const response = await fetch(dataUrl(file), { cache: 'force-cache' });
  if (!response.ok) {
    const hint = import.meta.env.DEV ? ' Ve složce aplikace spusťte npm run download.' : ' Zkuste stránku obnovit.';
    throw new Error(`Soubor ${fileLabel(file)} se nepodařilo načíst.${hint}`);
  }
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await response.arrayBuffer());
    onProgress?.(file, buf.length, buf.length);
    return buf;
  }
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(file, received, total || received);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function parseJson(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function loadOptionalJson(file, onProgress) {
  try {
    return parseJson(await fetchBytes(file, onProgress));
  } catch {
    return null;
  }
}
