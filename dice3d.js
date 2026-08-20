import * as THREE from './vendor/three.module.min.js';

const DIE_COLORS = {
  4: 0x9ca888,
  6: 0xc4b37a,
  8: 0xd69c65,
  10: 0xcb7e5d,
  12: 0xd36854,
  20: 0xb85f56,
};

const LABEL_INK = '#f4ead2';
const LABEL_BG = 'rgba(20, 21, 17, 0.88)';
const EXPLODE_COLOR = '#c56a52';

export class DiceTray3D {
  constructor(container) {
    if (!(container instanceof HTMLElement)) throw new TypeError('DiceTray3D requires an HTML container.');

    this.container = container;
    this.prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.pointer = new THREE.Vector2();
    this.pointerTarget = new THREE.Vector2();
    this.dice = [];
    this.motion = null;
    this.lastFrame = performance.now();
    this.disposed = false;
    this.frameHandle = 0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(37, 1, 0.1, 80);
    this.camera.position.set(0, 6.7, 10.4);
    this.cameraTarget = new THREE.Vector3(0, 0.55, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'dice-canvas';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.container.prepend(this.renderer.domElement);
    this.container.classList.add('has-webgl');

    this.diceRoot = new THREE.Group();
    this.scene.add(this.diceRoot);
    this.#createStage();
    this.#createLights();
    this.#bindEvents();
    this.#resize();
    this.#startLoop();
  }

  showPool(pool) {
    this.#cancelMotion();
    this.#replaceDice(pool.map((die) => ({ ...die, total: null, exploded: false })), false);
    this.container.classList.remove('is-rolling');
  }

  async roll(items) {
    this.#cancelMotion();
    this.#replaceDice(items.map((item) => ({ ...item, total: null })), true);
    if (!items.length) return;

    const reduced = this.prefersReducedMotion.matches;
    const start = performance.now();
    const motions = this.dice.map((entry, index) => {
      const target = entry.targetPosition.clone();
      return {
        entry,
        result: items[index],
        startPosition: new THREE.Vector3(
          target.x + randomBetween(-2.6, 2.6),
          reduced ? target.y + 0.35 : randomBetween(4.1, 6.2),
          target.z + randomBetween(-2.8, 1.2),
        ),
        target,
        delay: reduced ? index * 18 : index * 65,
        duration: reduced ? 210 : randomBetween(900, 1220),
        targetRotation: new THREE.Euler(
          randomBetween(-0.9, 0.9),
          randomBetween(-Math.PI, Math.PI),
          randomBetween(-0.7, 0.7),
          'XYZ',
        ),
        turns: new THREE.Vector3(
          reduced ? 0.2 : randomBetween(2.4, 4.5),
          reduced ? 0.25 : randomBetween(2.7, 5.2),
          reduced ? 0.15 : randomBetween(1.8, 3.8),
        ),
      };
    });

    for (const item of motions) {
      item.entry.group.position.copy(item.startPosition);
      item.entry.label.material.opacity = 0;
      item.entry.shadow.material.opacity = 0.08;
    }

    this.container.classList.add('is-rolling');
    await new Promise((resolve) => {
      this.motion = {
        start,
        motions,
        resolve,
        end: Math.max(...motions.map((item) => item.delay + item.duration)),
      };
    });
  }

  announce(text) {
    const narration = document.querySelector('#diceNarration');
    if (narration) narration.textContent = text;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.container.removeEventListener('pointermove', this.onPointerMove);
    this.container.removeEventListener('pointerleave', this.onPointerLeave);
    this.#cancelMotion();
    this.#clearDice();
    this.floorGeometry?.dispose();
    this.floorMaterial?.dispose();
    this.grid?.geometry?.dispose();
    this.grid?.material?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  #createStage() {
    this.floorGeometry = new THREE.CircleGeometry(7.5, 72);
    this.floorMaterial = new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.34, transparent: true, depthWrite: false });
    const floor = new THREE.Mesh(this.floorGeometry, this.floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.04;
    floor.receiveShadow = true;
    this.scene.add(floor);

    this.grid = new THREE.GridHelper(18, 18, 0x77735f, 0x47483f);
    this.grid.position.y = 0;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.09;
    this.grid.material.depthWrite = false;
    this.scene.add(this.grid);
  }

  #createLights() {
    this.scene.add(new THREE.HemisphereLight(0xf6e4ba, 0x171914, 2.4));

    const key = new THREE.DirectionalLight(0xffdda0, 4.2);
    key.position.set(-4.5, 8.5, 5.5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 25;
    key.shadow.camera.left = -8;
    key.shadow.camera.right = 8;
    key.shadow.camera.top = 8;
    key.shadow.camera.bottom = -8;
    key.shadow.bias = -0.0004;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0xc36d56, 2.1);
    rim.position.set(5, 3.5, -5);
    this.scene.add(rim);
  }

  #bindEvents() {
    this.onPointerMove = (event) => {
      const bounds = this.container.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      this.pointerTarget.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -(((event.clientY - bounds.top) / bounds.height) * 2 - 1),
      );
    };
    this.onPointerLeave = () => this.pointerTarget.set(0, 0);
    this.onVisibilityChange = () => {
      if (!document.hidden) {
        this.lastFrame = performance.now();
        this.#startLoop();
      }
    };
    this.container.addEventListener('pointermove', this.onPointerMove, { passive: true });
    this.container.addEventListener('pointerleave', this.onPointerLeave, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.resizeObserver = new ResizeObserver(() => this.#resize());
    this.resizeObserver.observe(this.container);
  }

  #replaceDice(items, prepareForRoll) {
    this.#clearDice();
    if (!items.length) {
      this.container.classList.add('is-empty');
      this.renderer.render(this.scene, this.camera);
      return;
    }

    this.container.classList.remove('is-empty');
    const positions = layoutPositions(items.length);
    items.forEach((item, index) => {
      const entry = this.#createDie(item, index);
      entry.targetPosition.copy(positions[index]);
      entry.group.position.copy(entry.targetPosition);
      entry.group.rotation.set(randomBetween(-0.45, 0.45), randomBetween(-Math.PI, Math.PI), randomBetween(-0.3, 0.3));
      entry.label.position.copy(entry.targetPosition);
      entry.shadow.position.set(entry.targetPosition.x, 0.01, entry.targetPosition.z);
      if (prepareForRoll) entry.label.material.opacity = 0;
      this.diceRoot.add(entry.group, entry.label, entry.shadow);
      this.dice.push(entry);
    });
    this.#frameDice(items.length);
  }

  #createDie(item, index) {
    const geometry = createGeometry(item.sides);
    geometry.computeVertexNormals();
    const baseColor = new THREE.Color(DIE_COLORS[item.sides] ?? 0xc4b37a);
    const material = new THREE.MeshStandardMaterial({
      color: baseColor,
      roughness: 0.32,
      metalness: 0.18,
      flatShading: true,
      emissive: baseColor.clone().multiplyScalar(0.055),
      emissiveIntensity: 1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const edgeGeometry = new THREE.EdgesGeometry(geometry, 18);
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: baseColor.clone().lerp(new THREE.Color(0xfff4d7), 0.45),
      transparent: true,
      opacity: 0.56,
    });
    mesh.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));
    const group = new THREE.Group();
    group.add(mesh);

    const label = createLabelSprite('?', item.sides, Boolean(item.exploded));
    label.renderOrder = 20 + index;
    const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.23, depthWrite: false });
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.8, 32), shadowMaterial);
    shadow.rotation.x = -Math.PI / 2;

    return {
      group,
      geometry,
      material,
      edgeGeometry,
      edgeMaterial,
      label,
      shadow,
      targetPosition: new THREE.Vector3(),
    };
  }

  #clearDice() {
    for (const entry of this.dice) {
      this.diceRoot.remove(entry.group, entry.label, entry.shadow);
      entry.geometry.dispose();
      entry.material.dispose();
      entry.edgeGeometry.dispose();
      entry.edgeMaterial.dispose();
      entry.label.material.map?.dispose();
      entry.label.material.dispose();
      entry.shadow.geometry.dispose();
      entry.shadow.material.dispose();
    }
    this.dice.length = 0;
  }

  #updateMotion(now) {
    if (!this.motion) return;
    const elapsed = now - this.motion.start;
    for (const item of this.motion.motions) {
      const t = THREE.MathUtils.clamp((elapsed - item.delay) / item.duration, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3.2);
      const lift = this.prefersReducedMotion.matches
        ? Math.sin(Math.PI * t) * 0.25
        : Math.sin(Math.PI * t) * 2.35 + Math.abs(Math.sin(Math.PI * t * 3.1)) * 0.42 * (1 - t);

      item.entry.group.position.lerpVectors(item.startPosition, item.target, eased);
      item.entry.group.position.y = THREE.MathUtils.lerp(item.startPosition.y, item.target.y, eased) + lift;
      item.entry.group.rotation.set(
        item.targetRotation.x + (1 - eased) * item.turns.x * Math.PI * 2,
        item.targetRotation.y + (1 - eased) * item.turns.y * Math.PI * 2,
        item.targetRotation.z + (1 - eased) * item.turns.z * Math.PI * 2,
      );
      item.entry.label.position.copy(item.entry.group.position);
      item.entry.label.position.y += 0.06;
      item.entry.label.material.opacity = smoothstep(0.58, 0.88, t) * 0.92;
      item.entry.shadow.position.set(item.entry.group.position.x, 0.01, item.entry.group.position.z);
      const scale = THREE.MathUtils.clamp(1.25 - item.entry.group.position.y * 0.1, 0.55, 1.1);
      item.entry.shadow.scale.setScalar(scale);
      item.entry.shadow.material.opacity = THREE.MathUtils.lerp(0.07, 0.25, t);
    }

    if (elapsed >= this.motion.end) {
      const finished = this.motion;
      this.motion = null;
      for (const item of finished.motions) {
        item.entry.group.position.copy(item.target);
        item.entry.label.position.copy(item.target);
        item.entry.label.position.y += 0.06;
        item.entry.label.material.opacity = 0.96;
        updateLabelSprite(item.entry.label, item.result.total, item.result.sides, Boolean(item.result.exploded));
        item.entry.shadow.position.set(item.target.x, 0.01, item.target.z);
        item.entry.shadow.scale.setScalar(1);
        item.entry.shadow.material.opacity = 0.23;
      }
      this.container.classList.remove('is-rolling');
      finished.resolve();
    }
  }

  #cancelMotion() {
    if (!this.motion) return;
    const pending = this.motion;
    this.motion = null;
    this.container.classList.remove('is-rolling');
    pending.resolve();
  }

  #frameDice(count) {
    const narrow = this.container.clientWidth < 560;
    const rows = count > 4 ? 2 : 1;
    this.camera.position.z = narrow ? 12.5 : rows > 1 ? 11.5 : 10.2;
    this.camera.position.y = narrow ? 7.6 : 6.7;
    this.camera.lookAt(this.cameraTarget);
  }

  #resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.#frameDice(this.dice.length);
    this.renderer.render(this.scene, this.camera);
  }

  #startLoop() {
    if (this.disposed || this.frameHandle || document.hidden) return;
    const tick = (now) => {
      this.frameHandle = 0;
      if (this.disposed || document.hidden) return;
      const delta = Math.min(0.05, Math.max(0, (now - this.lastFrame) / 1000));
      this.lastFrame = now;
      this.pointer.lerp(this.pointerTarget, 0.07);
      const cameraY = (this.container.clientWidth < 560 ? 7.6 : 6.7) + this.pointer.y * 0.36;
      this.camera.position.x = THREE.MathUtils.lerp(this.camera.position.x, this.pointer.x * 0.72, 0.055);
      this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, cameraY, 0.055);
      if (!this.motion && !this.prefersReducedMotion.matches) {
        for (const entry of this.dice) entry.group.rotation.y += delta * 0.12;
      }
      this.#updateMotion(now);
      this.camera.lookAt(this.cameraTarget);
      this.renderer.render(this.scene, this.camera);
      this.frameHandle = requestAnimationFrame(tick);
    };
    this.frameHandle = requestAnimationFrame(tick);
  }
}

function createGeometry(sides) {
  switch (sides) {
    case 4: return new THREE.TetrahedronGeometry(1.02, 0);
    case 6: return new THREE.BoxGeometry(1.5, 1.5, 1.5);
    case 8: return new THREE.OctahedronGeometry(1.04, 0);
    case 10: {
      const geometry = new THREE.CylinderGeometry(0.78, 0.78, 1.42, 10, 1, false);
      geometry.rotateZ(Math.PI / 2);
      return geometry;
    }
    case 12: return new THREE.DodecahedronGeometry(1, 0);
    case 20: return new THREE.IcosahedronGeometry(1.03, 0);
    default: return new THREE.IcosahedronGeometry(1, 1);
  }
}

function layoutPositions(count) {
  const columns = Math.min(count, 4);
  const rows = Math.ceil(count / columns);
  const positions = [];
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / columns);
    const rowCount = Math.min(columns, count - row * columns);
    const column = index - row * columns;
    positions.push(new THREE.Vector3(
      (column - (rowCount - 1) / 2) * 2.15,
      1.03,
      (row - (rows - 1) / 2) * 2.02,
    ));
  }
  return positions;
}

function createLabelSprite(value, sides, exploded) {
  const material = new THREE.SpriteMaterial({
    map: createLabelTexture(value, sides, exploded),
    transparent: true,
    depthTest: false,
    depthWrite: false,
    opacity: 0.96,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.16, 1.16, 1);
  return sprite;
}

function updateLabelSprite(sprite, value, sides, exploded) {
  const previous = sprite.material.map;
  sprite.material.map = createLabelTexture(value, sides, exploded);
  sprite.material.needsUpdate = true;
  previous?.dispose();
}

function createLabelTexture(value, sides, exploded) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable.');
  context.translate(128, 128);
  context.shadowColor = 'rgba(0, 0, 0, 0.48)';
  context.shadowBlur = 18;
  context.beginPath();
  context.arc(0, 0, 76, 0, Math.PI * 2);
  context.fillStyle = LABEL_BG;
  context.fill();
  context.shadowBlur = 0;
  context.lineWidth = exploded ? 8 : 4;
  context.strokeStyle = exploded ? EXPLODE_COLOR : colorToCss(DIE_COLORS[sides] ?? 0xc4b37a);
  context.stroke();

  const valueText = String(value);
  const size = valueText.length > 3 ? 54 : valueText.length > 2 ? 65 : 78;
  context.fillStyle = LABEL_INK;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `900 ${size}px Georgia, 'Times New Roman', serif`;
  context.fillText(valueText, 0, -8);
  context.font = '700 20px ui-monospace, monospace';
  context.fillStyle = exploded ? EXPLODE_COLOR : 'rgba(244, 234, 210, 0.72)';
  context.fillText(`D${sides}${exploded ? ' !' : ''}`, 0, 50);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function colorToCss(value) { return `#${value.toString(16).padStart(6, '0')}`; }
function randomBetween(min, max) { return min + Math.random() * (max - min); }
function smoothstep(min, max, value) {
  if (value <= min) return 0;
  if (value >= max) return 1;
  const t = (value - min) / (max - min);
  return t * t * (3 - 2 * t);
}
