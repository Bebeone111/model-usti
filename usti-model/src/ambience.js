export function createAmbience() {
  let ctx = null;
  let master = null;
  let filter = null;
  let stepAt = 0;
  let enabled = false;

  function context() {
    if (ctx) return ctx;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    ctx = new AudioCtx();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    source.connect(filter);
    filter.connect(master);
    source.start();
    return ctx;
  }

  return {
    get enabled() {
      return enabled;
    },
    async toggle() {
      const audio = context();
      if (!audio) return false;
      enabled = !enabled;
      if (audio.state === 'suspended') await audio.resume();
      master.gain.setTargetAtTime(enabled ? 0.012 : 0, audio.currentTime, 0.06);
      return enabled;
    },
    presence(nearWater, windy) {
      if (!enabled || !ctx || !master) return;
      const level = nearWater ? 0.05 : windy ? 0.028 : 0.012;
      master.gain.setTargetAtTime(level, ctx.currentTime, 0.25);
      if (filter) filter.frequency.setTargetAtTime(nearWater ? 280 : windy ? 900 : 420, ctx.currentTime, 0.3);
    },
    step(moving, fast) {
      if (!enabled || !ctx || !moving) return;
      const now = ctx.currentTime;
      if (now < stepAt) return;
      stepAt = now + (fast ? 0.28 : 0.42);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 80;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.03, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now);
      osc.stop(now + 0.1);
    },
  };
}
