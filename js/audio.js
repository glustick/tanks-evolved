/**
 * audio.js — procedural WebAudio SFX and the ambient bed.
 *
 * Everything is synthesised at runtime: no audio files, no fetch, no CDN, so
 * the game works from file://. The audio context is created lazily on the first
 * user gesture (browsers block autoplay before that) and every entry point is
 * defensive, so a browser without WebAudio — or a hidden/background tab — never
 * throws.
 */
(function (root) {
  'use strict';

  var TE = (root.TE = root.TE || {});

  var ctx = null;
  var master = null;
  var sfxBus = null;
  var ambient = null;
  var noiseBuffer = null;
  var muted = false;
  var available = null; // null = not probed yet

  function probe() {
    if (available !== null) return available;
    var Ctor = root.AudioContext || root.webkitAudioContext;
    available = typeof Ctor === 'function';
    return available;
  }

  /**
   * Create the audio graph. Safe to call repeatedly; the second call is a
   * no-op apart from resuming a suspended context.
   *
   * `fromUserGesture` must be true only when the call really originates from a
   * click/keypress: constructing an AudioContext outside a user gesture makes
   * Chrome log an autoplay warning and the context stays suspended anyway, so
   * programmatic callers (self-test, automation) get a null instead.
   */
  function init(fromUserGesture) {
    if (ctx) {
      if (fromUserGesture === true && ctx.state === 'suspended' && ctx.resume) {
        try { ctx.resume(); } catch (e) { /* ignore */ }
      }
      return ctx;
    }
    if (fromUserGesture !== true) return null;
    if (!probe()) return null;
    try {
      var Ctor = root.AudioContext || root.webkitAudioContext;
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      master.connect(ctx.destination);
      sfxBus = ctx.createGain();
      sfxBus.gain.value = 1;
      sfxBus.connect(master);
      noiseBuffer = makeNoiseBuffer(1.5);
    } catch (e) {
      ctx = null;
      available = false;
    }
    return ctx;
  }

  function ready() {
    return !!ctx && !muted;
  }

  /**
   * Deterministic white noise (seeded, not Math.random) reused by every
   * percussive sound. Two seconds of mono noise is plenty for short bursts.
   */
  function makeNoiseBuffer(seconds) {
    var length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    var buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    var rng = TE.rng.fromSeed('tanks-evolved-audio');
    for (var i = 0; i < length; i++) data[i] = rng.next() * 2 - 1;
    return buffer;
  }

  function noiseSource(playbackRate) {
    var src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    src.playbackRate.value = playbackRate || 1;
    return src;
  }

  function envelope(gain, peak, attack, release, startAt) {
    var t = startAt || ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
    return t + attack + release;
  }

  /** Low-pitched sine sweep with an exponential pitch drop. */
  function thump(freqStart, freqEnd, duration, peak) {
    var t = ctx.currentTime;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freqStart, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + duration);
    envelope(gain, peak, 0.006, duration, t);
    osc.connect(gain);
    gain.connect(sfxBus);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  /** Filtered noise burst — the crunchy part of every impact. */
  function burst(options) {
    var o = options;
    var t = ctx.currentTime;
    var src = noiseSource(o.rate || 1);
    var filter = ctx.createBiquadFilter();
    filter.type = o.filter || 'lowpass';
    filter.frequency.setValueAtTime(o.freqStart || 2000, t);
    if (o.freqEnd) filter.frequency.exponentialRampToValueAtTime(Math.max(40, o.freqEnd), t + o.duration);
    filter.Q.value = o.q == null ? 0.8 : o.q;
    var gain = ctx.createGain();
    envelope(gain, o.peak == null ? 0.5 : o.peak, o.attack == null ? 0.004 : o.attack, o.duration, t);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(sfxBus);
    src.start(t);
    src.stop(t + o.duration + 0.1);
  }

  // ------------------------------------------------------------------ effects
  /** Cannon fire: sharp crack plus a body-thump. */
  function fire() {
    if (!init() || !ready()) return;
    burst({ rate: 1.6, filter: 'bandpass', freqStart: 2600, freqEnd: 500, duration: 0.26, peak: 0.55, q: 0.9 });
    thump(190, 60, 0.28, 0.5);
  }

  /**
   * Explosion. `strength` scales with the blast and `distance` with the
   * on-screen separation, so far-off hits sound smaller.
   */
  function explosion(strength, distance) {
    if (!init() || !ready()) return;
    var s = strength == null ? 1 : Math.max(0.2, Math.min(1.4, strength));
    var near = distance == null ? 0 : Math.max(0, Math.min(1, 1 - distance / 1400));
    var vol = 0.35 + 0.6 * s * (0.45 + 0.55 * near);
    burst({ rate: 1, filter: 'lowpass', freqStart: 1600, freqEnd: 120, duration: 0.75, peak: Math.min(1, vol), attack: 0.012 });
    thump(120 * s, 32, 0.8, Math.min(1, vol * 0.95));
    burst({ rate: 2.2, filter: 'highpass', freqStart: 900, duration: 0.12, peak: Math.min(0.5, vol * 0.5) });
  }

  /** Small tick for UI + a metallic ring for a shell hitting a tank. */
  function click() {
    if (!init() || !ready()) return;
    burst({ rate: 3, filter: 'highpass', freqStart: 2400, duration: 0.045, peak: 0.25 });
  }

  function armorHit() {
    if (!init() || !ready()) return;
    burst({ rate: 1.9, filter: 'bandpass', freqStart: 1800, freqEnd: 700, duration: 0.22, peak: 0.6, q: 3 });
    thump(240, 90, 0.22, 0.4);
  }

  /** Shell leaving the map — a fading whoosh. */
  function whoosh() {
    if (!init() || !ready()) return;
    burst({ rate: 0.8, filter: 'bandpass', freqStart: 700, freqEnd: 220, duration: 0.5, peak: 0.22, q: 1.4 });
  }

  /** Win jingle: a short major arpeggio, again synthesised. */
  function fanfare() {
    if (!init() || !ready()) return;
    var notes = [392, 523.25, 659.25, 783.99];
    var t = ctx.currentTime;
    for (var i = 0; i < notes.length; i++) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = notes[i];
      var start = t + i * 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
      osc.connect(gain);
      gain.connect(sfxBus);
      osc.start(start);
      osc.stop(start + 0.55);
    }
  }

  // ------------------------------------------------------------------ ambience
  /**
   * Ambient bed: two detuned drones, a filtered wind layer driven by the wind
   * value, and a slow LFO — enough to stop the match feeling silent.
   */
  function startAmbient(fromUserGesture) {
    if (!init(fromUserGesture) || !ready() || ambient) return;
    try {
      var t = ctx.currentTime;
      var drone = ctx.createGain();
      drone.gain.value = 0.0;
      drone.gain.linearRampToValueAtTime(0.05, t + 2.5);
      drone.connect(master);

      var oscs = [];
      var freqs = [55, 82.4, 110.3];
      for (var i = 0; i < freqs.length; i++) {
        var osc = ctx.createOscillator();
        osc.type = i === 2 ? 'triangle' : 'sine';
        osc.frequency.value = freqs[i];
        osc.detune.value = (i - 1) * 7;
        var g = ctx.createGain();
        g.gain.value = i === 2 ? 0.25 : 0.5;
        osc.connect(g);
        g.connect(drone);
        osc.start(t);
        oscs.push(osc);
      }

      var wind = noiseSource(0.35);
      var windFilter = ctx.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.frequency.value = 420;
      windFilter.Q.value = 0.6;
      var windGain = ctx.createGain();
      windGain.gain.value = 0.02;
      wind.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(master);
      wind.start(t);

      var lfo = ctx.createOscillator();
      var lfoGain = ctx.createGain();
      lfo.frequency.value = 0.07;
      lfoGain.gain.value = 0.012;
      lfo.connect(lfoGain);
      lfoGain.connect(windGain.gain);
      lfo.start(t);

      ambient = { drone: drone, windGain: windGain, oscs: oscs, wind: wind, lfo: lfo };
    } catch (e) {
      ambient = null;
    }
  }

  function stopAmbient() {
    if (!ambient) return;
    try {
      var t = ctx.currentTime;
      ambient.drone.gain.cancelScheduledValues(t);
      ambient.drone.gain.linearRampToValueAtTime(0.0001, t + 0.4);
      ambient.windGain.gain.linearRampToValueAtTime(0.0001, t + 0.4);
      for (var i = 0; i < ambient.oscs.length; i++) ambient.oscs[i].stop(t + 0.5);
      ambient.wind.stop(t + 0.5);
      ambient.lfo.stop(t + 0.5);
    } catch (e) { /* ignore */ }
    ambient = null;
  }

  /** Feed the ambient wind layer with the current turn's wind. */
  function setWind(wind) {
    if (!ambient || !ready()) return;
    try {
      var mag = Math.abs(wind);
      ambient.windGain.gain.value = 0.012 + mag * 0.05;
      ambient.drone.gain.value = 0.04 + (1 - mag) * 0.02;
    } catch (e) { /* ignore */ }
  }

  function setMuted(next) {
    muted = !!next;
    if (ctx && master) {
      try {
        var t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.linearRampToValueAtTime(muted ? 0.0001 : 0.9, t + 0.12);
      } catch (e) { /* ignore */ }
    }
    if (muted) stopAmbient(); else startAmbient();
    return muted;
  }

  function toggleMute() { return setMuted(!muted); }
  function isMuted() { return muted; }
  function isAvailable() { return probe(); }

  TE.audio = {
    init: init,
    fire: fire,
    explosion: explosion,
    click: click,
    armorHit: armorHit,
    whoosh: whoosh,
    fanfare: fanfare,
    startAmbient: startAmbient,
    stopAmbient: stopAmbient,
    setWind: setWind,
    setMuted: setMuted,
    toggleMute: toggleMute,
    isMuted: isMuted,
    isAvailable: isAvailable
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
