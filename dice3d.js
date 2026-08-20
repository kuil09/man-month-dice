import * as THREE from './vendor/three.module.min.js';
import * as CANNON from './vendor/cannon-es.js';

const DIE_COLORS = {
  4: 0x9ca888,
  6: 0xc4b37a,
  8: 0xd69c65,
  10: 0xcb7e5d,
  12: 0xd36854,
  20: 0xb85f56,
};

const TRAY = {
  halfWidth: 5.2,
  halfDepth: 3.25,
  wallHeight: 2.4,
  wallThickness: 0.24,
};
const FIXED_TIME_STEP = 1 / 60;
const MAX_SUB_STEPS = 5;
const MAX_ROLL_TIME_MS = 9000;
const STABLE_TIME_MS = 620;
const LINEAR_SLEEP_THRESHOLD_SQ = 0.17 ** 2;
const ANGULAR_SLEEP_THRESHOLD_SQ = 0.22 ** 2;
const MAX_EXPLOSION_DEPTH = 5;
const FACE_GROUP_DOT = 0.9995;
const POSITION_EPSILON = 1e-5;
const UP = new THREE.Vector3(0, 1, 0);
const FACE_FORWARD = new THREE.Vector3(0, 0, 1);
const TEMP_QUATERNION = new THREE.Quaternion();
const TEMP_WORLD_NORMAL = new THREE.Vector3();

export class DiceTray3D {
  constructor(container) {
    if (!(container instanceof HTMLElement)) throw new TypeError('DiceTray3D requires an HTML container.');

    this.container = container;
    this.prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.pointer = new THREE.Vector2();
    this.pointerTarget = new THREE.Vector2();
    this.dice = [];
    this.rollState = null;
    this.rollGeneration = 0;
    this.physicsSteps = 0;
    this.lastFrame = performance.now();
    this.disposed = false;
    this.frameHandle = 0;
    this.stageResources = [];

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(37, 1, 0.1, 80);
    this.camera.position.set(0, 6.9, 10.8);
    this.cameraTarget = new THREE.Vector3(0, 0.55, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'dice-canvas';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.renderer.domElement.dataset.physics = 'cannon-es';
    this.container.prepend(this.renderer.domElement);
    this.container.classList.add('has-webgl');
    this.container.dataset.renderer = 'three-cannon';
    this.container.dataset.physics = 'cannon-es';
    this.container.dataset.faceLabels = 'surface-material';

    this.diceRoot = new THREE.Group();
    this.scene.add(this.diceRoot);
    this.#createStage();
    this.#createLights();
    this.#createPhysicsWorld();
    this.#bindEvents();
    this.#resize();
    this.#startLoop();
  }

  showPool(pool) {
    this.#abortRoll();
    this.#clearDice();
    delete this.container.dataset.lastRoll;
    delete this.container.dataset.lastTopFaces;
    delete this.container.dataset.physicsSteps;

    if (!pool.length) {
      this.container.classList.add('is-empty');
      this.renderer.render(this.scene, this.camera);
      return;
    }

    this.container.classList.remove('is-empty', 'is-rolling');
    const positions = layoutPositions(pool.length);
    pool.forEach((die, index) => {
      const entry = this.#createDie(die, index);
      const previewValue = (index % die.sides) + 1;
      const face = entry.faces.find((candidate) => candidate.value === previewValue) ?? entry.faces[0];
      const orientation = quaternionForFaceUp(face.normal, index * 0.52);
      const base = positions[index];
      entry.group.quaternion.copy(orientation);
      entry.group.position.set(base.x, supportHeight(entry.vertices, orientation) + 0.025, base.z);
      this.diceRoot.add(entry.group);
      this.dice.push(entry);
    });
    this.#updateDiagnostics();
    this.#frameDice(this.dice.length);
  }

  async roll(pool) {
    this.#abortRoll();
    this.#clearDice();
    const generation = ++this.rollGeneration;
    this.physicsSteps = 0;
    this.container.classList.remove('is-empty');
    this.container.classList.add('is-rolling');

    if (!pool.length) {
      this.container.classList.remove('is-rolling');
      this.container.dataset.physicsSteps = '0';
      this.container.dataset.lastTopFaces = '';
      return { total: 0, items: [], detail: '0' };
    }

    const results = pool.map((die) => ({
      ...die,
      parts: [],
      total: 0,
      exploded: false,
    }));
    let pending = pool.map((die, rootIndex) => ({
      ...die,
      rootIndex,
      depth: 0,
      isExplosion: false,
    }));
    const settledValues = [];

    while (pending.length) {
      if (generation !== this.rollGeneration) throw new DOMException('Dice roll was cancelled.', 'AbortError');
      const batch = this.#spawnBatch(pending);
      await this.#settleBatch(batch, generation);
      if (generation !== this.rollGeneration) throw new DOMException('Dice roll was cancelled.', 'AbortError');

      const next = [];
      for (const entry of batch) {
        const value = readTopFace(entry);
        const result = results[entry.request.rootIndex];
        result.parts.push(value);
        result.total += value;
        settledValues.push(value);

        const exploded = Boolean(entry.request.explodes && value === entry.request.sides);
        if (exploded) {
          result.exploded = true;
          this.#markExploded(entry);
          if (entry.request.depth < MAX_EXPLOSION_DEPTH) {
            next.push({
              sides: entry.request.sides,
              explodes: true,
              rootIndex: entry.request.rootIndex,
              depth: entry.request.depth + 1,
              isExplosion: true,
            });
          }
        }
        this.#freezeBody(entry.body);
      }
      pending = next;
    }

    this.container.classList.remove('is-rolling');
    this.container.dataset.physicsSteps = String(this.physicsSteps);
    this.container.dataset.lastTopFaces = settledValues.join(',');
    this.#updateDiagnostics();
    const total = results.reduce((sum, item) => sum + item.total, 0);
    const detail = results.map((item) => item.parts.join(' + ')).join('  |  ') || '0';
    this.#frameDice(this.dice.length);
    return { total, items: results, detail };
  }

  debugState() {
    const dice = this.dice.map((entry) => ({
      sides: entry.item.sides,
      numberedFaces: entry.materials.length,
      numeralsInSurfaceMaterial: entry.materials.every((material) => Boolean(material.map && material.bumpMap)),
      separateNumberObjects: 0,
      hasBody: Boolean(entry.body),
      bodyType: entry.body ? entry.body.type : null,
      sleeping: entry.body ? entry.body.sleepState === CANNON.Body.SLEEPING : null,
      speed: entry.body ? Number(entry.body.velocity.length().toFixed(4)) : 0,
      angularSpeed: entry.body ? Number(entry.body.angularVelocity.length().toFixed(4)) : 0,
      upwardFace: entry.body ? readTopFace(entry) : null,
    }));
    return {
      renderer: 'three-cannon',
      physics: this.container.dataset.physics,
      faceLabels: this.container.dataset.faceLabels,
      numberedFaces: dice.reduce((sum, die) => sum + die.numberedFaces, 0),
      separateNumberObjects: 0,
      physicsBodies: dice.filter((die) => die.hasBody).length,
      physicsSteps: Number(this.container.dataset.physicsSteps || 0),
      topFaces: this.container.dataset.lastTopFaces || '',
      dice,
    };
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
    this.#abortRoll();
    this.#clearDice();
    for (const resource of this.stageResources) resource.dispose?.();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  #createStage() {
    const floorGeometry = new THREE.PlaneGeometry(TRAY.halfWidth * 2, TRAY.halfDepth * 2);
    const floorMaterial = new THREE.ShadowMaterial({
      color: 0x000000,
      opacity: 0.36,
      transparent: true,
      depthWrite: false,
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.stageResources.push(floorGeometry, floorMaterial);

    const grid = new THREE.GridHelper(TRAY.halfWidth * 2, 14, 0x77735f, 0x47483f);
    grid.scale.z = TRAY.halfDepth / TRAY.halfWidth;
    grid.position.y = 0.002;
    grid.material.transparent = true;
    grid.material.opacity = 0.1;
    grid.material.depthWrite = false;
    this.scene.add(grid);
    this.stageResources.push(grid.geometry, grid.material);

    const railMaterial = new THREE.MeshStandardMaterial({
      color: 0x34362f,
      roughness: 0.88,
      metalness: 0.05,
      transparent: true,
      opacity: 0.52,
    });
    const longRailGeometry = new THREE.BoxGeometry(TRAY.halfWidth * 2 + 0.4, 0.12, 0.12);
    const shortRailGeometry = new THREE.BoxGeometry(0.12, 0.12, TRAY.halfDepth * 2 + 0.4);
    for (const z of [-TRAY.halfDepth, TRAY.halfDepth]) {
      const rail = new THREE.Mesh(longRailGeometry, railMaterial);
      rail.position.set(0, 0.06, z);
      rail.receiveShadow = true;
      this.scene.add(rail);
    }
    for (const x of [-TRAY.halfWidth, TRAY.halfWidth]) {
      const rail = new THREE.Mesh(shortRailGeometry, railMaterial);
      rail.position.set(x, 0.06, 0);
      rail.receiveShadow = true;
      this.scene.add(rail);
    }
    this.stageResources.push(railMaterial, longRailGeometry, shortRailGeometry);
  }

  #createLights() {
    this.scene.add(new THREE.HemisphereLight(0xf6e4ba, 0x171914, 2.35));

    const key = new THREE.DirectionalLight(0xffdda0, 4.1);
    key.position.set(-4.5, 8.5, 5.5);
    key.castShadow = true;
    key.shadow.mapSize.set(1536, 1536);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 25;
    key.shadow.camera.left = -8;
    key.shadow.camera.right = 8;
    key.shadow.camera.top = 8;
    key.shadow.camera.bottom = -8;
    key.shadow.bias = -0.00035;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0xc36d56, 1.85);
    rim.position.set(5, 4, -5);
    this.scene.add(rim);
  }

  #createPhysicsWorld() {
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    this.world.allowSleep = true;
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.solver.iterations = 18;
    this.world.solver.tolerance = 0.001;

    this.diePhysicsMaterial = new CANNON.Material('dice');
    this.floorPhysicsMaterial = new CANNON.Material('tray');
    this.world.addContactMaterial(new CANNON.ContactMaterial(
      this.diePhysicsMaterial,
      this.floorPhysicsMaterial,
      {
        friction: 0.43,
        restitution: 0.25,
        contactEquationStiffness: 1e8,
        contactEquationRelaxation: 3,
        frictionEquationStiffness: 1e8,
        frictionEquationRelaxation: 3,
      },
    ));
    this.world.addContactMaterial(new CANNON.ContactMaterial(
      this.diePhysicsMaterial,
      this.diePhysicsMaterial,
      {
        friction: 0.24,
        restitution: 0.34,
        contactEquationStiffness: 1e8,
        contactEquationRelaxation: 3,
      },
    ));

    const floorBody = new CANNON.Body({ mass: 0, material: this.floorPhysicsMaterial });
    floorBody.addShape(new CANNON.Plane());
    floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(floorBody);

    const wallHeight = TRAY.wallHeight;
    const wallThickness = TRAY.wallThickness;
    const sideShape = new CANNON.Box(new CANNON.Vec3(
      wallThickness,
      wallHeight / 2,
      TRAY.halfDepth + wallThickness,
    ));
    const endShape = new CANNON.Box(new CANNON.Vec3(
      TRAY.halfWidth + wallThickness,
      wallHeight / 2,
      wallThickness,
    ));

    for (const x of [-TRAY.halfWidth - wallThickness, TRAY.halfWidth + wallThickness]) {
      const wall = new CANNON.Body({ mass: 0, material: this.floorPhysicsMaterial });
      wall.addShape(sideShape);
      wall.position.set(x, wallHeight / 2, 0);
      this.world.addBody(wall);
    }
    for (const z of [-TRAY.halfDepth - wallThickness, TRAY.halfDepth + wallThickness]) {
      const wall = new CANNON.Body({ mass: 0, material: this.floorPhysicsMaterial });
      wall.addShape(endShape);
      wall.position.set(0, wallHeight / 2, z);
      this.world.addBody(wall);
    }
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

  #createDie(item, index) {
    const sourceGeometry = createGeometry(item.sides);
    sourceGeometry.computeVertexNormals();
    const model = describePolyhedron(sourceGeometry, item.sides);
    const geometry = createNumberedGeometry(model);
    const baseColor = new THREE.Color(DIE_COLORS[item.sides] ?? 0xc4b37a);
    const materials = model.faces.map((face) => {
      const maps = createEngravedFaceMaps(face.value);
      return new THREE.MeshStandardMaterial({
        color: baseColor,
        map: maps.color,
        bumpMap: maps.bump,
        bumpScale: 0.075,
        roughness: 0.42,
        metalness: 0.08,
        flatShading: true,
        emissive: baseColor.clone().multiplyScalar(0.035),
        emissiveIntensity: 0.85,
      });
    });
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const edgeGeometry = new THREE.EdgesGeometry(sourceGeometry, 18);
    sourceGeometry.dispose();
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: baseColor.clone().lerp(new THREE.Color(0xfff4d7), 0.34),
      transparent: true,
      opacity: 0.48,
    });
    mesh.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));

    const group = new THREE.Group();
    group.add(mesh);
    group.userData.dieIndex = index;
    const shape = createCannonShape(model, item.sides);
    return {
      group,
      mesh,
      geometry,
      materials,
      edgeGeometry,
      edgeMaterial,
      item: { ...item },
      vertices: model.vertices,
      faces: model.faces,
      shape,
      body: null,
      request: null,
    };
  }

  #spawnBatch(requests) {
    const batch = [];
    const columns = Math.min(requests.length, 4);
    requests.forEach((request, index) => {
      const entry = this.#createDie(request, this.dice.length + index);
      entry.request = request;
      const body = new CANNON.Body({
        mass: dieMass(request.sides),
        material: this.diePhysicsMaterial,
        shape: entry.shape,
        linearDamping: 0.14,
        angularDamping: 0.12,
        allowSleep: true,
        sleepSpeedLimit: 0.18,
        sleepTimeLimit: 0.48,
      });
      const column = index % columns;
      const row = Math.floor(index / columns);
      const spawnX = (column - (columns - 1) / 2) * 1.72 + randomBetween(-0.3, 0.3);
      body.position.set(
        clamp(spawnX, -TRAY.halfWidth + 1, TRAY.halfWidth - 1),
        4.2 + row * 1.15 + randomBetween(0, 1.25),
        -2.25 + randomBetween(-0.35, 0.45),
      );
      body.quaternion.copy(randomQuaternion());
      body.velocity.set(
        randomBetween(-2.4, 2.4),
        randomBetween(-0.4, 1.3),
        randomBetween(2.4, 4.8),
      );
      body.angularVelocity.set(
        randomSigned(8.5, 14.5),
        randomSigned(8.5, 15.5),
        randomSigned(7.5, 13.5),
      );
      body.wakeUp();
      entry.body = body;
      this.world.addBody(body);
      this.diceRoot.add(entry.group);
      this.dice.push(entry);
      batch.push(entry);
      syncBodyToMesh(entry);
    });
    this.#updateDiagnostics();
    this.#frameDice(this.dice.length);
    return batch;
  }

  #updateDiagnostics() {
    this.container.dataset.numberedFaces = String(
      this.dice.reduce((sum, entry) => sum + entry.materials.length, 0),
    );
    this.container.dataset.separateNumberObjects = '0';
    this.container.dataset.physicsBodies = String(
      this.dice.reduce((sum, entry) => sum + Number(Boolean(entry.body)), 0),
    );
  }

  async #settleBatch(batch, generation) {
    if (this.prefersReducedMotion.matches) {
      let stableFrames = 0;
      for (let step = 0; step < 720; step += 1) {
        if (generation !== this.rollGeneration) return;
        this.world.step(FIXED_TIME_STEP);
        this.physicsSteps += 1;
        if (bodiesAreQuiet(batch)) stableFrames += 1;
        else stableFrames = 0;
        if (stableFrames > 45) break;
      }
      for (const entry of batch) entry.body.sleep();
      this.#syncAllBodies();
      return;
    }

    await new Promise((resolve) => {
      this.rollState = {
        generation,
        batch,
        startedAt: performance.now(),
        stableSince: 0,
        resolve,
      };
    });
  }

  #updatePhysics(now, delta) {
    if (!this.rollState) return;
    const state = this.rollState;
    this.world.step(FIXED_TIME_STEP, Math.min(delta, 0.1), MAX_SUB_STEPS);
    this.physicsSteps += 1;
    this.#syncAllBodies();

    if (bodiesAreQuiet(state.batch)) {
      if (!state.stableSince) state.stableSince = now;
      if (now - state.stableSince >= STABLE_TIME_MS) {
        this.#completeSettle(state);
        return;
      }
    } else {
      state.stableSince = 0;
    }

    if (now - state.startedAt >= MAX_ROLL_TIME_MS) {
      for (const entry of state.batch) {
        entry.body.velocity.setZero();
        entry.body.angularVelocity.setZero();
        entry.body.sleep();
      }
      this.#syncAllBodies();
      this.#completeSettle(state);
    }
  }

  #completeSettle(state) {
    if (this.rollState !== state) return;
    for (const entry of state.batch) entry.body.sleep();
    this.#syncAllBodies();
    this.rollState = null;
    state.resolve();
  }

  #freezeBody(body) {
    body.velocity.setZero();
    body.angularVelocity.setZero();
    body.force.setZero();
    body.torque.setZero();
    body.mass = 0;
    body.type = CANNON.Body.STATIC;
    body.updateMassProperties();
    body.aabbNeedsUpdate = true;
    body.sleep();
  }

  #markExploded(entry) {
    const danger = new THREE.Color(0xc56a52);
    for (const material of entry.materials) {
      material.emissive.copy(danger).multiplyScalar(0.35);
      material.emissiveIntensity = 1.5;
    }
    entry.edgeMaterial.color.copy(danger).lerp(new THREE.Color(0xffe1a3), 0.35);
    entry.edgeMaterial.opacity = 0.9;
  }

  #syncAllBodies() {
    for (const entry of this.dice) {
      if (entry.body) syncBodyToMesh(entry);
    }
  }

  #abortRoll() {
    this.rollGeneration += 1;
    if (this.rollState) {
      const pending = this.rollState;
      this.rollState = null;
      pending.resolve();
    }
    this.container.classList.remove('is-rolling');
  }

  #clearDice() {
    for (const entry of this.dice) {
      if (entry.body) this.world?.removeBody(entry.body);
      this.diceRoot.remove(entry.group);
      entry.geometry.dispose();
      for (const material of entry.materials) {
        material.map?.dispose();
        material.bumpMap?.dispose();
        material.dispose();
      }
      entry.edgeGeometry.dispose();
      entry.edgeMaterial.dispose();
    }
    this.dice.length = 0;
    this.#updateDiagnostics();
  }

  #frameDice(count) {
    const narrow = this.container.clientWidth < 560;
    const rows = count > 4 ? 2 : 1;
    this.camera.position.z = narrow ? 12.9 : rows > 1 ? 11.9 : 10.8;
    this.camera.position.y = narrow ? 7.8 : 6.9;
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
      const cameraY = (this.container.clientWidth < 560 ? 7.8 : 6.9) + this.pointer.y * 0.34;
      this.camera.position.x = THREE.MathUtils.lerp(this.camera.position.x, this.pointer.x * 0.68, 0.055);
      this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, cameraY, 0.055);
      this.#updatePhysics(now, delta);
      this.camera.lookAt(this.cameraTarget);
      this.renderer.render(this.scene, this.camera);
      this.frameHandle = requestAnimationFrame(tick);
    };
    this.frameHandle = requestAnimationFrame(tick);
  }
}

function createGeometry(sides) {
  switch (sides) {
    case 4: return new THREE.TetrahedronGeometry(1.08, 0);
    case 6: return new THREE.BoxGeometry(1.5, 1.5, 1.5);
    case 8: return new THREE.OctahedronGeometry(1.08, 0);
    case 10: {
      const geometry = new THREE.CylinderGeometry(0.8, 0.8, 1.44, 10, 1, false);
      geometry.rotateZ(Math.PI / 2);
      return geometry;
    }
    case 12: return new THREE.DodecahedronGeometry(1.04, 0);
    case 20: return new THREE.IcosahedronGeometry(1.08, 0);
    default: return new THREE.IcosahedronGeometry(1, 1);
  }
}

function describePolyhedron(geometry, sides) {
  const source = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const attribute = source.getAttribute('position');
  const rawGroups = [];

  for (let offset = 0; offset < attribute.count; offset += 3) {
    let a = new THREE.Vector3().fromBufferAttribute(attribute, offset);
    let b = new THREE.Vector3().fromBufferAttribute(attribute, offset + 1);
    let c = new THREE.Vector3().fromBufferAttribute(attribute, offset + 2);
    const center = a.clone().add(b).add(c).multiplyScalar(1 / 3);
    let normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    if (normal.dot(center) < 0) {
      [b, c] = [c, b];
      normal.negate();
    }
    let group = rawGroups.find((candidate) => candidate.normal.dot(normal) >= FACE_GROUP_DOT);
    if (!group) {
      group = { normal: normal.clone(), vertices: [] };
      rawGroups.push(group);
    }
    group.vertices.push(a, b, c);
  }
  source.dispose();

  const vertices = [];
  const vertexMap = new Map();
  const getVertexIndex = (vertex) => {
    const key = `${Math.round(vertex.x / POSITION_EPSILON)}:${Math.round(vertex.y / POSITION_EPSILON)}:${Math.round(vertex.z / POSITION_EPSILON)}`;
    if (vertexMap.has(key)) return vertexMap.get(key);
    const index = vertices.length;
    vertices.push(vertex.clone());
    vertexMap.set(key, index);
    return index;
  };

  const faces = rawGroups.map((group) => {
    const unique = [];
    const seen = new Set();
    for (const vertex of group.vertices) {
      const index = getVertexIndex(vertex);
      if (!seen.has(index)) {
        seen.add(index);
        unique.push(index);
      }
    }
    const center = unique.reduce((sum, index) => sum.add(vertices[index]), new THREE.Vector3()).multiplyScalar(1 / unique.length);
    const normal = group.normal.clone().normalize();
    const tangent = chooseFaceTangent(normal);
    const bitangent = normal.clone().cross(tangent).normalize();
    unique.sort((leftIndex, rightIndex) => {
      const left = vertices[leftIndex].clone().sub(center);
      const right = vertices[rightIndex].clone().sub(center);
      const leftAngle = Math.atan2(left.dot(bitangent), left.dot(tangent));
      const rightAngle = Math.atan2(right.dot(bitangent), right.dot(tangent));
      return leftAngle - rightAngle;
    });
    if (polygonNormal(unique, vertices).dot(normal) < 0) unique.reverse();
    const inradius = polygonInradius(unique, vertices, center);
    return {
      indices: unique,
      center,
      normal,
      labelSize: Math.max(0.34, inradius * (sides === 4 || sides === 8 ? 1.28 : 1.46)),
      value: 0,
    };
  });

  assignOppositeFaceValues(faces, sides);
  return { vertices, faces };
}

function createCannonShape(model, sides) {
  if (sides === 6) return new CANNON.Box(new CANNON.Vec3(0.75, 0.75, 0.75));
  return new CANNON.ConvexPolyhedron({
    vertices: model.vertices.map((vertex) => new CANNON.Vec3(vertex.x, vertex.y, vertex.z)),
    faces: model.faces.map((face) => [...face.indices]),
  });
}

function assignOppositeFaceValues(faces, sides) {
  const unassigned = new Set(faces.map((_, index) => index));
  let low = 1;
  let high = sides;
  while (unassigned.size) {
    const first = [...unassigned][0];
    unassigned.delete(first);
    let opposite = null;
    let smallestDot = Infinity;
    for (const candidate of unassigned) {
      const dot = faces[first].normal.dot(faces[candidate].normal);
      if (dot < smallestDot) {
        smallestDot = dot;
        opposite = candidate;
      }
    }
    faces[first].value = low;
    low += 1;
    if (opposite !== null) {
      faces[opposite].value = high;
      high -= 1;
      unassigned.delete(opposite);
    }
  }
}

function createNumberedGeometry(model) {
  const geometry = new THREE.BufferGeometry();
  const positions = [];
  const normals = [];
  const uvs = [];

  model.faces.forEach((face, materialIndex) => {
    const right = chooseFaceTangent(face.normal);
    const up = face.normal.clone().cross(right).normalize();
    const projected = face.indices.map((vertexIndex) => {
      const offset = model.vertices[vertexIndex].clone().sub(face.center);
      return { vertexIndex, u: offset.dot(right), v: offset.dot(up) };
    });
    const extent = Math.max(
      0.001,
      ...projected.flatMap(({ u, v }) => [Math.abs(u), Math.abs(v)]),
    ) * 2.16;
    const start = positions.length / 3;

    for (let triangle = 1; triangle < projected.length - 1; triangle += 1) {
      for (const point of [projected[0], projected[triangle], projected[triangle + 1]]) {
        const vertex = model.vertices[point.vertexIndex];
        positions.push(vertex.x, vertex.y, vertex.z);
        normals.push(face.normal.x, face.normal.y, face.normal.z);
        uvs.push(0.5 + point.u / extent, 0.5 + point.v / extent);
      }
    }
    geometry.addGroup(start, (projected.length - 2) * 3, materialIndex);
  });

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function chooseFaceTangent(normal) {
  const seed = Math.abs(normal.y) < 0.82 ? UP : FACE_FORWARD;
  return seed.clone().cross(normal).normalize();
}

function polygonNormal(indices, vertices) {
  const a = vertices[indices[0]];
  const b = vertices[indices[1]];
  const c = vertices[indices[2]];
  return b.clone().sub(a).cross(c.clone().sub(a)).normalize();
}

function polygonInradius(indices, vertices, center) {
  let minimum = Infinity;
  for (let index = 0; index < indices.length; index += 1) {
    const a = vertices[indices[index]];
    const b = vertices[indices[(index + 1) % indices.length]];
    const edge = b.clone().sub(a);
    const distance = edge.clone().cross(center.clone().sub(a)).length() / edge.length();
    minimum = Math.min(minimum, distance);
  }
  return Number.isFinite(minimum) ? minimum : 0.4;
}

function createEngravedFaceMaps(value) {
  const size = 512;
  const text = String(value);
  const fontSize = text.length > 1 ? 188 : 238;
  const colorCanvas = document.createElement('canvas');
  const bumpCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = size;
  bumpCanvas.width = bumpCanvas.height = size;
  const color = colorCanvas.getContext('2d');
  const bump = bumpCanvas.getContext('2d');
  if (!color || !bump) throw new Error('Canvas 2D context is unavailable.');

  color.fillStyle = '#f4f1e7';
  color.fillRect(0, 0, size, size);
  const glaze = color.createRadialGradient(210, 180, 20, 256, 256, 350);
  glaze.addColorStop(0, 'rgba(255,255,255,0.18)');
  glaze.addColorStop(1, 'rgba(90,73,44,0.08)');
  color.fillStyle = glaze;
  color.fillRect(0, 0, size, size);

  for (const context of [color, bump]) {
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `900 ${fontSize}px Georgia, 'Times New Roman', serif`;
    context.lineJoin = 'round';
  }

  color.fillStyle = 'rgba(255, 252, 230, 0.76)';
  color.fillText(text, 250, 247);
  color.fillStyle = 'rgba(25, 23, 18, 0.96)';
  color.fillText(text, 258, 260);
  color.lineWidth = 3;
  color.strokeStyle = 'rgba(5, 5, 4, 0.42)';
  color.strokeText(text, 258, 260);

  bump.fillStyle = '#999999';
  bump.fillRect(0, 0, size, size);
  bump.fillStyle = '#181818';
  bump.fillText(text, 256, 256);
  bump.lineWidth = 7;
  bump.strokeStyle = '#050505';
  bump.strokeText(text, 256, 256);

  if (value === 6 || value === 9) {
    const underlineY = 256 + fontSize * 0.38;
    const underlineWidth = fontSize * 0.34;
    color.lineCap = bump.lineCap = 'round';
    color.lineWidth = 10;
    color.strokeStyle = 'rgba(25, 23, 18, 0.96)';
    color.beginPath();
    color.moveTo(256 - underlineWidth / 2, underlineY);
    color.lineTo(256 + underlineWidth / 2, underlineY);
    color.stroke();
    bump.lineWidth = 13;
    bump.strokeStyle = '#181818';
    bump.beginPath();
    bump.moveTo(256 - underlineWidth / 2, underlineY);
    bump.lineTo(256 + underlineWidth / 2, underlineY);
    bump.stroke();
  }

  const colorTexture = new THREE.CanvasTexture(colorCanvas);
  colorTexture.colorSpace = THREE.SRGBColorSpace;
  colorTexture.minFilter = THREE.LinearMipmapLinearFilter;
  colorTexture.magFilter = THREE.LinearFilter;
  colorTexture.generateMipmaps = true;
  colorTexture.anisotropy = 4;

  const bumpTexture = new THREE.CanvasTexture(bumpCanvas);
  bumpTexture.minFilter = THREE.LinearMipmapLinearFilter;
  bumpTexture.magFilter = THREE.LinearFilter;
  bumpTexture.generateMipmaps = true;
  bumpTexture.anisotropy = 4;
  return { color: colorTexture, bump: bumpTexture };
}

function readTopFace(entry) {
  TEMP_QUATERNION.set(
    entry.body.quaternion.x,
    entry.body.quaternion.y,
    entry.body.quaternion.z,
    entry.body.quaternion.w,
  );
  let bestFace = entry.faces[0];
  let bestDot = -Infinity;
  for (const face of entry.faces) {
    TEMP_WORLD_NORMAL.copy(face.normal).applyQuaternion(TEMP_QUATERNION);
    const dot = TEMP_WORLD_NORMAL.y;
    if (dot > bestDot) {
      bestDot = dot;
      bestFace = face;
    }
  }
  return bestFace.value;
}

function syncBodyToMesh(entry) {
  entry.group.position.set(entry.body.position.x, entry.body.position.y, entry.body.position.z);
  entry.group.quaternion.set(
    entry.body.quaternion.x,
    entry.body.quaternion.y,
    entry.body.quaternion.z,
    entry.body.quaternion.w,
  );
}

function bodiesAreQuiet(entries) {
  return entries.every((entry) => {
    const body = entry.body;
    if (body.sleepState === CANNON.Body.SLEEPING) return true;
    return body.velocity.lengthSquared() <= LINEAR_SLEEP_THRESHOLD_SQ
      && body.angularVelocity.lengthSquared() <= ANGULAR_SLEEP_THRESHOLD_SQ;
  });
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
      0,
      (row - (rows - 1) / 2) * 2.02,
    ));
  }
  return positions;
}

function quaternionForFaceUp(normal, yaw) {
  const align = new THREE.Quaternion().setFromUnitVectors(normal, UP);
  const spin = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
  return spin.multiply(align);
}

function supportHeight(vertices, quaternion) {
  let minimumY = Infinity;
  for (const vertex of vertices) {
    minimumY = Math.min(minimumY, vertex.clone().applyQuaternion(quaternion).y);
  }
  return -minimumY;
}

function randomQuaternion() {
  const u1 = secureRandom();
  const u2 = secureRandom();
  const u3 = secureRandom();
  const root1 = Math.sqrt(1 - u1);
  const root2 = Math.sqrt(u1);
  return new CANNON.Quaternion(
    root1 * Math.sin(2 * Math.PI * u2),
    root1 * Math.cos(2 * Math.PI * u2),
    root2 * Math.sin(2 * Math.PI * u3),
    root2 * Math.cos(2 * Math.PI * u3),
  );
}

function dieMass(sides) { return 0.85 + Math.min(0.55, sides * 0.035); }
function randomSigned(minimum, maximum) { return (secureRandom() < 0.5 ? -1 : 1) * randomBetween(minimum, maximum); }
function randomBetween(minimum, maximum) { return minimum + secureRandom() * (maximum - minimum); }
function secureRandom() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 4294967296;
}
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }

export const __physicsTest = Object.freeze({
  createGeometry,
  describePolyhedron,
  createCannonShape,
  createNumberedGeometry,
  readTopFace,
});
