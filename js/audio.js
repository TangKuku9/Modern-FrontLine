// 播报音色偏好：Natural 神经网络女声优先（Edge 在线音色），本地音色做离线降级，男声垫底。
const VOICE_FEMALE = /xiaoxiao|xiaoyi|xiaobei|xiaochen|xiaoni|huihui|yaoyao|tingting/i;
const VOICE_MALE = /kangkang|yunxi|yunyang|yunjian|yunxia|yunze|yunye|yunfeng/i;

export function pickZhVoices(voices) {
  const score = v => {
    let s = 0;
    if (/natural/i.test(v.name)) s += 40;
    if (VOICE_FEMALE.test(v.name)) s += 20;
    if (VOICE_MALE.test(v.name)) s -= 100;
    return s;
  };
  const ranked = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith('zh'))
    .sort((a, b) => score(b) - score(a));
  return { primary: ranked[0] || null, fallback: ranked.find(v => v.localService) || ranked[0] || null };
}

// 每把枪一条声纹（data.js 的 sound 字段直接指向这里的键）。以前按"族"共用
// （rifle_heavy/smg…）的结果是 AK、SCAR、SKS 听起来像同一支枪 —— 声音是玩家区分
// 口径/威胁等级的最直接线索。旧族名经 SHOT_ALIASES 兜底，哨戒机枪仍传 'turret'。
// 字段：f/q/dec = 主体爆裂的低通起点/谐振/衰减；crk/cv/cd = 枪口超压的高频破裂层；
// thump/tv = 低频冲击的频率/音量；tail/tlv = 大口径余音尾（低频回响）；grit = 软削波
// 过载量（实录枪声的"毛边"）；vol = 总音量。狙击/霰弹/机枪三档明显重于突击步枪。
const SHOT_PRESETS = {
  m4:       { f: 1900, q: 0.8,  dec: 0.13, crk: 3400, cv: 0.8,  cd: 0.022, thump: 100, tv: 0.8,  tail: 0,    tlv: 0,    grit: 0.18, vol: 0.68 },
  ak:       { f: 1250, q: 0.7,  dec: 0.19, crk: 2600, cv: 0.7,  cd: 0.028, thump: 78,  tv: 1.05, tail: 0.18, tlv: 0.25, grit: 0.3,  vol: 0.78 },
  scar:     { f: 1100, q: 0.65, dec: 0.22, crk: 2400, cv: 0.75, cd: 0.03,  thump: 66,  tv: 1.2,  tail: 0.3,  tlv: 0.3,  grit: 0.32, vol: 0.82 },
  mp5:      { f: 2500, q: 0.9,  dec: 0.09, crk: 4200, cv: 0.7,  cd: 0.018, thump: 125, tv: 0.55, tail: 0,    tlv: 0,    grit: 0.15, vol: 0.52 },
  vector:   { f: 1500, q: 0.85, dec: 0.12, crk: 3000, cv: 0.6,  cd: 0.022, thump: 95,  tv: 0.85, tail: 0,    tlv: 0,    grit: 0.2,  vol: 0.6 },
  pkm:      { f: 950,  q: 0.6,  dec: 0.24, crk: 2200, cv: 0.8,  cd: 0.03,  thump: 60,  tv: 1.25, tail: 0.35, tlv: 0.3,  grit: 0.42, vol: 0.85 },
  m870:     { f: 850,  q: 0.5,  dec: 0.3,  crk: 1800, cv: 0.7,  cd: 0.04,  thump: 52,  tv: 1.4,  tail: 0.4,  tlv: 0.35, grit: 0.4,  vol: 0.95 },
  sks:      { f: 1350, q: 0.7,  dec: 0.18, crk: 2800, cv: 0.8,  cd: 0.025, thump: 82,  tv: 1.05, tail: 0.25, tlv: 0.25, grit: 0.3,  vol: 0.8 },
  l115:     { f: 750,  q: 0.55, dec: 0.5,  crk: 3100, cv: 1.1,  cd: 0.03,  thump: 44,  tv: 1.6,  tail: 0.6,  tlv: 0.45, grit: 0.5,  vol: 1.1 },
  m1911:    { f: 2100, q: 0.9,  dec: 0.1,  crk: 3600, cv: 0.7,  cd: 0.018, thump: 110, tv: 0.7,  tail: 0,    tlv: 0,    grit: 0.15, vol: 0.55 },
  revolver: { f: 1400, q: 0.75, dec: 0.18, crk: 2900, cv: 0.9,  cd: 0.025, thump: 85,  tv: 1.05, tail: 0.2,  tlv: 0.2,  grit: 0.28, vol: 0.85 },
  rpg:       { f: 480,  q: 0.4,  dec: 0.7,  crk: 0,    cv: 0,    cd: 0,     thump: 38,  tv: 1.0,  tail: 0.8,  tlv: 0.4,  grit: 0.2,  vol: 0.9 },
  turret:   { f: 1700, q: 0.8,  dec: 0.12, crk: 3200, cv: 0.6,  cd: 0.02,  thump: 88,  tv: 0.7,  tail: 0,    tlv: 0,    grit: 0.2,  vol: 0.6 },
};
const SHOT_ALIASES = {
  rifle: 'm4', rifle_heavy: 'ak', smg: 'mp5', lmg: 'pkm', sniper: 'l115',
  shotgun: 'm870', pistol: 'm1911', pistol_heavy: 'revolver', rocket: 'rpg',
};

// WebAudio 程序化音效
export class Audio {
  constructor() {
    this.ctx = null; this.enabled = true; this.volume = 0.8;
    this.listener = { x: 0, y: 0, z: 0, yaw: 0 };
    this.loops = {};
    this.voice = true;
    this.picked = null;
  }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = this.volume;
    this.comp = c.createDynamicsCompressor(); this.comp.threshold.value = -14; this.comp.ratio.value = 6;
    this.master.connect(this.comp); this.comp.connect(c.destination);
    // 混响
    this.reverb = c.createConvolver();
    const len = c.sampleRate * 2.2, ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    this.reverb.buffer = ir;
    this.revGain = c.createGain(); this.revGain.gain.value = 0.35;
    this.reverb.connect(this.revGain); this.revGain.connect(this.master);
    // 噪声
    const nl = c.sampleRate * 2; this.noise = c.createBuffer(1, nl, c.sampleRate);
    const nd = this.noise.getChannelData(0); for (let i = 0; i < nl; i++) nd[i] = Math.random() * 2 - 1;
    // 棕噪声
    this.brown = c.createBuffer(1, nl, c.sampleRate);
    const bd = this.brown.getChannelData(0); let last = 0;
    for (let i = 0; i < nl; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; bd[i] = last * 3.5; }
    // 软削波曲线：枪声主体的预增益推进这里，得到实录枪声那种过载"毛边"
    const ds = 1024, dc = new Float32Array(ds);
    for (let i = 0; i < ds; i++) { const x = (i / (ds - 1)) * 2 - 1; dc[i] = Math.tanh(x * 2.5) / Math.tanh(2.5); }
    this.clip = dc;
  }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
  setListener(p, yaw) { this.listener.x = p.x; this.listener.y = p.y; this.listener.z = p.z; this.listener.yaw = yaw; }

  // 计算空间参数。reach < 1 = 这一发"传得远"：距离项整体放缓，用于枪声与脚步这种
  // **听声辨位靠它**的动静 —— 通用曲线（reach 1）在 20 m 外已经把脚步压到听不出来，
  // 而"旁边有人在移动/开火"恰恰是玩家最需要知道的事。reach > 1 没有用户，留着对称。
  spatial(pos, reach = 1) {
    if (!pos) return { gain: 1, pan: 0, dist: 0 };
    const L = this.listener;
    const dx = pos.x - L.x, dz = pos.z - L.z, dy = pos.y - L.y;
    const dist = Math.hypot(dx, dy, dz);
    const gain = 1 / (1 + dist * 0.06 * reach + dist * dist * 0.0006 * reach * reach);
    // 右向量 = (cos yaw, 0, -sin yaw)
    const rx = Math.cos(L.yaw), rz = -Math.sin(L.yaw);
    const pan = dist > 0.1 ? Math.max(-1, Math.min(1, (dx * rx + dz * rz) / dist)) * 0.85 : 0;
    return { gain, pan, dist };
  }
  out(gain, pan, revSend = 0.3) {
    const c = this.ctx;
    const g = c.createGain(); g.gain.value = gain;
    const p = c.createStereoPanner ? c.createStereoPanner() : null;
    if (p) { p.pan.value = pan; g.connect(p); p.connect(this.master); } else g.connect(this.master);
    if (revSend > 0) { const r = c.createGain(); r.gain.value = revSend; g.connect(r); r.connect(this.reverb); }
    return g;
  }
  noiseSrc(buf) { const s = this.ctx.createBufferSource(); s.buffer = buf || this.noise; s.loop = true; s.loopStart = Math.random(); return s; }

  shot(type, pos, suppressed = false) {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t = c.currentTime;
    // 枪声是战场上最大的"别人的动静"，衰减按它的量级来（reach 0.55）：
    // 15 m 的交火清晰可闻，40 m 仍明确知道"那边在打" —— 通用曲线下 30 m 外的枪声
    // 已经弱到像隔壁楼层，而那正是最需要靠听觉补情报的距离。
    const sp = this.spatial(pos, 0.55);
    if (sp.gain < 0.01) return;
    const P = SHOT_PRESETS[type] || SHOT_PRESETS[SHOT_ALIASES[type]] || SHOT_PRESETS.m4;
    // 每发抖动：连发不该是一段循环采样 —— 频率/音量/低频各自随机偏一点，
    // 同一把枪打 30 发才是 30 发略有差异的枪声。
    const wob = (a = 0.12) => 1 - a / 2 + Math.random() * a;
    const far = Math.min(1, sp.dist / 80);
    let vol = P.vol * wob(0.2) * sp.gain;
    if (suppressed) vol *= 0.3;
    // 大口径与远处的枪声多送混响：尾音拖得长，也是"距离感"的来源
    const o = this.out(vol, sp.pan, 0.25 + far * 0.6 + (P.tail ? 0.08 : 0));
    // ① 主体爆裂：枪声的" bark "，个性主要在这一层。远处高频衰减最快（fc 下压）
    const fc = P.f * wob() * (1 - far * 0.6) * (suppressed ? 1.5 : 1);
    const dec = P.dec * (suppressed ? 0.55 : 1);
    const n = this.noiseSrc();
    const bp = c.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.setValueAtTime(fc * 3, t); bp.frequency.exponentialRampToValueAtTime(fc * 0.4, t + dec);
    bp.Q.value = P.q;
    const ng = c.createGain(); ng.gain.setValueAtTime(0.0001, t); ng.gain.exponentialRampToValueAtTime(1.0, t + 0.003); ng.gain.exponentialRampToValueAtTime(0.001, t + dec);
    n.connect(bp); bp.connect(ng);
    let out = ng;
    if (P.grit > 0) { // 毛边：预增益推进软削波，大口径的过载"劈"感
      const pre = c.createGain(); pre.gain.value = 1 + P.grit * 1.6;
      const ws = c.createWaveShaper(); ws.curve = this.clip;
      ng.connect(pre); pre.connect(ws); out = ws;
    }
    out.connect(o);
    n.start(t); n.stop(t + dec + 0.05);
    // ② 破裂音：枪口超压的高频瞬态（"啪"）。消音器整个吃掉它；距离上它衰减也最快 ——
    // 远处的枪声只剩低频的"咚"，这本身就是听距的线索。
    if (P.crk && !suppressed) {
      const k = this.noiseSrc();
      const kf = c.createBiquadFilter(); kf.type = 'bandpass'; kf.frequency.value = P.crk * wob(0.08); kf.Q.value = 1.2;
      const kg = c.createGain(); kg.gain.setValueAtTime(0.0001, t); kg.gain.exponentialRampToValueAtTime(P.cv * (1 - far * 0.75), t + 0.001); kg.gain.exponentialRampToValueAtTime(0.001, t + P.cd);
      k.connect(kf); kf.connect(kg); kg.connect(o); k.start(t); k.stop(t + P.cd + 0.02);
    }
    // ③ 低频冲击：膛压的"咚"，距离衰减最慢（狙击/霰弹这一层拖得更低更久）
    if (!suppressed || sp.dist < 5) {
      const th = P.thump * wob(0.14);
      const os = c.createOscillator(); os.type = 'sine';
      os.frequency.setValueAtTime(th * 2.2, t); os.frequency.exponentialRampToValueAtTime(th * 0.5, t + 0.12);
      const og = c.createGain(); og.gain.setValueAtTime(P.tv * wob(0.2) * (1 - far * 0.5) * (suppressed ? 0.5 : 1), t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.18 + P.tv * 0.06);
      os.connect(og); og.connect(o); os.start(t); os.stop(t + 0.3);
    }
    // ④ 余音：大口径枪声在环境里的低频尾巴 —— 狙击枪"轰……"的分量主要在这
    if (P.tail && !suppressed) {
      const tn = this.noiseSrc(this.brown);
      const tf = c.createBiquadFilter(); tf.type = 'lowpass'; tf.frequency.setValueAtTime(600, t); tf.frequency.exponentialRampToValueAtTime(90, t + P.tail);
      const tg = c.createGain(); tg.gain.setValueAtTime(0.001, t); tg.gain.exponentialRampToValueAtTime(P.tlv * (1 - far * 0.3), t + 0.02); tg.gain.exponentialRampToValueAtTime(0.001, t + P.tail);
      tn.connect(tf); tf.connect(tg); tg.connect(o); tn.start(t); tn.stop(t + P.tail + 0.05);
    }
    // ⑤ 消音的"噗"：高压气体泄出的短促低噪 —— 消音枪声不该只是"变小"
    if (suppressed) {
      const pn = this.noiseSrc(this.brown);
      const pf = c.createBiquadFilter(); pf.type = 'bandpass'; pf.frequency.value = 500; pf.Q.value = 0.8;
      const pg = c.createGain(); pg.gain.setValueAtTime(0.0001, t); pg.gain.exponentialRampToValueAtTime(0.5, t + 0.008); pg.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      pn.connect(pf); pf.connect(pg); pg.connect(o); pn.start(t); pn.stop(t + 0.12);
    }
    // 机械声（只有本机自己的枪有 —— 别人的枪只能听到枪口的声音）
    if (!pos) {
      const cl = this.noiseSrc();
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4000;
      const cg = c.createGain(); cg.gain.setValueAtTime(0.25, t); cg.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      cl.connect(hp); hp.connect(cg); cg.connect(o); cl.start(t); cl.stop(t + 0.05);
    }
  }
  explosion(pos, big = 1) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const sp = this.spatial(pos);
    const o = this.out(Math.min(1.4, 1.6 * big * Math.sqrt(sp.gain)), sp.pan, 0.6);
    const n = this.noiseSrc(this.brown);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(1800, t); lp.frequency.exponentialRampToValueAtTime(120, t + 1.4);
    const g = c.createGain(); g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(1.5, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
    n.connect(lp); lp.connect(g); g.connect(o); n.start(t); n.stop(t + 2);
    const os = c.createOscillator(); os.frequency.setValueAtTime(90, t); os.frequency.exponentialRampToValueAtTime(25, t + 0.5);
    const og = c.createGain(); og.gain.setValueAtTime(1.4, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    os.connect(og); og.connect(o); os.start(t); os.stop(t + 0.8);
    const n2 = this.noiseSrc();
    const g2 = c.createGain(); g2.gain.setValueAtTime(0.6, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    n2.connect(g2); g2.connect(o); n2.start(t); n2.stop(t + 0.3);
  }
  tone(freq, dur, vol = 0.2, type = 'sine', pos = null, slide = 0) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const sp = this.spatial(pos);
    const o = this.out(vol * sp.gain, sp.pan, 0.05);
    const os = c.createOscillator(); os.type = type; os.frequency.setValueAtTime(freq, t);
    if (slide) os.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(1, t + 0.005); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    os.connect(g); g.connect(o); os.start(t); os.stop(t + dur + 0.02);
  }
  click(freq = 3000, dur = 0.03, vol = 0.3, pos = null, reach = 1) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const sp = this.spatial(pos, reach);
    const o = this.out(vol * sp.gain, sp.pan, 0.05);
    const n = this.noiseSrc();
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 3;
    const g = c.createGain(); g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(bp); bp.connect(g); g.connect(o); n.start(t); n.stop(t + dur + 0.02);
  }
  hit(kill = false, head = false) {
    this.click(head ? 5200 : 3800, 0.05, 0.5);
    if (head) this.tone(1800, 0.08, 0.15, 'triangle');
    if (kill) { this.tone(700, 0.12, 0.25, 'triangle'); setTimeout(() => this.tone(520, 0.14, 0.2, 'triangle'), 60); }
  }
  hurt() { this.click(400, 0.12, 0.5); this.tone(120, 0.2, 0.3, 'sine', null, 0.6); }
  step(pos, surface = 'dirt', vol = 0.18) {
    const f = { dirt: 900, sand: 700, snow: 500, metal: 2400, concrete: 1400, wet: 1800 }[surface] || 1000;
    // 脚步与枪声同档（reach 0.55）：20 m 外的逼近要在耳机里听得出方向。
    // 刻意的轻手（蹲步/忍者）由各调用方的 vol 自己压，不走这条曲线。
    this.click(f + Math.random() * 300, 0.07, vol, pos, 0.55);
  }
  // stage 带 pos：**别人的**换弹也要有距离与声像（remote.mjs / ai.js 传他们自己的位置）。
  // 没带 pos = 本机自己 —— 满音量。音量整档上调：0.35 上下的一串短滴答会被自己的
  // 枪声完全盖掉，"换弹"这个既是最重要的本机反馈、又是"他没子弹了"的情报的动静，
  // 以前两边都听不见。低频那一下 click 是"厚重感"的来源（金属部件的体感）。
  reload(stage, pos = null) {
    if (stage === 'out') { this.click(1500, 0.07, 0.6, pos); this.click(650, 0.1, 0.45, pos); }
    else if (stage === 'in') { this.click(950, 0.08, 0.7, pos); setTimeout(() => this.click(2400, 0.04, 0.5, pos), 40); }
    else if (stage === 'bolt') { this.click(2000, 0.06, 0.6, pos); setTimeout(() => this.click(1300, 0.08, 0.55, pos), 90); }
    else if (stage === 'shell') { this.click(1400, 0.06, 0.55, pos); }
  }
  empty() { this.click(3200, 0.02, 0.35); }
  ring(dur = 3, vol = 0.12) { this.tone(3600, dur, vol, 'sine'); }
  bounce(pos) { this.click(3500, 0.04, 0.3, pos); }
  ui(kind = 'hover') {
    if (!this.ctx) return;
    if (kind === 'hover') this.tone(1200, 0.04, 0.05, 'sine');
    else if (kind === 'click') { this.tone(700, 0.06, 0.12, 'triangle'); }
    else if (kind === 'equip') { this.click(1500, 0.06, 0.3); this.tone(300, 0.1, 0.1, 'triangle'); }
  }
  beep(n = 2) { for (let i = 0; i < n; i++) setTimeout(() => this.tone(1450, 0.08, 0.1, 'square'), i * 120); }
  whoosh(pos) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, sp = this.spatial(pos);
    const o = this.out(0.5 * Math.sqrt(sp.gain), sp.pan, 0.3);
    const n = this.noiseSrc(); const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1;
    bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(2000, t + 1.2); bp.frequency.exponentialRampToValueAtTime(200, t + 2.5);
    const g = c.createGain(); g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(1, t + 1.2); g.gain.exponentialRampToValueAtTime(0.001, t + 2.6);
    n.connect(bp); bp.connect(g); g.connect(o); n.start(t); n.stop(t + 2.7);
  }
  // 持续环境声
  loop(name, kind, vol) {
    if (!this.ctx) return;
    this.stopLoop(name);
    const c = this.ctx;
    const n = this.noiseSrc(kind === 'wind' ? this.brown : this.noise);
    const f = c.createBiquadFilter();
    const g = c.createGain(); g.gain.value = vol;
    if (kind === 'rain') { f.type = 'highpass'; f.frequency.value = 1200; }
    else if (kind === 'wind') { f.type = 'lowpass'; f.frequency.value = 500; }
    else if (kind === 'rotor') {
      f.type = 'lowpass'; f.frequency.value = 300;
      const lfo = c.createOscillator(); lfo.frequency.value = 13; const lg = c.createGain(); lg.gain.value = vol * 0.9;
      lfo.connect(lg); lg.connect(g.gain); lfo.start(); this.loops[name + '_lfo'] = lfo;
    } else if (kind === 'fire') { f.type = 'bandpass'; f.frequency.value = 800; f.Q.value = 0.5; }
    n.connect(f); f.connect(g); g.connect(this.master); n.start();
    this.loops[name] = { n, g };
  }
  setLoopVol(name, v) { const l = this.loops[name]; if (l && l.g) l.g.gain.value = v; }
  stopLoop(name) {
    const l = this.loops[name]; if (l) { try { l.n.stop(); } catch (e) { } delete this.loops[name]; }
    const lf = this.loops[name + '_lfo']; if (lf) { try { lf.stop(); } catch (e) { } delete this.loops[name + '_lfo']; }
  }
  stopAll() { for (const k of Object.keys(this.loops)) this.stopLoop(k); if (window.speechSynthesis) speechSynthesis.cancel(); }
  say(text, rate = 1.1, pitch = 0.9) {
    if (!this.voice || !window.speechSynthesis) return;
    try {
      const list = speechSynthesis.getVoices();
      if (!this.picked || (!this.picked.primary && list.length)) this.picked = pickZhVoices(list);
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      const speak = (v, canRetry) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN'; u.rate = rate; u.pitch = pitch; u.volume = Math.min(1, this.volume + 0.1);
        if (v) u.voice = v;
        // 在线音色断网时会报网络类错误 —— 降级到本地音色再说一遍；cancel 触发的
        // interrupted/canceled 不在此列，否则 stopAll() 之后会把刚掐掉的句子重播出来。
        if (canRetry && this.picked.fallback && v !== this.picked.fallback) u.onerror = e => {
          if (e.error === 'network' || e.error === 'synthesis-unavailable' || e.error === 'voice-unavailable') speak(this.picked.fallback, false);
        };
        speechSynthesis.speak(u);
      };
      speak((offline && this.picked.fallback) || this.picked.primary, true);
    } catch (e) { }
  }
}
