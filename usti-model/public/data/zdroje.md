# Zdroje dat — centrum Ústí nad Labem

Staženo 12. 11. 2026. Surová data jsou ve této složce, bbox je jen v `area.config.json`. Nové stažení: `npm run download`.

## Ohraničení

WGS84, západ–jih–východ–sever:

`14.0269, 50.655, 14.055, 50.668`

Počátek modelu je střed bboxu: 14.04095° E, 50.6615° N. Osa X míří na východ, Z na sever, jednotky jsou metry. Start hráče: Mírové náměstí, 14.040439° E, 50.660244° N (Wikipedie: 50°39′36,88″ s. š., 14°2′25,58″ v. d.).

## OpenStreetMap

- API: <https://overpass-api.de/api/interpreter>
- Časová značka planetárního výřezu: `2026-11-12T10:20:45Z` (stromy, parky a lesíky doplněny `2026-11-12T12:52:17Z`, ortofoto a DMR se znovu nestahovaly)
- Licence: [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/)
- Copyright z odpovědi API: „The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.“

| Soubor | Prvků | Obsah |
| --- | --- | --- |
| `buildings.geojson` | 2116 | budovy (`way`/`relation` s tagem `building`) |
| `highways.geojson` | 1543 | komunikace |
| `landuse.geojson` | 111 | využití ploch |
| `water.geojson` | 8 | `natural=water`, `waterway=river` a `riverbank` (Labe, Bílina, nádrže) |
| `trees.geojson` | 17 | `natural=tree`, `natural=wood`, `leisure=park` (stromořadí, parky a lesíky). Lesy v `landuse=forest` jsou v `landuse.geojson`. |

## Ortofoto

Aktuální ortofoto ČR z prohlížecí služby WMS-ORTOFOTO (ČÚZK), vrstva `0`, CRS EPSG:4326.

Přesný požadavek:

<https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=0&STYLES=&CRS=EPSG:4326&BBOX=50.655,14.0269,50.668,14.055&WIDTH=3605&HEIGHT=2613&FORMAT=image/jpeg&TRANSPARENT=FALSE>

- Soubor: `ortho.jpg`, 3605×2613 px, 1,7 MB, asi 0,55 m/px
- Georeference: `ortho.jgw` (světový soubor ve stupních, sever nahoře)
- Licence: [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)
- Podmínky ČÚZK: <https://cuzk.gov.cz/Predpisy/Podminky-poskytovani-prostor-dat-a-sitovych-sluzeb/Podminky-poskytovani-prostorovych-dat-CUZK.aspx>
- Uvedení zdroje: © ČÚZK. Letecký snímek je aktuální služba, rok snímkování jednotlivých dlaždic služba u výřezu neuvádí.

## Terén (DMR 5G)

Výšky jsou Digitální model reliéfu 5. generace (DMR 5G) z ImageServeru ČÚZK. Cesta `https://ags.cuzk.gov.cz/arcgis/rest/services/dmr5g` vrací 404 (služba tam není). Funguje server `arcgis2`:

<https://ags.cuzk.gov.cz/arcgis2/rest/services/dmr5g/ImageServer/exportImage?bbox=14.0269,50.655,14.055,50.668&bboxSR=4326&imageSR=4326&size=248,180&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image>

- Soubor: `terrain.json`, mřížka 248×180, asi 8 m na buňku, sever v prvním řádku. Export z ImageServeru má čtvercové pixely ve stupních, takže TIFF je vyšší než bbox a jeho roh leží severně od výřezu. `download.mjs` ho podle GeoTIFF přepočítá na bbox; jinak by se okolní svahy vmáčkly do severního a jižního okraje.
- Výškový systém: Balt po vyrovnání (Bpv)
- Rozsah ve výřezu: **133,3–265,1 m** n. m. Mírové náměstí vychází kolem 145 m, Labe kolem 134 m, severní svah (Mariánská skála) výrazně výš.
- Staženo 12. 11. 2026. Model vznikl z leteckého laserového skenování 2009–2013 (popis služby).
- Licence: [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/), zdroj © ČÚZK
- Podmínky: <https://cuzk.gov.cz/Predpisy/Podminky-poskytovani-prostor-dat-a-sitovych-sluzeb/Podminky-poskytovani-prostorovych-dat-CUZK.aspx>

DMR 1G ani SRTM nebylo potřeba. Nové `npm run download` stáhne i terén; samotný výškový model znovu stáhnete `node scripts/download.mjs --terrain-only`.
