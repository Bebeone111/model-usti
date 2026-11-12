# Model Ústí — centrum

Průchozí 3D model historického centra Ústí nad Labem. Půdorysy, ulice, chodníky, stromy a jména jsou z OpenStreetMap, terén je DMR 5G a ortofoto ČÚZK. Chodí se pěšky, auta v téhle verzi nejsou.

## Spuštění

```bash
npm install
npm run dev
```

Prohlížeč: [http://127.0.0.1:5173](http://127.0.0.1:5173)

Ovládání: **WASD** chůze (asi 3,6 m/s), **Shift** rychlý přesun (asi 280 m/s, centrum za pár sekund), **myš** rozhlížení (nejdřív kliknout do obrazu), **Esc** uvolní kurzor. Šipky otáčejí pohled i bez zamčené myši.

Data už jsou ve složce `public/data/` (Vite je zkopíruje do sestavené aplikace na `/data/`). Znovu je stáhnete pomocí `npm run download` (potřebuje síť).

## Jak zvětšit oblast

BBox je jen v souboru `area.config.json`:

```json
"bbox": { "west": 14.028, "south": 50.655, "east": 14.055, "north": 50.668 }
```

1. Upravte `west`, `south`, `east`, `north` (WGS84, stupně).
2. Spusťte `npm run download` — stáhne OSM, ortofoto i terén znovu, jen pro nový bbox.
3. Spusťte `npm run dev`.

Scéna se nemění. Počátek světa je střed bboxu, osa X míří na východ, Z na sever, jednotky jsou metry. Větší oblast znamená víc budov a větší JPEG; stahování drží ortofoto pod 40 MB.

`startHint` je místo, kde se hra snaží postavit hráče (teď Mírové náměstí). Když bod leží v budově nebo ve vodě, vybere se nejbližší volné místo na ulici.

## Data

Viz `public/data/zdroje.md` (adresy, licence, datum, přesný bbox).

## Co v1 záměrně neumí

Jednoduché výšky (tag `height`, jinak `building:levels` × 3 m, jinak 9 m, u garáží a kůlen 3,2 m) a stejný počet řad oken. Dveře jsou na straně do ulice. Střechy jsou ploché nebo valbové, fasáda není fotografie adresy. Kolize jen proti půdorysu (průchodem pod domem neprojdete), bez aut a interiérů.
