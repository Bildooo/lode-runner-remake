(function () {
      "use strict";
      const canvas = document.getElementById("game");
      const ctx = canvas.getContext("2d");
      const status = document.getElementById("status");
      const mapSelect = document.getElementById("map-select");
      const soundButton = document.getElementById("sound");
      const TILE = 32, COLS = 24, ROWS = 15;
      const RENDER_SCALE = 1.5, VIEW_WIDTH = COLS * TILE, VIEW_HEIGHT = ROWS * TILE;
      const PLAYER_MOVE_MS = 140, ENEMY_MOVE_MS = 320, PLAYER_REPEAT_MS = 155;
      const HOLE_DIG_MS = 300, HOLE_CLOSE_MS = 300, HOLE_LIFETIME_MS = 2300;
      const BRICK_PALETTES = [
        ["#87359e","#a944bb","#e276eb","#672777","#361642","#ffd1ff"],
        ["#24618f","#347eae","#70d8ee","#17466d","#102b49","#c1f5ff"],
        ["#267342","#359852","#80df78","#1d5634","#103a29","#dcffad"]
      ];
      const SOUND_PATTERNS = {
        pickup: [[740,.08,0,"square",.035],[1100,.11,.08,"square",.03]],
        dig: [[220,.08,0,"sawtooth",.035,145],[145,.12,.07,"square",.025,90]],
        footstep: [[118,.05,0,"triangle",.018,72]],
        enemyCaught: [[310,.1,0,"sawtooth",.04,160],[150,.18,.09,"square",.035,65]],
        enemyReturn: [[260,.08,0,"square",.025],[390,.08,.08,"square",.025],[520,.13,.16,"triangle",.025]],
        playerHit: [[330,.1,0,"square",.04,220],[220,.12,.09,"square",.04,130],[130,.2,.2,"sawtooth",.035,70]],
        levelClear: [[523,.12,0,"square",.03],[659,.12,.12,"square",.03],[784,.2,.24,"triangle",.035]],
        victory: [[523,.14,0,"square",.03],[659,.14,.14,"square",.03],[784,.14,.28,"square",.03],[1047,.3,.42,"triangle",.035]],
        pause: [[440,.06,0,"square",.02],[330,.08,.07,"square",.02]]
      };
      const LEVELS = window.LODE_RUNNER_LEVELS;
      if (!Array.isArray(LEVELS)) throw new Error("Soubor levels.js se nepodařilo načíst.");
      const keys = new Set();
      let solids, ladders, ropes, gold, holes, player, enemies, score, lives, gameState;
      let levelIndex = 0, exitX = 0, exitActive = false;
      let lastStep = 0, enemyStep = 0, animation = 0, invulnerableUntil = 0;
      let audioContext = null, soundEnabled = true, audioUnavailable = false;

      function updateSoundButton() {
        soundButton.textContent = audioUnavailable
          ? "Zvuk není podporován"
          : `Zvuk: ${soundEnabled ? "zapnutý" : "vypnutý"}`;
        soundButton.setAttribute("aria-pressed", String(soundEnabled && !audioUnavailable));
        soundButton.disabled = audioUnavailable;
      }

      function activateAudio() {
        if (!soundEnabled || audioUnavailable) return;
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
          audioUnavailable = true;
          updateSoundButton();
          return;
        }
        if (!audioContext) audioContext = new AudioContextClass();
        if (audioContext.state === "suspended") {
          audioContext.resume().catch(error => {
            audioUnavailable = true;
            console.error("Zvuk nelze aktivovat:", error);
            updateSoundButton();
          });
        }
      }

      function playTone(frequency,duration,delay,waveform,volume,endFrequency) {
        if (!audioContext) return;
        const start = audioContext.currentTime + delay;
        const oscillator = audioContext.createOscillator();
        const envelope = audioContext.createGain();
        oscillator.type = waveform;
        oscillator.frequency.setValueAtTime(frequency,start);
        if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency,start+duration);
        envelope.gain.setValueAtTime(.0001,start);
        envelope.gain.exponentialRampToValueAtTime(volume,start+.008);
        envelope.gain.exponentialRampToValueAtTime(.0001,start+duration);
        oscillator.connect(envelope);
        envelope.connect(audioContext.destination);
        oscillator.start(start);
        oscillator.stop(start+duration+.01);
      }

      function playSfx(name) {
        if (!soundEnabled || audioUnavailable) return;
        activateAudio();
        for (const [frequency,duration,delay,waveform,volume,endFrequency] of SOUND_PATTERNS[name] || []) {
          playTone(frequency,duration,delay,waveform,volume,endFrequency);
        }
      }

      function newLevel(index) {
        if (index !== undefined) levelIndex = index;
        const level = LEVELS[levelIndex];
        keys.clear();
        solids = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
        ladders = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
        ropes = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
        gold = new Set();
        holes = [];
        level.platforms.forEach(([y,x1,x2]) => {
          for (let x = x1; x <= x2; x++) solids[y][x] = true;
        });
        level.ladders.forEach(([x,y1,y2]) => {
          for (let y = y1; y <= y2; y++) {
            ladders[y][x] = true;
            solids[y][x] = false;
          }
        });
        for (let y = 1; y < ROWS - 1; y++) {
          for (let x = 1; x < COLS - 1; x++) {
            if (solids[y + 1][x] && !ladders[y][x]) ropes[y][x] = true;
          }
        }
        level.gold.forEach(([x,y]) => gold.add(keyOf(x,y)));
        exitX = level.exitX;
        exitActive = false;
        player = { x: level.player[0], y: level.player[1], face: 1 };
        enemies = level.enemies.map(([x,y]) => ({
          x, y, spawnX: x, spawnY: y, direction: x < level.player[0] ? 1 : -1
        }));
        mapSelect.value = String(levelIndex);
        invulnerableUntil = performance.now() + 2000;
        gameState = "playing";
        updateStatus();
      }

      function keyOf(x, y) { return x + "," + y; }
      function inside(x, y) { return x >= 0 && x < COLS && y >= 0 && y < ROWS; }
      function solid(x, y) { return !inside(x,y) || solids[y][x]; }
      function ladderAt(x,y) { return inside(x,y) && ladders[y][x]; }
      function ropeAt(x,y) { return inside(x,y) && ropes[y][x]; }
      function supported(x,y) { return solid(x,y+1) || ladderAt(x,y) || ropeAt(x,y); }
      function open(x,y) { return inside(x,y) && !solid(x,y); }
      function holeAt(x,y) { return holes.some(h => h.x === x && h.y === y); }
      function updateStatus() {
        const remaining = gold.size;
        status.textContent = gameState === "won" ? "ÚROVEŇ DOKONČENA!" :
          gameState === "lost" ? "KONEC HRY" :
          gameState === "paused" ? "PAUZA" :
          exitActive
            ? `MAPA ${levelIndex + 1}/${LEVELS.length} · ŽEBŘÍK OTEVŘEN · VYLEZ NAHORU`
            : `MAPA ${levelIndex + 1}/${LEVELS.length} · ${LEVELS[levelIndex].name.toUpperCase()} · ZLATO ${remaining} · SKÓRE ${score} · ŽIVOTY ${lives}`;
      }

      function moveActor(actor,x,y,now,duration) {
        actor.motion = { fromX: actor.x, fromY: actor.y, startedAt: now, duration };
        actor.x = x;
        actor.y = y;
      }

      function moving(actor,now) {
        if (!actor.motion) return false;
        if (now - actor.motion.startedAt < actor.motion.duration) return true;
        actor.motion = null;
        return false;
      }

      function movePlayer(dx,dy,now) {
        if (gameState !== "playing") return;
        if (exitActive && player.x === exitX && player.y === 0) return;
        const nx = player.x + dx, ny = player.y + dy;
        if (!open(nx,ny)) return;
        if (dy !== 0 && !ladderAt(player.x,player.y) && !ladderAt(nx,ny)) return;
        if (dx !== 0 && !supported(player.x,player.y) && !ropeAt(player.x,player.y) &&
            !ladderAt(player.x,player.y)) return;
        moveActor(player,nx,ny,now,PLAYER_MOVE_MS);
        if (dx) {
          player.face = dx;
          playSfx("footstep");
        }
        collectGold(player);
        return true;
      }

      function collectGold(actor) {
        const k = keyOf(actor.x,actor.y);
        if (gold.delete(k)) {
          score += 100;
          playSfx("pickup");
          if (gold.size === 0) {
            exitActive = true;
            for (let y = 0; y <= 3; y++) {
              ladders[y][exitX] = true;
              solids[y][exitX] = false;
            }
          }
          updateStatus();
        }
      }

      function dig(dx) {
        if (gameState !== "playing") return;
        const x = player.x + dx, y = player.y + 1;
        if (!inside(x,y) || !solids[y][x] || holes.some(h => h.x === x && h.y === y)) return;
        solids[y][x] = false;
        if (y > 0) ropes[y - 1][x] = false;
        const now = performance.now();
        holes.push({ x, y, dugAt: now, closesAt: now + HOLE_LIFETIME_MS });
        playSfx("dig");
      }

      function gravity(actor,now,duration) {
        if (!moving(actor,now) && !supported(actor.x,actor.y) && open(actor.x,actor.y+1)) {
          moveActor(actor,actor.x,actor.y+1,now,duration);
          if (actor === player) collectGold(player);
          return true;
        }
        return false;
      }

      function enemyOptions(enemy) {
        const options = [];
        const x = enemy.x, y = enemy.y;
        if (!supported(x,y) && open(x,y+1)) return [{ x, y: y+1 }];
        for (const dx of [-1,1]) {
          if (open(x+dx,y) && (supported(x,y) || ladderAt(x,y) || ropeAt(x,y))) {
            options.push({x:x+dx,y});
          }
        }
        if (ladderAt(x,y)) {
          if (open(x,y-1) && ladderAt(x,y-1)) options.push({x,y:y-1});
          if (open(x,y+1) && ladderAt(x,y+1)) options.push({x,y:y+1});
        } else if (open(x,y+1) && !supported(x,y)) {
          options.push({x,y:y+1});
        }
        return options;
      }

      function hideEnemy(enemy,now) {
        enemy.hidden = true;
        enemy.returning = false;
        enemy.respawnAt = now + 4000;
        enemy.motion = null;
        const hole = holes.find(h => h.x === enemy.x && h.y === enemy.y);
        if (hole) hole.closesAt = Math.min(hole.closesAt, now + HOLE_CLOSE_MS);
        playSfx("enemyCaught");
      }

      function moveEnemy(enemy,now) {
        if (enemy.hidden || enemy.returning || moving(enemy,now)) return;
        if (holeAt(enemy.x,enemy.y+1) && open(enemy.x,enemy.y+1)) {
          moveActor(enemy,enemy.x,enemy.y+1,now,ENEMY_MOVE_MS);
        } else {
          gravity(enemy,now,ENEMY_MOVE_MS);
        }
        if (holeAt(enemy.x,enemy.y)) {
          hideEnemy(enemy,now);
          return;
        }
        if (enemy.motion) return;
        const start = keyOf(enemy.x,enemy.y);
        const queue = [{x:enemy.x,y:enemy.y,first:null}];
        const seen = new Set([start]);
        let target = null;
        let reachedPlayer = false;
        for (let i=0; i<queue.length && i<180; i++) {
          const node = queue[i];
          if (node.x === player.x && node.y === player.y) {
            target = node.first;
            reachedPlayer = true;
            break;
          }
          for (const next of enemyOptions(node)) {
            const k = keyOf(next.x,next.y);
            if (seen.has(k)) continue;
            seen.add(k);
            queue.push({x:next.x,y:next.y,first:node.first || next});
          }
        }
        if (reachedPlayer && !target) return;
        if (!target) {
          const options=enemyOptions(enemy);
          const horizontal=options.filter(next => next.y === enemy.y);
          target=horizontal.find(next => Math.sign(next.x-enemy.x) === enemy.direction) ||
            horizontal[0] || options[0];
          if (!target) {
            enemy.direction *= -1;
            return;
          }
        }
        if (target) {
          if (target.x !== enemy.x) enemy.direction=Math.sign(target.x-enemy.x);
          moveActor(enemy,target.x,target.y,now,ENEMY_MOVE_MS);
          if (holeAt(enemy.x,enemy.y)) hideEnemy(enemy,now);
        }
      }

      function updateEnemyRespawns(now) {
        for (const enemy of enemies) {
          if (enemy.hidden) {
            if (now < enemy.respawnAt) continue;
            enemy.hidden = false;
            enemy.returning = true;
            enemy.x = enemy.spawnX;
            enemy.y = -1;
            enemy.motion = null;
            playSfx("enemyReturn");
          }
          if (enemy.returning && !moving(enemy,now)) {
            if (!gravity(enemy,now,ENEMY_MOVE_MS)) enemy.returning = false;
            if (holeAt(enemy.x,enemy.y)) hideEnemy(enemy,now);
          }
        }
      }

      function loseLife(now) {
        playSfx("playerHit");
        lives--;
        if (lives <= 0) gameState = "lost";
        else {
          player.x = 2; player.y = 13;
          player.motion = null;
          enemies.forEach(e => {
            e.x=e.spawnX; e.y=e.spawnY; e.motion=null;
            e.hidden=false; e.returning=false; e.respawnAt=0;
          });
          invulnerableUntil = now + 2200;
        }
        updateStatus();
      }

      function checkCollision(now) {
        if (now < invulnerableUntil ||
            !enemies.some(e => !e.hidden && e.x === player.x && e.y === player.y)) return;
        loseLife(now);
      }

      function reachExit() {
        if (!exitActive || player.x !== exitX || player.y !== 0) return false;
        if (levelIndex < LEVELS.length - 1) {
          playSfx("levelClear");
          newLevel(levelIndex + 1);
        }
        else {
          gameState = "won";
          playSfx("victory");
          updateStatus();
        }
        return true;
      }

      function tick(now) {
        if (gameState !== "playing") return;
        if (!moving(player,now)) {
          if (reachExit()) return;
          let moved = false;
          if (now - lastStep > PLAYER_REPEAT_MS) {
            lastStep = now;
            if (keys.has("ArrowLeft") || keys.has("a")) moved = movePlayer(-1,0,now);
            else if (keys.has("ArrowRight") || keys.has("d")) moved = movePlayer(1,0,now);
            else if (keys.has("ArrowUp") || keys.has("w")) moved = movePlayer(0,-1,now);
            else if (keys.has("ArrowDown") || keys.has("s")) moved = movePlayer(0,1,now);
          }
          if (!moved) gravity(player,now,PLAYER_MOVE_MS);
        }
        if (now - enemyStep >= ENEMY_MOVE_MS) {
          enemyStep = now;
          enemies.forEach(enemy => moveEnemy(enemy,now));
        }
        updateEnemyRespawns(now);
        enemies.forEach(enemy => {
          if (!enemy.hidden && holeAt(enemy.x,enemy.y)) hideEnemy(enemy,now);
        });
        if (holeAt(player.x,player.y)) loseLife(now);
        checkCollision(now);
        holes = holes.filter(h => {
          if (now >= h.closesAt) {
            solids[h.y][h.x] = true;
            if (h.y > 0 && !ladders[h.y - 1][h.x]) ropes[h.y - 1][h.x] = true;
            return false;
          }
          return true;
        });
      }

      function draw() {
        animation++;
        const now=performance.now();
        ctx.setTransform(RENDER_SCALE,0,0,RENDER_SCALE,0,0);
        ctx.imageSmoothingEnabled=false;
        const backdrop=ctx.createLinearGradient(0,0,0,VIEW_HEIGHT);
        backdrop.addColorStop(0,"#080f2b");
        backdrop.addColorStop(.52,"#101a3c");
        backdrop.addColorStop(1,"#201344");
        ctx.fillStyle=backdrop;
        ctx.fillRect(0,0,VIEW_WIDTH,VIEW_HEIGHT);
        for (let i=0;i<42;i++) {
          const sx=(i*97+31)%VIEW_WIDTH, sy=(i*53+19)%VIEW_HEIGHT;
          ctx.fillStyle=i%4===0 ? "#75e8ff55" : "#b9c9ff2a";
          ctx.fillRect(sx,sy,i%7===0 ? 2 : 1,i%7===0 ? 2 : 1);
        }
        const haze=ctx.createRadialGradient(VIEW_WIDTH*.52,VIEW_HEIGHT*.45,12,VIEW_WIDTH*.52,VIEW_HEIGHT*.45,VIEW_WIDTH*.7);
        haze.addColorStop(0,"#6e60d015");
        haze.addColorStop(1,"#080a2000");
        ctx.fillStyle=haze;
        ctx.fillRect(0,0,VIEW_WIDTH,VIEW_HEIGHT);
        for (let y=0; y<ROWS; y++) {
          for (let x=0; x<COLS; x++) {
            const px=x*TILE, py=y*TILE;
            if (solids[y][x]) drawBrick(px,py,x,y);
            if (ladders[y][x]) drawLadder(px,py,exitActive && x === exitX);
            if (ropes[y][x] && !ladders[y][x] && !solid(x,y)) drawRope(px,py);
          }
        }
        for (const h of holes) {
          const x=h.x*TILE, y=h.y*TILE;
          const opening=Math.min(1,Math.max(0,(now-h.dugAt)/HOLE_DIG_MS));
          const closing=Math.min(1,Math.max(0,1-(h.closesAt-now)/HOLE_CLOSE_MS));
          const aperture=Math.max(0,Math.min(opening,1-closing));
          drawBrick(x,y,h.x,h.y);
          if (aperture > 0) {
            const inset=(1-aperture)*TILE/2;
            ctx.save();
            ctx.beginPath();
            ctx.rect(x+inset,y+inset,TILE-2*inset,TILE-2*inset);
            ctx.clip();
            const pit=ctx.createLinearGradient(x,y,x,y+TILE);
            pit.addColorStop(0,"#120d2a");
            pit.addColorStop(1,"#030611");
            ctx.fillStyle=pit; ctx.fillRect(x,y,TILE,TILE);
            ctx.fillStyle="#fb628f"; ctx.fillRect(x,y,TILE,3);
            ctx.fillStyle="#8d326e"; ctx.fillRect(x+3,y+4,TILE-6,3);
            ctx.fillStyle="#382044"; ctx.fillRect(x+6,y+9,TILE-12,2);
            ctx.fillStyle="#08091c"; ctx.fillRect(x+4,y+12,TILE-8,TILE-12);
            ctx.restore();
          }
        }
        for (const item of gold) {
          const [x,y]=item.split(",").map(Number), pulse=Math.sin(animation/8+x)*.7;
          const cx=x*TILE+16, cy=y*TILE+25, radius=5.5+pulse;
          ctx.fillStyle="#08091c88";
          ctx.fillRect(cx-6,y*TILE+30,12,2);
          ctx.shadowColor="#ffdc4c"; ctx.shadowBlur=9;
          ctx.fillStyle="#ffcf42";
          ctx.beginPath();
          ctx.moveTo(cx,cy-radius); ctx.lineTo(cx+radius*.72,cy-radius*.2);
          ctx.lineTo(cx+radius*.55,cy+radius*.68); ctx.lineTo(cx,cy+radius);
          ctx.lineTo(cx-radius*.55,cy+radius*.68); ctx.lineTo(cx-radius*.72,cy-radius*.2);
          ctx.closePath(); ctx.fill();
          ctx.shadowBlur=0;
          ctx.fillStyle="#fff39a";
          ctx.beginPath(); ctx.moveTo(cx,cy-radius+2); ctx.lineTo(cx+3,cy-2);
          ctx.lineTo(cx,cy+1); ctx.lineTo(cx-3,cy-2); ctx.closePath(); ctx.fill();
          ctx.fillStyle="#f28b31"; ctx.fillRect(cx+2,cy+2,2,4);
          ctx.fillStyle="#fffbd0"; ctx.fillRect(cx-1,cy-radius+2,2,3);
        }
        enemies.filter(enemy => !enemy.hidden).forEach(enemy => drawEnemy(enemy,now));
        drawPlayer(now);
        if (gameState === "won" || gameState === "lost" || gameState === "paused") {
          ctx.fillStyle="#07071bdc"; ctx.fillRect(0,0,VIEW_WIDTH,VIEW_HEIGHT);
          ctx.textAlign="center";
          ctx.fillStyle=gameState==="won" ? "#a7ff82" : "#f9db4a";
          ctx.font="bold 34px Courier New";
          ctx.fillText(gameState==="won" ? "VÝBORNĚ!" : gameState==="lost" ? "KONEC HRY" : "PAUZA",VIEW_WIDTH/2,VIEW_HEIGHT/2);
          ctx.fillStyle="#e7e7ff"; ctx.font="16px Courier New";
          const message=gameState==="won"
            ? levelIndex < LEVELS.length - 1 ? "Stiskni Enter pro další mapu" : "Všechny mapy dokončeny!"
            : gameState==="lost" ? "Stiskni Enter pro novou hru" : "Stiskni P pro pokračování";
          ctx.fillText(message,VIEW_WIDTH/2,VIEW_HEIGHT/2+32);
        }
      }

      function drawBrick(x,y,col,row) {
        const [base,alternate,highlight,shadow,mortar,glint]=BRICK_PALETTES[levelIndex];
        const varied=(col*3+row*5)%4===0;
        ctx.fillStyle=varied ? alternate : base;
        ctx.fillRect(x,y,TILE,TILE);
        ctx.fillStyle=mortar; ctx.fillRect(x,y+15,TILE,2);
        ctx.fillRect(x+(row%2)*16,y,1,15);
        ctx.fillRect(x+((row+1)%2)*16,y+17,1,15);
        ctx.fillStyle=highlight;
        ctx.fillRect(x+2,y+2,TILE-4,2);
        ctx.fillRect(x+3,y+5,10,1);
        ctx.fillRect(x+18,y+18,9,1);
        ctx.fillStyle=shadow;
        ctx.fillRect(x+2,y+13,TILE-4,2);
        ctx.fillRect(x+2,y+29,TILE-4,2);
        ctx.fillRect(x+15,y+4,2,8);
        ctx.fillRect(x+((row+1)%2)*16+14,y+20,2,7);
        ctx.fillStyle=glint;
        ctx.fillRect(x+5,y+7,2,1);
        ctx.fillRect(x+23,y+22,2,1);
      }

      function drawLadder(x,y,isExit) {
        const rail=isExit ? "#fff07c" : "#65dcf4";
        const bright=isExit ? "#fffbd0" : "#b7f7ff";
        ctx.fillStyle="#11152d";
        ctx.fillRect(x+7,y,5,TILE); ctx.fillRect(x+21,y,5,TILE);
        ctx.fillStyle=rail;
        ctx.fillRect(x+8,y,3,TILE); ctx.fillRect(x+21,y,3,TILE);
        ctx.fillStyle=bright;
        ctx.fillRect(x+8,y,1,TILE); ctx.fillRect(x+21,y,1,TILE);
        for (const rungY of [5,14,23]) {
          ctx.fillStyle="#15213a"; ctx.fillRect(x+10,y+rungY+1,13,4);
          ctx.fillStyle=rail; ctx.fillRect(x+10,y+rungY,13,3);
          ctx.fillStyle=bright; ctx.fillRect(x+11,y+rungY,11,1);
          ctx.fillStyle=isExit ? "#ffbe43" : "#438cae";
          ctx.fillRect(x+12,y+rungY+2,8,1);
        }
      }

      function drawRope(x,y) {
        ctx.fillStyle="#513820"; ctx.fillRect(x,y+8,TILE,4);
        ctx.fillStyle="#d18b3b"; ctx.fillRect(x,y+7,TILE,2);
        ctx.fillStyle="#ffe28a"; ctx.fillRect(x+2,y+7,TILE-4,1);
        for (let knot=5;knot<TILE;knot+=8) {
          ctx.fillStyle="#f8c861"; ctx.fillRect(x+knot,y+5,2,3);
          ctx.fillStyle="#8a572c"; ctx.fillRect(x+knot+2,y+8,2,2);
        }
      }

      function actorPosition(actor,now) {
        if (!actor.motion) return { x:actor.x, y:actor.y };
        const progress=Math.min(1,(now-actor.motion.startedAt)/actor.motion.duration);
        return {
          x:actor.motion.fromX+(actor.x-actor.motion.fromX)*progress,
          y:actor.motion.fromY+(actor.y-actor.motion.fromY)*progress
        };
      }

      function drawPlayer(now) {
        const position=actorPosition(player,now);
        const x=position.x*TILE, y=position.y*TILE;
        const step=player.motion ? Math.sin(animation/2)*1.5 : 0;
        ctx.fillStyle="#02081699";
        ctx.beginPath(); ctx.ellipse(x+16,y+30,10,2,0,0,Math.PI*2); ctx.fill();
        ctx.fillStyle="#172348";
        ctx.fillRect(x+9,y+24,6,6+step); ctx.fillRect(x+17,y+24,6,6-step);
        ctx.fillStyle="#394b88";
        ctx.fillRect(x+10,y+23,5,5+step); ctx.fillRect(x+17,y+23,5,5-step);
        ctx.fillStyle="#292544";
        ctx.fillRect(x+7,y+28+step,9,3); ctx.fillRect(x+17,y+28-step,9,3);
        ctx.fillStyle="#ffd36b";
        ctx.fillRect(x+8,y+30+step,8,1); ctx.fillRect(x+18,y+30-step,8,1);
        ctx.fillStyle="#143c63";
        ctx.fillRect(x+7,y+10,18,16);
        ctx.fillStyle="#21a7bf";
        ctx.fillRect(x+8,y+11,16,13);
        ctx.fillStyle="#4de0dd";
        ctx.fillRect(x+9,y+12,5,8); ctx.fillRect(x+17,y+12,5,3);
        ctx.fillStyle="#f06c9d";
        ctx.fillRect(x+7,y+17,18,3);
        ctx.fillStyle="#ffd16d";
        ctx.fillRect(x+7,y+18,18,1);
        ctx.fillStyle="#e9a76f";
        ctx.fillRect(x+5,y+12,4,9); ctx.fillRect(x+23,y+12,4,9);
        ctx.fillStyle="#ffe0a6";
        ctx.fillRect(x+6,y+18,4,4); ctx.fillRect(x+22,y+18,4,4);
        ctx.fillStyle="#ad684c";
        ctx.fillRect(x+10,y+2,13,11);
        ctx.fillStyle="#ffd19b";
        ctx.fillRect(x+11,y+4,11,8);
        ctx.fillRect(x+9,y+7,3,4); ctx.fillRect(x+21,y+7,3,4);
        ctx.fillStyle="#583651";
        ctx.fillRect(x+9,y+1,15,4); ctx.fillRect(x+10,y+3,3,3);
        ctx.fillStyle="#f2bc48";
        ctx.fillRect(x+9,y+4,14,2);
        const eyeX=player.face>0 ? x+19 : x+12;
        ctx.fillStyle="#fff8d8"; ctx.fillRect(eyeX,y+6,3,3);
        ctx.fillStyle="#18304d"; ctx.fillRect(eyeX+(player.face>0 ? 1 : 0),y+7,2,2);
        ctx.fillStyle="#9e4c57"; ctx.fillRect(x+15,y+10,4,1);
      }

      function drawEnemy(enemy,now) {
        const position=actorPosition(enemy,now);
        const x=position.x*TILE,y=position.y*TILE;
        const step=enemy.motion ? Math.sin(animation/2)*1.2 : 0;
        ctx.fillStyle="#02081699";
        ctx.beginPath(); ctx.ellipse(x+16,y+30,10,2,0,0,Math.PI*2); ctx.fill();
        ctx.fillStyle="#26223a";
        ctx.fillRect(x+9,y+24,6,6+step); ctx.fillRect(x+17,y+24,6,6-step);
        ctx.fillStyle="#e1ae47";
        ctx.fillRect(x+7,y+28+step,9,3); ctx.fillRect(x+17,y+28-step,9,3);
        ctx.fillStyle="#662744";
        ctx.fillRect(x+7,y+10,18,16);
        ctx.fillStyle="#d43861";
        ctx.fillRect(x+8,y+11,16,13);
        ctx.fillStyle="#fa6680";
        ctx.fillRect(x+9,y+12,5,8); ctx.fillRect(x+18,y+12,4,3);
        ctx.fillStyle="#87294b";
        ctx.fillRect(x+7,y+17,18,3);
        ctx.fillStyle="#ffc15e";
        ctx.fillRect(x+7,y+18,18,1);
        ctx.fillStyle="#df8f6e";
        ctx.fillRect(x+5,y+13,4,8); ctx.fillRect(x+23,y+13,4,8);
        ctx.fillStyle="#ffc39a";
        ctx.fillRect(x+6,y+18,4,4); ctx.fillRect(x+22,y+18,4,4);
        ctx.fillStyle="#6a3546";
        ctx.fillRect(x+9,y+2,14,11);
        ctx.fillStyle="#ffd0a1";
        ctx.fillRect(x+10,y+4,12,8);
        ctx.fillRect(x+8,y+7,3,4); ctx.fillRect(x+21,y+7,3,4);
        ctx.fillStyle="#7f3043";
        ctx.fillRect(x+8,y+1,16,4);
        ctx.fillRect(x+9,y,4,3); ctx.fillRect(x+19,y,4,3);
        ctx.fillStyle="#fff7d4";
        ctx.fillRect(x+11,y+6,4,3); ctx.fillRect(x+18,y+6,4,3);
        ctx.fillStyle="#392540";
        ctx.fillRect(x+13,y+7,2,2); ctx.fillRect(x+19,y+7,2,2);
        ctx.fillStyle="#a8434f";
        ctx.fillRect(x+14,y+10,5,1);
      }

      function loop(now) {
        tick(now); draw();
        requestAnimationFrame(loop);
      }

      window.addEventListener("keydown", event => {
        const key=event.key;
        activateAudio();
        if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"," "].includes(key)) event.preventDefault();
        const movement = {
          ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1],
          a: [-1,0], d: [1,0], w: [0,-1], s: [0,1]
        }[key];
        if (movement && !keys.has(key) && gameState === "playing") {
          const now=performance.now();
          if (!moving(player,now)) movePlayer(movement[0],movement[1],now);
          lastStep = now;
        }
        if (key.toLowerCase()==="z" || key.toLowerCase()==="y") dig(-1);
        if (key.toLowerCase()==="x") dig(1);
        if (key.toLowerCase()==="p") {
          if (gameState==="playing") gameState="paused";
          else if (gameState==="paused") gameState="playing";
          playSfx("pause");
          updateStatus();
        }
        if (key==="Enter" && (gameState==="won" || gameState==="lost")) {
          if (gameState==="won" && levelIndex < LEVELS.length - 1) newLevel(levelIndex + 1);
          else {
            score=0; lives=3; newLevel(gameState==="won" ? 0 : levelIndex);
          }
        }
        keys.add(key);
      });
      window.addEventListener("keyup", event => keys.delete(event.key));
      window.addEventListener("blur", () => keys.clear());
      mapSelect.addEventListener("change", () => {
        score=0; lives=3; newLevel(Number(mapSelect.value));
      });
      document.getElementById("restart").addEventListener("click", () => { score=0; lives=3; newLevel(levelIndex); });
      document.getElementById("pause").addEventListener("click", () => {
        if (gameState==="playing") gameState="paused";
        else if (gameState==="paused") gameState="playing";
        playSfx("pause");
        updateStatus();
      });
      soundButton.addEventListener("click", () => {
        soundEnabled = !soundEnabled;
        updateSoundButton();
        if (soundEnabled) playSfx("pickup");
      });
      updateSoundButton();
      score=0; lives=3; newLevel(); requestAnimationFrame(loop);
    })();
