(function(){
  const appEl = document.getElementById('app');
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const wrap = document.getElementById('boardWrap');
  const overlay = document.getElementById('overlay');
  const overlayStart = document.getElementById('overlayStart');
  const overlayClose = document.getElementById('overlayClose');
  const scoreEl = document.getElementById('score');
  const opponentScoreEl = document.getElementById('opponentScore');
  const highEl = document.getElementById('high');
  const livesEl = document.getElementById('lives');
  const gridInfoEl = document.getElementById('gridInfo');
  const lifeBar = document.getElementById('lifeBar');
  const lifeFill = document.getElementById('lifeFill');
  const lifeLabel = document.getElementById('lifeLabel');

  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const themeSel = document.getElementById('theme');
  const diffSel = document.getElementById('difficulty');
  const sndToggle = document.getElementById('soundToggle');
  const oppToggle = document.getElementById('opponentToggle');

  const state = {
    running: false,
    paused: false,
    cell: 24,
    cols: 40,
    rows: 24,
    dpr: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
    score: 0,
    opponentScore: 0,
    high: parseInt(localStorage.getItem('ultraSnakeHigh')||'0', 10),
    lives: 3,
    theme: 'neon',
    difficulty: 'Normal',
    sound: true,
    opponentEnabled: true,
    lastTime: 0,
    acc: 0,
    step: 110, // ms per step (player base)
  };
  highEl.textContent = state.high;

  // WebAudio (simple beeps)
  const audio = {
    ctx: null,
    init(){ if(!this.ctx){ try{ this.ctx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } },
    beep(freq=440, dur=0.08, type='sine', gain=0.02){
      if(!state.sound) return; if(!this.ctx) this.init(); if(!this.ctx) return;
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type=type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t+dur);
      o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t+dur);
    },
    chord(freqs=[440,660], dur=0.12){ freqs.forEach((f,i)=>this.beep(f, dur*(1-0.05*i), i%2?'square':'sine', 0.015)); },
  };

  // Helpers
  const randInt = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;
  const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
  const eq = (a,b)=>a.x===b.x && a.y===b.y;
  const dirVec = d=>({x: d==='L'?-1:d==='R'?1:0, y: d==='U'?-1:d==='D'?1:0});

  // SVG -> Image data URL for canvas rendering
  function svgDataURL(symbolId){
    const sym = document.getElementById(symbolId);
    if(!sym) return null;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${sym.innerHTML}</svg>`;
    const encoded = 'data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(svg)));
    return encoded;
  }
  const imgIce = new Image(); imgIce.src = svgDataURL('svg-ice');
  const imgAlly = new Image(); imgAlly.src = svgDataURL('svg-ally');
  const imgLife = new Image(); imgLife.src = svgDataURL('svg-life');

  // Game objects
  class Snake{
    constructor({x,y,dir='R',color='#4de2ff',speed=110}){
      this.body=[{x,y},{x:x-1,y},{x:x-2,y}];
      this.dir=dir; this.nextDir=dir; this.color=color; this.speed=speed; this.acc=0; this.alive=true; this.grow=0; this.lastShot=0;
    }
    setDir(d){
      if((this.dir==='L'&&d==='R')||(this.dir==='R'&&d==='L')||(this.dir==='U'&&d==='D')||(this.dir==='D'&&d==='U')) return;
      this.nextDir=d;
    }
    step(dt){
      this.acc += dt;
      if(this.acc < this.speed) return false;
      this.acc = 0;
      this.dir = this.nextDir;
      const v=dirVec(this.dir);
      const head={x: this.body[0].x+v.x, y: this.body[0].y+v.y};
      this.body.unshift(head);
      if(this.grow>0){ this.grow--; } else { this.body.pop(); }
      return true;
    }
  }

  class Opponent extends Snake{
    constructor(opts){ super(opts); this.frozenUntil=0; this.health=100; this.evadeBias=0.4; }
    isFrozen(now){ return now < this.frozenUntil; }
    freeze(ms, now){ this.frozenUntil = Math.max(this.frozenUntil, now+ms); }
    damage(d){ this.health = clamp(this.health-d, 0, 100); if(this.health<=0){ this.alive=false; }
      audio.chord([220,180,140], 0.12);
    }
    ai(dt, world){
      // Only decide direction when moving a cell
      if(this.isFrozen(world.time)) return;
      const head=this.body[0];
      const target = world.food;
      const options=['U','D','L','R'];
      // Basic greedy towards player; in Hard try to avoid immediate collisions
      const dx = target.x - head.x; const dy = target.y - head.y;
      const pref = [];
      if(Math.abs(dx)>Math.abs(dy)) { pref.push(dx<0?'L':'R', dy<0?'U':'D'); }
      else { pref.push(dy<0?'U':'D', dx<0?'L':'R'); }
      // Fill remaining
      options.forEach(o=>{ if(!pref.includes(o)) pref.push(o); });
      // Evaluate and pick safe direction
      const safe = (d)=>{
        const v=dirVec(d); const p={x:head.x+v.x, y:head.y+v.y};
        if(p.x<0||p.y<0||p.x>=state.cols||p.y>=state.rows) return false;
        // avoid own body near head
        for(let i=0;i<Math.min(this.body.length,6);i++){ if(eq(p,this.body[i])) return false; }
        // avoid player near head (less bias on Easy)
        for(let i=0;i<Math.min(world.player.body.length,4);i++){ if(eq(p,world.player.body[i])) return Math.random()<this.evadeBias?false:true; }
        return true;
      }
      for(const d of pref){ if(safe(d)){ this.setDir(d); break; } }
    }
  }

  class Ally extends Snake{
    constructor(opts){ super(opts); this.expiresAt=0; }
    ai(dt, world){
      const head=this.body[0]; const foe=world.opponent?.body?.[0]; if(!foe) return;
      const dx=foe.x-head.x; const dy=foe.y-head.y;
      // Chase opponent greedily with simple wall avoidance
      const pref=[]; if(Math.abs(dx)>Math.abs(dy)) pref.push(dx<0?'L':'R', dy<0?'U':'D'); else pref.push(dy<0?'U':'D', dx<0?'L':'R');
      const opts=['U','D','L','R']; opts.forEach(o=>{ if(!pref.includes(o)) pref.push(o); });
      const safe=(d)=>{ const v=dirVec(d); const p={x:head.x+v.x, y:head.y+v.y}; if(p.x<0||p.y<0||p.x>=state.cols||p.y>=state.rows) return false; return true; }
      for(const d of pref){ if(safe(d)){ this.setDir(d); break; } }
    }
  }

  class Projectile{ constructor({x,y,dir}){ this.x=x; this.y=y; this.dir=dir; this.alive=true; this.speed=0.25; this.acc=0; } step(dt){ this.acc += dt; const cellTime = state.step * this.speed; while(this.acc>=cellTime){ this.acc -= cellTime; const v=dirVec(this.dir); this.x+=v.x; this.y+=v.y; if(this.x<0||this.y<0||this.x>=state.cols||this.y>=state.rows){ this.alive=false; break; } } } }

  const world = {
    time: 0,
    player: null,
    opponent: null,
    ally: null,
    projectiles: [],
    food: null,
    power: null, // {type:'ice'|'ally'|'life', pos}
    iceAmmo: 0,
    allyActive: false,
    allyUntil: 0,
  };

  function pickEmptyCell(){
    let tries=0;
    while(tries++<500){
      const p={x: randInt(0,state.cols-1), y: randInt(0,state.rows-1)};
      const occupied = (seg)=>seg && eq(seg,p);
      const occ = [ ...(world.player?.body||[]), ...(world.opponent?.body||[]), ...(world.ally?.body||[]), world.food, world.power?.pos ].some(occupied);
      if(!occ) return p;
    }
    return {x:2,y:2};
  }

  function spawnFood(){ world.food = pickEmptyCell(); }

  function spawnPower(){
    const roll = Math.random();
    let type='ice'; // default
    // Extra life appears with 20% rate among power-up spawns
    if(roll < 0.20) type='life';
    else if(roll < 0.60) type='ice';
    else type='ally';
    world.power = { type, pos: pickEmptyCell(), ttl: 15000 + randInt(-3000,3000) };
  }

  function applyPower(){
    if(!world.power) return;
    const type = world.power.type;
    if(type==='ice'){ world.iceAmmo = clamp(world.iceAmmo+3, 0, 9); flashMsg('+ Ice x3'); audio.chord([660,990],0.10); }
    if(type==='ally'){
      summonAlly(); flashMsg('Ally summoned'); audio.chord([520,780],0.10);
    }
    if(type==='life'){ state.lives = clamp(state.lives+1, 1, 9); livesEl.textContent = state.lives; flashMsg('+1 Life'); audio.chord([880,660],0.12); }
    world.power = null;
  }

  function summonAlly(){
    const head = world.player.body[0];
    world.ally = new Ally({ x: clamp(head.x-3,1,state.cols-2), y: head.y, dir: 'R', color:'#b96bff', speed: clamp(state.step*0.9, 70, 140) });
    world.ally.expiresAt = world.time + 8000; // 8 seconds
    world.allyActive = true;
    world.allyUntil = world.ally.expiresAt;
  }

  function resetPlayer(){
    world.player = new Snake({ x: Math.floor(state.cols*0.25), y: Math.floor(state.rows/2), dir:'R', color: themeColors().player, speed: state.step });
    world.projectiles.length = 0;
    world.iceAmmo = 0;
  }

  function reset(){
    state.score=0; scoreEl.textContent=state.score; state.opponentScore=0; opponentScoreEl.textContent=state.opponentScore; state.lives=3; livesEl.textContent=state.lives; world.iceAmmo=0; world.projectiles.length=0; world.ally=null; world.allyActive=false; world.opponent=null; lifeBar.hidden=true; lifeFill.style.width='100%';
    // speed based on difficulty
    const diff = state.difficulty;
    const baseStep = 110;
    state.step = diff==='Easy'?120:diff==='Hard'?95:110;

    world.player = new Snake({ x: Math.floor(state.cols*0.25), y: Math.floor(state.rows/2), dir:'R', color: themeColors().player, speed: state.step });

    if(state.opponentEnabled){
      world.opponent = new Opponent({ x: Math.floor(state.cols*0.75), y: Math.floor(state.rows/2), dir:'L', color: themeColors().opponent, speed: clamp(state.step*(diff==='Hard'?0.8:diff==='Easy'?1.1:0.95), 70, 140) });
      world.opponent.evadeBias = diff==='Hard'?0.85:diff==='Easy'?0.2:0.45;
      lifeBar.hidden=false; updateLifeBar();
    } else {
      world.opponent=null; lifeBar.hidden=true;
    }

    spawnFood();
    if(Math.random()<0.6) spawnPower();
    flashMsg('Good luck!');
  }

  function themeColors(){
    const t = state.theme;
    if(t==='retro') return { player: '#75c043', opponent: '#f7d51d' };
    if(t==='classic') return { player: '#28a745', opponent: '#ffc107' };
    return { player: '#4de2ff', opponent: '#ff5d73' }; // neon default
  }

  function updateLifeBar(){ if(!world.opponent) return; const pct = world.opponent.health; lifeFill.style.width = pct+'%'; lifeLabel.textContent = `Opponent ${pct|0}%`; }

  function flashMsg(text){
    const el=document.createElement('div');
    el.textContent=text; el.style.position='absolute'; el.style.left='50%'; el.style.top='14%'; el.style.transform='translate(-50%,-50%)'; el.style.padding='8px 12px'; el.style.border='1px solid rgba(255,255,255,0.2)'; el.style.background='rgba(10,14,22,0.8)'; el.style.borderRadius='10px'; el.style.fontWeight='800'; el.style.letterSpacing='0.4px'; el.style.pointerEvents='none'; el.style.boxShadow='0 10px 30px rgba(0,0,0,0.35)';
    wrap.appendChild(el); setTimeout(()=>{ el.style.transition='all .4s ease'; el.style.opacity='0'; el.style.transform='translate(-50%,-120%)'; }, 60);
    setTimeout(()=>wrap.removeChild(el), 700);
  }

  function resize(){
    // Fit to available boardWrap height; maintain reasonable grid
    const w = wrap.clientWidth; const h = wrap.clientHeight;
    // Aim for 30x20 grid on 1366x768-ish screens
    const cellW = Math.floor(w / 30); const cellH = Math.floor(h / 20);
    state.cell = Math.max(16, Math.min(32, Math.min(cellW, cellH)));
    state.cols = Math.floor(w / state.cell);
    state.rows = Math.floor(h / state.cell);

    const dpr = state.dpr; canvas.width = state.cols*state.cell*dpr; canvas.height = state.rows*state.cell*dpr; canvas.style.width = (state.cols*state.cell)+'px'; canvas.style.height = (state.rows*state.cell)+'px'; ctx.setTransform(dpr,0,0,dpr,0,0);
    gridInfoEl.textContent = `${state.cols}×${state.rows}`;
  }
  resize();
  window.addEventListener('resize', ()=>{ resize(); flashMsg('Resized'); });

  // Input
  const keys = { ArrowUp:'U', ArrowDown:'D', ArrowLeft:'L', ArrowRight:'R', KeyW:'U', KeyS:'D', KeyA:'L', KeyD:'R' };
  window.addEventListener('keydown', (e)=>{
    if(keys[e.code]){ world.player?.setDir(keys[e.code]); e.preventDefault(); }
    if(e.code==='Space'){ shoot(); e.preventDefault(); }
    if(e.code==='KeyP'){ togglePause(); }
  }, {passive:false});

  function shoot(){
    if(world.iceAmmo<=0) return;
    const head=world.player.body[0]; const pr = new Projectile({x:head.x, y:head.y, dir: world.player.dir});
    world.projectiles.push(pr); world.iceAmmo--; flashMsg('Ice!'); audio.beep(1100,0.08,'square',0.02);
  }

  // Collisions
  function collideWalls(p){ return p.x<0||p.y<0||p.x>=state.cols||p.y>=state.rows; }
  function collideSnake(p, snake){ return snake.body.some(seg=>eq(seg,p)); }

  function update(dt){
    world.time += dt;

    if(world.opponent){ world.opponent.ai(dt, world); }
    if(world.ally){ world.ally.ai(dt, world); if(world.time>world.ally.expiresAt){ world.ally=null; world.allyActive=false; } }

    // Step snakes
    const pmoved = world.player.step(dt);
    const omoved = world.opponent && !world.opponent.isFrozen(world.time) ? world.opponent.step(dt) : false;
    const amoved = world.ally? world.ally.step(dt): false;

    // Projectiles
    world.projectiles.forEach(p=>p.step(dt));
    world.projectiles = world.projectiles.filter(p=>p.alive);

    // Collisions after step
    const pHead = world.player.body[0];

    // Player eats
    if(eq(pHead, world.food)){ world.player.grow+=1; state.score+=10; scoreEl.textContent=state.score; audio.beep(660,0.06,'triangle',0.02); spawnFood(); if(Math.random()<0.6 && !world.power) spawnPower(); }

    if(world.power && eq(pHead, world.power.pos)){ applyPower(); }

    // Player wall/self/opponent
    if(collideWalls(pHead) || world.player.body.slice(1).some(seg=>eq(seg,pHead))){ loseLife(); return; }
    if(world.opponent && collideSnake(pHead, world.opponent)) { // bump opponent costs life
      world.opponent.damage(5); updateLifeBar(); loseLife(); return; }

    // Opponent eats & collisions
    if(world.opponent){
      const oHead = world.opponent.body[0];
      if(eq(oHead, world.food)){ world.opponent.grow+=1; state.opponentScore+=10; opponentScoreEl.textContent = state.opponentScore; audio.beep(330,0.06,'triangle',0.02); spawnFood(); if(Math.random()<0.35 && !world.power) spawnPower(); }
      if(collideWalls(oHead) || world.opponent.body.slice(1).some(seg=>eq(seg,oHead))){ world.opponent.damage(25); updateLifeBar(); world.opponent.body.pop(); }
      if(collideSnake(oHead, world.player)){ world.opponent.damage(12); updateLifeBar(); loseLife(); return; }
    }

    // Ally collisions versus opponent
    if(world.ally && world.opponent){
      const aHead = world.ally.body[0];
      if(collideSnake(aHead, world.opponent)){ world.opponent.damage(30); updateLifeBar(); audio.chord([500,300],0.08); // recoil ally a bit
        world.ally.grow += 1; }
    }

    // Projectile hits opponent
    if(world.opponent){
      for(const pr of world.projectiles){
        const p={x:pr.x, y:pr.y};
        if(collideSnake(p, world.opponent)){
          pr.alive=false; // freeze based on difficulty
          const freeze = state.difficulty==='Hard'?1200: state.difficulty==='Easy'?2400:1800;
          world.opponent.freeze(freeze, world.time); audio.beep(280,0.1,'sawtooth',0.02);
          flashMsg('Opponent frozen');
          break;
        }
      }
    }

    // Power TTL
    if(world.power){ world.power.ttl -= dt; if(world.power.ttl<=0) world.power=null; }

    // Win/lose opponent
    if(world.opponent && !world.opponent.alive){
      state.score += 100; scoreEl.textContent=state.score; audio.chord([740,880,660],0.12);
      world.opponent = null; // Prevent multiple score additions
      flashMsg('Opponent defeated! Respawning...');
      setTimeout(() => {
        const diff = state.difficulty;
        world.opponent = new Opponent({ x: Math.floor(state.cols*0.75), y: Math.floor(state.rows/2), dir:'L', color: themeColors().opponent, speed: clamp(state.step*(diff==='Hard'?0.8:diff==='Easy'?1.1:0.95), 70, 140) });
        world.opponent.evadeBias = diff==='Hard'?0.85:diff==='Easy'?0.2:0.45;
        updateLifeBar();
      }, 1000);
    }
  }

  function loseLife(){
    state.lives--;
    state.score = Math.floor(state.score * 0.5);
    livesEl.textContent=state.lives;
    scoreEl.textContent = state.score;
    audio.chord([220,140],0.12);
    if(state.lives<=0){
      gameOver();
    } else {
      resetPlayer();
      flashMsg('Life lost! -50% score');
    }
  }

  function gameOver(){
    state.running=false; overlay.style.display='flex';
    audio.chord([160,120,90],0.18);
    // Save high
    const finalScore = state.score + state.opponentScore;
    if(finalScore>state.high){ state.high=finalScore; localStorage.setItem('ultraSnakeHigh', String(state.high)); highEl.textContent=state.high; }
  }

  // Render
  function draw(){
    // Background grid by theme
    ctx.clearRect(0,0,canvas.width, canvas.height);
    drawGrid();
    if(world.food){ drawCell(world.food.x, world.food.y, () => drawFood()); }
    if(world.power){ drawCell(world.power.pos.x, world.power.pos.y, () => drawPower(world.power.type)); }

    if(world.projectiles.length){ world.projectiles.forEach(pr=> drawCell(pr.x,pr.y, ()=>drawShard())); }

    if(world.opponent){ drawSnake(world.opponent, true); }
    if(world.ally){ drawSnake(world.ally, false, true); }
    if(world.player){ drawSnake(world.player); }

    // ammo HUD indicator (small icons below score)
    if(world.iceAmmo>0){ const s=16; for(let i=0;i<world.iceAmmo;i++){ ctx.drawImage(imgIce, 6+i*(s+2), canvas.height/state.dpr-22, s, s); } }
  }

  function drawGrid(){
    const t = state.theme;
    const c = state.cell; const w = state.cols*c; const h = state.rows*c;
    if(t==='neon'){
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      for(let y=0;y<state.rows;y++){
        for(let x=0;x<state.cols;x++){
          ctx.fillRect(x*c+1,y*c+1,c-2,c-2);
        }
      }
      // neon vignette
      const grad = ctx.createRadialGradient(w*0.1,h*0.1,0,w*0.1,h*0.1, Math.max(w,h)*0.9);
      grad.addColorStop(0,'rgba(0,255,245,0.06)'); grad.addColorStop(1,'transparent');
      ctx.fillStyle=grad; ctx.fillRect(0,0,w,h);
    } else if(t==='retro'){
      for(let y=0;y<state.rows;y++){
        for(let x=0;x<state.cols;x++){
          ctx.fillStyle = (x+y)%2? '#12301a':'#0f2617'; ctx.fillRect(x*c,y*c,c,c);
        }
      }
    } else { // classic
      ctx.fillStyle = '#00210b'; ctx.fillRect(0,0,w,h);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      for(let x=0;x<=state.cols;x++){ ctx.beginPath(); ctx.moveTo(x*c,0); ctx.lineTo(x*c,h); ctx.stroke(); }
      for(let y=0;y<=state.rows;y++){ ctx.beginPath(); ctx.moveTo(0,y*c); ctx.lineTo(w,y*c); ctx.stroke(); }
    }
  }

  function drawCell(x,y, painter){ ctx.save(); ctx.translate(x*state.cell, y*state.cell); painter(); ctx.restore(); }

  function drawRoundedRect(x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }

  function drawSnake(snake, isOpponent=false, isAlly=false){
    const c = state.cell; const t=state.theme;
    const colors = themeColors();
    ctx.save();
    // Glow for neon
    if(t==='neon'){ ctx.shadowColor = isOpponent?colors.opponent: isAlly?'#b96bff':colors.player; ctx.shadowBlur=12; }

    snake.body.forEach((seg,i)=>{
      const x=seg.x*c, y=seg.y*c;
      const a = i===0?1: Math.max(0.6, 1 - i*0.03);
      const color = isOpponent? colors.opponent : isAlly? '#b96bff' : colors.player;
      ctx.fillStyle = color; ctx.globalAlpha = a;
      drawRoundedRect(x+2,y+2,c-4,c-4,6); ctx.fill();
      if(i===0){ // eyes
        ctx.globalAlpha=1; ctx.fillStyle='#fff'; const r=3; ctx.beginPath(); ctx.arc(x+c*0.35, y+c*0.35, r, 0, Math.PI*2); ctx.arc(x+c*0.65, y+c*0.35, r, 0, Math.PI*2); ctx.fill(); ctx.fillStyle='#111'; ctx.beginPath(); ctx.arc(x+c*0.35, y+c*0.35, 1.5, 0, Math.PI*2); ctx.arc(x+c*0.65, y+c*0.35, 1.5, 0, Math.PI*2); ctx.fill();
      }
    });

    ctx.restore();
  }

  function drawFood(){
    const c=state.cell; ctx.save();
    // Themed apple/energy cube
    if(state.theme==='retro'){ ctx.fillStyle='#f7d51d'; drawRoundedRect(4,4,c-8,c-8,6); ctx.fill(); }
    else if(state.theme==='classic'){ ctx.fillStyle='#28a745'; drawRoundedRect(4,4,c-8,c-8,6); ctx.fill(); ctx.fillStyle='#aaffaa'; ctx.fillRect(c/2-2,2,4,6); }
    else { // neon orb
      const g=ctx.createRadialGradient(c/2,c/2,2,c/2,c/2,c/2);
      g.addColorStop(0,'#9effff'); g.addColorStop(1,'#00a6ff'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(c/2,c/2,c/2-4,0,Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }

  function drawPower(type){
    const c=state.cell; const img = type==='ice'?imgIce : type==='ally'?imgAlly: imgLife; ctx.drawImage(img, 4,4, c-8, c-8);
  }

  function drawShard(){
    const c=state.cell; ctx.save(); ctx.fillStyle='#aef2ff'; drawRoundedRect(c*0.25,c*0.25,c*0.5,c*0.5,4); ctx.fill(); ctx.restore();
  }

  // Loop
  let rafId=0; function loop(ts){ if(!state.running||state.paused){ rafId=requestAnimationFrame(loop); return; } const last=state.lastTime||ts; const dt = ts-last; state.lastTime=ts; // cap
    update(Math.min(50, dt)); draw(); rafId=requestAnimationFrame(loop); }

  function start(){ overlay.style.display='none'; state.running=true; state.paused=false; state.lastTime=0; reset(); audio.chord([600,900],0.10); cancelAnimationFrame(rafId); rafId=requestAnimationFrame(loop); }
  function togglePause(){ if(!state.running) return; state.paused=!state.paused; pauseBtn.textContent = state.paused? 'Resume':'Pause'; flashMsg(state.paused?'Paused':'Resumed'); }

  // UI handlers
  startBtn.addEventListener('click', start);
  pauseBtn.addEventListener('click', togglePause);
  overlayStart.addEventListener('click', start);
  overlayClose.addEventListener('click', ()=> overlay.style.display='none');

  themeSel.addEventListener('change', (e)=>{ state.theme=e.target.value; appEl.classList.remove('theme-neon','theme-retro','theme-classic'); appEl.classList.add('theme-'+state.theme); flashMsg(`Theme: ${state.theme}`); });
  diffSel.addEventListener('change', (e)=>{ state.difficulty=e.target.value; flashMsg(`Difficulty: ${state.difficulty}`); });
  sndToggle.addEventListener('change', (e)=>{ state.sound=e.target.checked; flashMsg(state.sound?'Sound on':'Sound off'); if(state.sound) audio.beep(800,0.06); });
  oppToggle.addEventListener('change', (e)=>{ state.opponentEnabled=e.target.checked; flashMsg(state.opponentEnabled?'Opponent on':'Opponent off'); });

  // Start with overlay open
  overlay.style.display='flex';
})();
