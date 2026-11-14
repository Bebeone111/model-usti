# Model Ústí — centrum

Průchozí 3D model historického centra Ústí nad Labem. Půdorysy, ulice, chodníky, stromy a jména jsou z OpenStreetMap, terén je DMR 5G a ortofoto ČÚZK. Chodí se pěšky, auta v téhle verzi nejsou.

## Spuštění

```bash
npm install
npm run dev
```

Prohlížeč: [http://127.0.0.1:5173](http://127.0.0.1:5173)

Ovládání: **WASD** chůze (výchozí 14,4 m/s, dřívější Shift, posuvník 1–16), **Shift** nebo tlačítko Rychle asi dvojnásobek, **myš** rozhlížení (nejdřív kliknout do obrazu), **Esc** uvolní kurzor. Šipky otáčejí pohled i bez zamčené myši. Kolečko mění odstup kamery, **V** přepíná první osobu, **M** mapu, **E** kartu místa, **Tab** nápovědu. Jemnější terén při novém stažení: `npm run download -- --terrain-mpp=5` (výchozí je 8 m, nasazená mřížka zůstává u osmi metrů).

HTML žádá indexaci (`robots` a `robots.txt`). Nasazený hosting k tomu někdy přidá hlavičku `x-robots-tag: noindex`; tu z projektu nejde přepsat.

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

Jednoduché výšky (tag `height`, jinak RÚIAN podlaží × 3,1 m když jsou v datech, jinak `building:levels` × 3 m, jinak 9 m, u garáží a kůlen 3,2 m) a stejný počet řad oken. Dveře jsou na straně do ulice. Střechy jsou ploché nebo valbové, fasáda není fotografie adresy. Kolize jen proti půdorysu (průchodem pod domem neprojdete), bez aut a interiérů.

Přechody (`highway=crossing` v OSM) se přichytí na střed nejbližší vozovky a zebra jde napříč jízdním pruhem. Když v OSM u bodu žádná vozovka neleží, přechod zůstane na původních souřadnicích; v současném bboxu se tak nestalo.

## Poznámky k v5 (co se přeskočilo)

- **RÚIAN VFR/GML celé obce** se nestahuje. WFS budov v bboxu se při stažení zkouší; když selže, credit RÚIAN v patičce není. Adresy do hledání jdou z OSM.
- **Jemnější DMR 2–3 m/px** se nepřegenerovával; základ je ~8 m, břehy v `terrain-detail.bin` ~4 m. Hladina řek zůstává rovina. Severní břeh u soutoku může na strmém DMR ještě ukázat natažené ortofoto; terén se kvůli tomu nesnižuje, aby zůstal pochozí.
- **Živé WMTS dlaždice** kolem kamery nejsou. Zůstávají `ortho.jpg` / `ortho-mobile.jpg`.
- **Worker** na stavbu města není (Three.js meshe vznikají v hlavním vlákně po slice).
- **GTFS a živé GPS** DPmÚL nejsou. Trolejbusy jedou po OSM relacích; na nízké kvalitě se trasy nenačítají. Nastoupit jde z menu „Svézt se“.
- **Muzeum města** v bboxu nemá pojmenovaný OSM půdorys, proto v modelu není. Divadlo (way 79413889) ano.
- **Multiplayer** (blok F) a Mapillary / splat / GIS města (blok G) nejsou.
- **Pohled z vody** po pevné cestě není. Lanovka na Větruši je z fallback osy, pokud Overpass aerialway v bboxu nic nevrátí.
- **Vozovka na nábřeží** spojuje úseky Přístavní / Předmostí / Bílinské a nábřeží Labe i Bíliny, které OSM nechává s mezerami. Desky Mariánského mostu a mostu Beneše navazují na nábřeží ve stejné výšce. Terén se kvůli tomu neprohýbá, voda zůstává `usti-water-flat-v1`.
- **JednoÚstí** je na fasádě domu u 50.660869 N, 14.037110 E jako vlastní geometrická značka (ne kopie ochranné známky). Před ní je stylizovaná postava se stejným rigem jako hráč, bílá košile, modré brýle na čele; bez tváře, jména a titulu, mimo dveře.

## Poznámky k v4 (co se přeskočilo)

- **RÚIAN VFR/GML celé obce** se nestahuje — soubor obce Ústí je moc velký. Adresy do hledání jdou z OSM (`addr:street` + číslo popisné) po `npm run download`. Výšky pořád berou OSM `height`, pak RÚIAN podlaží pokud tag existuje, pak `building:levels`.
- **Živá ortofota WMTS kolem kamery** se nenačítají za běhu. Zůstávají dvě předgenerované úrovně `ortho.jpg` / `ortho-mobile.jpg` (současné ČÚZK, ne archiv CENIA).
- **Jemnější DMR 2–3 m/px** se nepřegenerovával; základ je ~8 m, břehy v `terrain-detail.bin` ~4 m. Hladina řek z terénu nekopíruje, je rovina.
- **Jízdní řády GTFS a živé GPS** DPmÚL nejsou — žádný scraping. Trolejbusy jedou po OSM relacích, na nízké kvalitě se trasy nenačítají.
- **Fotky z Wikimedia Commons** u karet míst se necachují (aby data nenarostla o desítky MB). Karty mají parafrázi a odkaz na OSM / Wikidata.
- **Mapillary / Panoramax, GIS města, DTM kraje, Google 3D Tiles, Střekov, ČHMÚ hladina, historické ortofoto** — záměrně ne.
- Hosting může pořád posílat `x-robots-tag: noindex`; `_headers` nastavuje cache jen pro `/data` a `/assets`.
