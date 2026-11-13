import * as THREE from 'three';

const LAT = (50.66 * Math.PI) / 180;

function pragueParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

function sunState(date) {
  const parts = pragueParts(date);
  const start = Date.UTC(parts.year, 0, 0);
  const now = Date.UTC(parts.year, parts.month - 1, parts.day);
  const n = Math.round((now - start) / 86400000);
  const decl = ((23.44 * Math.PI) / 180) * Math.sin((2 * Math.PI * (284 + n)) / 365);
  const hour = parts.hour + parts.minute / 60;
  const ha = ((hour - 12) * 15 * Math.PI) / 180;
  parts.solarHour = hour;
  const elev = Math.asin(Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(ha));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(LAT) - Math.tan(decl) * Math.cos(LAT));
  return { elev, az, hour: parts.hour, minute: parts.minute };
}

export function weatherPhrase(code) {
  if (code == null) return '';
  if (code === 0) return 'jasno';
  if (code <= 2) return 'polojasno';
  if (code === 3) return 'zataženo';
  if (code === 45 || code === 48) return 'mlha';
  if (code >= 51 && code <= 57) return 'mrholení';
  if (code >= 61 && code <= 67) return 'déšť';
  if (code >= 71 && code <= 77) return 'sněžení';
  if (code >= 80 && code <= 82) return 'přeháňky';
  if (code >= 95) return 'bouřka';
  return 'oblačno';
}

export function isWet(weather) {
  if (!weather) return false;
  if ((weather.rain || 0) > 0.05) return true;
  const code = weather.weather_code;
  return (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
}

export async function fetchAirQuality() {
  const url = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=50.660&longitude=14.041&current=european_aqi,pm2_5&timezone=Europe%2FPrague';
  const response = await fetch(url);
  if (!response.ok) throw new Error('ovzduší');
  const json = await response.json();
  const current = json.current || null;
  if (!current || !Number.isFinite(current.european_aqi)) return null;
  return { european_aqi: current.european_aqi, pm2_5: current.pm2_5 };
}

export async function fetchWeather() {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=50.660&longitude=14.041&current=temperature_2m,weather_code,cloud_cover,rain,wind_speed_10m&timezone=Europe%2FPrague';
  const response = await fetch(url);
  if (!response.ok) throw new Error('počasí');
  const json = await response.json();
  return json.current || null;
}

export function createDaylight({ hemi, sun, sky, fog, scene, camera }) {
  let season = 'auto';
  let fireworksOn = false;
  const starsGeo = new THREE.BufferGeometry();
  const starN = 160;
  const starPos = new Float32Array(starN * 3);
  for (let i = 0; i < starN; i++) {
    const a = Math.random() * Math.PI * 2;
    const h = 0.15 + Math.random() * 0.7;
    starPos[i * 3] = Math.cos(a) * 18;
    starPos[i * 3 + 1] = 8 + h * 14;
    starPos[i * 3 + 2] = Math.sin(a) * 18;
  }
  starsGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(
    starsGeo,
    new THREE.PointsMaterial({ color: 0xe8f0ff, size: 0.045, transparent: true, opacity: 0, depthWrite: false }),
  );
  stars.visible = false;
  camera.add(stars);

  const burstGeo = new THREE.BufferGeometry();
  const burstN = 48;
  const burstPos = new Float32Array(burstN * 3);
  burstGeo.setAttribute('position', new THREE.BufferAttribute(burstPos, 3));
  const burst = new THREE.Points(
    burstGeo,
    new THREE.PointsMaterial({ color: 0xffd18a, size: 0.12, transparent: true, opacity: 0, depthWrite: false }),
  );
  burst.visible = false;
  camera.add(burst);
  let burstT = 0;

  const rainGeo = new THREE.BufferGeometry();
  const count = 380;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 28;
    positions[i * 3 + 1] = Math.random() * 16;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 28;
  }
  rainGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const rain = new THREE.Points(
    rainGeo,
    new THREE.PointsMaterial({ color: 0xd5e4ee, size: 0.07, transparent: true, opacity: 0.45, depthWrite: false }),
  );
  rain.visible = false;
  rain.frustumCulled = false;
  camera.add(rain);
  if (!camera.parent) scene.add(camera);

  function update(player, { when, weather, allowRain }) {
    const { elev, az, hour, minute } = sunState(when);
    const parts = pragueParts(when);
    const month = parts.month;
    const seasonNow = season === 'auto'
      ? (month <= 2 || month === 12 ? 'winter' : month <= 5 ? 'spring' : month <= 8 ? 'summer' : 'autumn')
      : season;
    const sunAmt = THREE.MathUtils.smoothstep(elev, -0.15, 0.28);
    const night = 1 - sunAmt;
    const cloud = Math.min(1, (weather?.cloud_cover || 0) / 100);
    const wet = isWet(weather);
    const lightElev = Math.max(elev, 0.12);
    const x = -Math.sin(az) * Math.cos(lightElev);
    const y = Math.sin(lightElev);
    const z = -Math.cos(az) * Math.cos(lightElev);
    if (sun.parent && sun.target.parent !== sun.parent) sun.parent.add(sun.target);
    sun.position.set(player.x + x * 90, player.y + y * 90, player.z + z * 90);
    sun.target.position.set(player.x, player.y, player.z);
    sun.target.updateMatrixWorld();
    sun.intensity = 0.35 + sunAmt * (wet ? 0.85 : 1.25);
    hemi.intensity = 0.42 + sunAmt * 0.9;
    hemi.color.set(sunAmt > 0.45 ? 0xfff3dc : 0x9eb4d2);
    sky.material.uniforms.night.value = night;
    sky.material.uniforms.cloud.value = Math.max(cloud, wet ? 0.72 : 0);
    if (sky.material.uniforms.season) {
      sky.material.uniforms.season.value = seasonNow === 'autumn' ? 0.55 : seasonNow === 'winter' ? 0.25 : seasonNow === 'spring' ? 0.15 : 0;
    }
    const fogColor = new THREE.Color(wet ? 0xb7c6d0 : 0xc5dff2).lerp(new THREE.Color(0x1a2740), night * 0.82);
    fog.color.copy(fogColor);
    fog.near = 700 - cloud * 280 - (wet ? 160 : 0);
    fog.far = 4400 - cloud * 1200 - night * 900;
    sky.position.set(player.x, player.y, player.z);
    const phrase = weatherPhrase(weather?.weather_code);
    const temp = Number.isFinite(weather?.temperature_2m) ? ` · ${Math.round(weather.temperature_2m)} °C` : '';
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    stars.visible = night > 0.55;
    stars.material.opacity = Math.max(0, (night - 0.55) * 1.4);
    const nye = parts.month === 12 && parts.day === 31 && parts.hour >= 22;
    burst.visible = fireworksOn || nye;
    if (burst.visible) {
      burstT += 0.016;
      const origin = new THREE.Vector3(0, 12, -22);
      for (let i = 0; i < burstN; i++) {
        const a = (i / burstN) * Math.PI * 2;
        const r = (burstT % 1.6) * 9;
        burstPos[i * 3] = origin.x + Math.cos(a) * r;
        burstPos[i * 3 + 1] = origin.y + Math.sin(burstT * 4 + i) * 2;
        burstPos[i * 3 + 2] = origin.z + Math.sin(a) * r;
      }
      burstGeo.attributes.position.needsUpdate = true;
      burst.material.opacity = 0.55 * (1 - ((burstT % 1.6) / 1.6));
    }
    rain.visible = Boolean(allowRain && wet && sunAmt > 0.2);
    if (rain.visible) {
      const attr = rainGeo.attributes.position;
      for (let i = 1; i < attr.count; i += 1) {
        let py = attr.getY(i) - 0.22;
        if (py < 0) py = 16;
        attr.setY(i, py);
      }
      attr.needsUpdate = true;
    }
    return { night, wet, clock: `${hh}:${mm}${phrase ? ` · ${phrase}` : ''}${temp}`, season: seasonNow };
  }

  return {
    update,
    rain,
    setSeason(next) {
      season = next || 'auto';
    },
    setFireworks(on) {
      fireworksOn = on;
    },
    toggleFireworks() {
      fireworksOn = !fireworksOn;
      return fireworksOn;
    },
  };
}
