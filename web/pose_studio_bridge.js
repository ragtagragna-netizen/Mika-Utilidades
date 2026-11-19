// Puente entre el nodo Anima Lineart Canvas y Pose Studio 3D.
// Modelo MakeHuman CC0 con morphs, articulaciones arrastrables, varios
// personajes y captura en blanco/negro lista para el calco.

import * as THREE from "./vendor/three/three.module.js";
import { OrbitControls } from "./vendor/three/OrbitControls.js";
import {
	loadMorphPack, solveMorph, buildStaticModelData,
} from "./pose_studio/morph_runtime.mjs";
import { applyAnatomy, deformVertices, BODY_PRESETS } from "./pose_studio_anatomy.js";

const CAPTURES = new Map();
const LISTENERS = new Set();
let active = null;
let packPromise = null;
let vendoredSeen = null;

// Relleno blanco: la captura debe ser lineart puro (negro sobre blanco) para
// que el calco no arrastre una masa gris que estorbe al trazar encima.
const BODY_COLOR = 0xffffff;
const OUTLINE_COLOR = 0x111111;

// Anatomía inicial: femenina y reconocible, en lugar del valor neutro del
// morph que daba un cuerpo plano y sin pecho.
const DEFAULT_ANATOMY = {
	gender: 0, bust: 0.75, waist: 0.35, hips: 0.65, glutes: 0.6, headSize: 0.45,
};

function emit(dataUrl, nodeId) {
	for (const fn of LISTENERS) {
		try { fn(dataUrl, nodeId); } catch (e) { console.warn("Mika pose capture", e); }
	}
}

export function onPoseCapture(cb) {
	if (typeof cb !== "function") return () => {};
	LISTENERS.add(cb);
	return () => LISTENERS.delete(cb);
}

export let __lastCaptureScene = 1;
export let __sceneCount = 1;

export function setPoseStudioCapture(dataUrl, nodeId = null) {
	CAPTURES.set(nodeId == null ? "__last" : String(nodeId), dataUrl);
	__lastCaptureScene = __sceneCount;
	emit(dataUrl, nodeId);
}

export function getPoseStudioCapture(nodeId = "__last") {
	if (nodeId == null) return CAPTURES.get("__last") || null;
	return CAPTURES.get(String(nodeId)) || null;
}

// El estudio vendorizado publica sus capturas en esta global; las reenviamos
// al puente para que el botón "Enviar al calco" las consuma también.
setInterval(() => {
	if (!active) return;
	const list = window.__mikaPoseStudioCaptures;
	if (!Array.isArray(list) || !list.length) return;
	const latest = list[list.length - 1];
	if (latest && latest !== vendoredSeen) {
		vendoredSeen = latest;
		emit(latest, active?.node?.id ?? null);
	}
}, 400);

export function closePoseStudio3D() {
	if (!active) return;
	active.dispose();
	active = null;
	window.__mikaPoseStudioRefresh = null;
}

function getPack() {
	if (!packPromise) packPromise = loadMorphPack();
	return packPromise;
}

function cloneSlot(slot) {
	return JSON.parse(JSON.stringify(slot || {}));
}

function defaultSlot(anatomy, nsfw) {
	return {
		anatomy: { ...DEFAULT_ANATOMY, ...(anatomy || {}) },
		preset: null,
		pose: {},
		offset: [0, 0],
		rotationY: 0,
		nsfw: !!nsfw,
	};
}

function ensureSlots(st, count) {
	const n = Math.max(1, Math.min(4, count));
	while (st.slots.length < n) {
		st.slots.push(cloneSlot(st.slots[st.slots.length - 1] || st.slots[0]));
	}
	if (st.slots.length > n) st.slots.length = n;
	st.characters = n;
	st.selected = Math.max(0, Math.min(n - 1, st.selected || 0));
	return st.slots;
}

function stateOf(node) {
	if (!node) {
		return { version: 2, nsfw: false, characters: 1, selected: 0, slots: [defaultSlot()] };
	}
	if (!node.properties) node.properties = {};
	if (!node.properties.mikaPoseStudio3D) {
		node.properties.mikaPoseStudio3D = {
			version: 2, nsfw: false, characters: 1, selected: 0,
			slots: [defaultSlot()],
		};
	}
	const st = node.properties.mikaPoseStudio3D;
	if (st.version !== 2) {
		// v1 guardaba una anatomía global y un array de poses. Cada ranura
		// heredaba esa anatomía para que un workflow con varios personajes no
		// cambie de cuerpo al abrirse por primera vez.
		const legacy = { ...DEFAULT_ANATOMY, ...(st.anatomy || {}) };
		const nsfw = st.nsfw === true;
		const count = Math.max(1, Math.min(4, Number(st.characters) || 1));
		const poses = Array.isArray(st.poses) ? st.poses : [];
		st.slots = Array.from({ length: count }, (_, i) => {
			const slot = defaultSlot(legacy, nsfw);
			slot.pose = poses[i] ? JSON.parse(JSON.stringify(poses[i])) : {};
			if (i === 0) slot.preset = st.preset || null;
			return slot;
		});
		st.selected = 0;
		st.nsfw = nsfw;
		st.characters = count;
		st.version = 2;
	}
	if (!Array.isArray(st.slots) || !st.slots.length) st.slots = [defaultSlot()];
	for (const slot of st.slots) {
		slot.anatomy = { ...DEFAULT_ANATOMY, ...(slot.anatomy || {}) };
		slot.pose ||= {};
		if (!Array.isArray(slot.offset) || slot.offset.length !== 2) slot.offset = [0, 0];
		if (typeof slot.rotationY !== "number") slot.rotationY = 0;
	}
	st.characters = st.slots.length;
	st.selected = Math.max(0, Math.min(st.slots.length - 1, Number(st.selected) || 0));
	return st;
}

function activeSlot(st) {
	return st.slots[st.selected] || st.slots[0];
}

function morphParams(slot) {
	const anatomy = { ...(slot.anatomy || {}), nsfw: slot.nsfw === true };
	return applyAnatomy(anatomy, {
		gender: 0.5, age: 25, weight: 0.5, muscle: 0.5, height: 0.5,
		breast_size: 0.5, firmness: 0.5,
	});
}

function boundsY(vertices) {
	let minY = Infinity, maxY = -Infinity;
	for (let i = 1; i < vertices.length; i += 3) {
		if (vertices[i] < minY) minY = vertices[i];
		if (vertices[i] > maxY) maxY = vertices[i];
	}
	return { minY, maxY };
}

// Contorno por casco invertido: la malla se empuja a lo largo de sus normales
// un ancho en unidades de mundo que se recalcula según el tamaño en píxeles,
// de modo que la línea mida siempre lo mismo en pantalla (y sobreviva a una
// captura de 96 px).
function makeOutlineMesh(geometry) {
	const uniform = { value: 0.03 };
	const material = new THREE.MeshBasicMaterial({
		color: OUTLINE_COLOR, side: THREE.BackSide,
	});
	material.onBeforeCompile = (shader) => {
		shader.uniforms.mikaOutline = uniform;
		shader.vertexShader = "uniform float mikaOutline;\n" + shader.vertexShader;
		shader.vertexShader = shader.vertexShader.replace(
			"#include <begin_vertex>",
			"vec3 transformed = vec3( position ) + normal * mikaOutline;",
		);
	};
	material.customProgramCacheKey = () => "mika-outline";
	const mesh = new THREE.SkinnedMesh(geometry, material);
	mesh.userData.outlineUniform = uniform;
	return mesh;
}

// Grosor del contorno en unidades de mundo para que mida `px` píxeles.
// Debe salir de la distancia de cámara, no de la altura del modelo: con cuatro
// personajes la cámara se aleja y un cálculo basado en la altura deja la línea
// por debajo de un píxel (y el calco sale casi en blanco).
function outlineWidthFor(camera, target, viewportPx, px = 1.6) {
	const dist = Math.max(0.01, camera.position.distanceTo(target));
	const worldPerPx = 2 * dist * Math.tan((camera.fov * Math.PI) / 360) / Math.max(1, viewportPx);
	return px * worldPerPx;
}

function buildCharacter(pack, params, pose) {
	const solved = solveMorph(pack, params);
	deformVertices(solved.vertices, null, params.localDeform || {}, boundsY(solved.vertices));
	const staticData = buildStaticModelData(pack, solved.includeGenitals);

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.BufferAttribute(solved.vertices, 3));
	geometry.setAttribute("uv", new THREE.BufferAttribute(staticData.uvs, 2));
	geometry.setAttribute("skinIndex", new THREE.BufferAttribute(staticData.skinIndices, 4));
	geometry.setAttribute("skinWeight", new THREE.BufferAttribute(staticData.skinWeights, 4));
	geometry.setIndex(new THREE.BufferAttribute(staticData.indices, 1));
	geometry.computeVertexNormals();

	const height = boundsY(solved.vertices);
	const heightUnits = Math.max(0.001, height.maxY - height.minY);

	const bodyMaterial = new THREE.MeshBasicMaterial({
		color: BODY_COLOR, side: THREE.DoubleSide,
	});

	const mesh = new THREE.SkinnedMesh(geometry, bodyMaterial);
	const outline = makeOutlineMesh(geometry);

	const bones = [];
	const byName = {};
	pack.bones.forEach((b) => {
		const bone = new THREE.Bone();
		bone.name = b.name;
		bone.userData.pack = b;
		byName[b.name] = bone;
		bones.push(bone);
	});
	const roots = [];
	pack.bones.forEach((b, i) => {
		const bone = bones[i];
		const o = i * 6;
		const head = [solved.bonePositions[o], solved.bonePositions[o + 1], solved.bonePositions[o + 2]];
		const parent = b.parent ? byName[b.parent] : null;
		if (parent) {
			parent.add(bone);
			const pi = pack.bones.indexOf(parent.userData.pack);
			bone.position.set(
				head[0] - solved.bonePositions[pi * 6],
				head[1] - solved.bonePositions[pi * 6 + 1],
				head[2] - solved.bonePositions[pi * 6 + 2],
			);
		} else {
			bone.position.set(head[0], head[1], head[2]);
			roots.push(bone);
		}
	});

	const group = new THREE.Group();
	group.add(outline, mesh);
	mesh.add(...roots);

	// El bind debe ocurrir con la escena ya posicionada: si el grupo se mueve
	// después, la matriz de bind queda desfasada y la malla se deforma.
	group.updateMatrixWorld(true);
	const skeleton = new THREE.Skeleton(bones);
	mesh.bind(skeleton);
	outline.bind(skeleton);

	// Largo de brazos/piernas y tamaño de cabeza: se aplica después del bind
	// para que las posiciones de hueso estiren la malla.
	const d = params.localDeform || {};
	const limbFactor = (v) => 1 + ((v ?? 0.5) - 0.5) * 0.5;
	const stretch = (names, factor) => {
		if (Math.abs(factor - 1) < 0.001) return;
		for (const n of names) {
			const bone = byName[n];
			if (bone) bone.position.multiplyScalar(factor);
		}
	};
	stretch(["lowerarm_l", "lowerarm_r", "hand_l", "hand_r"], limbFactor(d.armLength));
	stretch(["calf_l", "calf_r", "foot_l", "foot_r", "ball_l", "ball_r"], limbFactor(d.legLength));
	const headBone = byName.head;
	const headScale = limbFactor(d.headSize);
	if (headBone && Math.abs(headScale - 1) > 0.001) {
		headBone.scale.setScalar(headScale);
	}

	const genitals = new THREE.Group();
	if (params.genitalMeshes) {
		const pelvisIdx = pack.bones.findIndex((b) => b.name === "pelvis");
		const pelvisY = pelvisIdx >= 0
			? solved.bonePositions[pelvisIdx * 6 + 1]
			: height.minY + heightUnits * 0.45;
		const pos = geometry.attributes.position.array;
		const bandY = heightUnits * 0.045;
		const bandX = heightUnits * 0.09;
		let frontZ = -Infinity;
		let backZ = Infinity;
		for (let i = 0; i < pos.length; i += 3) {
			if (Math.abs(pos[i + 1] - pelvisY) > bandY) continue;
			if (Math.abs(pos[i]) > bandX) continue;
			if (pos[i + 2] > frontZ) frontZ = pos[i + 2];
			if (pos[i + 2] < backZ) backZ = pos[i + 2];
		}
		if (!Number.isFinite(frontZ)) frontZ = heightUnits * 0.06;
		if (!Number.isFinite(backZ)) backZ = -heightUnits * 0.06;
		const unit = heightUnits * 0.012;
		const add = (name, size, y, z, sx, sy, color = OUTLINE_COLOR) => {
			if (!size) return;
			const m = new THREE.Mesh(
				new THREE.SphereGeometry(unit * (0.6 + size), 12, 10),
				new THREE.MeshBasicMaterial({ color }),
			);
			m.name = name;
			m.position.set(0, y, z);
			m.scale.set(sx, sy, 0.6);
			genitals.add(m);
			if (color !== OUTLINE_COLOR) {
				// Contorno del volumen claro, para que siga siendo lineart.
				const edge = new THREE.Mesh(
					m.geometry,
					new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide }),
				);
				edge.name = name + "_edge";
				edge.position.copy(m.position);
				edge.scale.copy(m.scale).multiplyScalar(1.09);
				genitals.add(edge);
			}
		};
		add("vagina", params.genitalMeshes.vagina, pelvisY - unit * 0.6, frontZ + unit * 0.25, 1.35, 1, BODY_COLOR);
		add("opening", params.genitalMeshes.opening, pelvisY - unit * 0.9, frontZ + unit * 0.5, 0.6, 0.5);
		add("anus", params.genitalMeshes.anus, pelvisY - unit * 2.2, backZ - unit * 0.3, 1, 1);
	}
	group.add(genitals);

	return {
		group, mesh, outline, bones, byName, skeleton, solved, genitals,
		heightUnits, outlineUniform: outline.userData.outlineUniform,
	};
}

function applyPose(character, pose) {
	if (!pose) return;
	for (const [name, q] of Object.entries(pose)) {
		const bone = character.byName[name];
		if (bone && Array.isArray(q) && q.length === 4) bone.quaternion.fromArray(q);
	}
}

function capturePose(character) {
	const out = {};
	for (const bone of character.bones) {
		const q = bone.quaternion;
		if (Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z) > 1e-4) {
			out[bone.name] = [q.x, q.y, q.z, q.w];
		}
	}
	return out;
}

const HANDLE_BONES = [
	"pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head",
	"clavicle_l", "clavicle_r", "upperarm_l", "upperarm_r",
	"lowerarm_l", "lowerarm_r", "hand_l", "hand_r",
	"thigh_l", "thigh_r", "calf_l", "calf_r", "foot_l", "foot_r",
];

function fitCamera(camera, orbit, box, margin = 1.22) {
	if (!box || box.isEmpty()) return;
	const size = box.getSize(new THREE.Vector3());
	const center = box.getCenter(new THREE.Vector3());
	const vFov = (camera.fov * Math.PI) / 180;
	const fitH = size.y / 2 / Math.tan(vFov / 2);
	const fitW = size.x / 2 / Math.tan(vFov / 2) / Math.max(0.05, camera.aspect);
	const dist = Math.max(fitH, fitW, size.z) * margin;
	orbit.target.copy(center);
	camera.position.set(center.x, center.y, center.z + dist);
	camera.near = Math.max(0.01, dist / 200);
	camera.far = dist * 20;
	camera.updateProjectionMatrix();
	orbit.update();
}

function sceneBox(scene, onlyCharacters = true) {
	const box = new THREE.Box3();
	scene.traverse((o) => {
		if (!o.isSkinnedMesh && !o.isMesh) return;
		if (onlyCharacters && !o.userData.mikaCharacter) return;
		if (!o.geometry) return;
		o.geometry.computeBoundingBox();
		const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
		box.union(b);
	});
	if (onlyCharacters) {
		// La caja de la geometría está en espacio de bind: al doblar brazos o
		// piernas la pose puede salirse de ella y quedar cortada en la captura.
		const p = new THREE.Vector3();
		scene.traverse((o) => {
			if (!o.isBone) return;
			o.getWorldPosition(p);
			box.expandByPoint(p);
		});
	}
	return box;
}

function makeWindow(node) {
	const root = document.createElement("div");
	root.dataset.mika = "pose-studio-3d-root";
	root.style.cssText =
		"position:fixed;right:16px;top:56px;width:min(560px,92vw);height:min(780px,90vh);z-index:9000;" +
		"background:#f4f4f4;color:#222;border:1px solid #888;border-radius:8px;display:flex;flex-direction:column;" +
		"box-shadow:0 8px 28px rgba(0,0,0,.35);font:12px sans-serif;overflow:hidden;";

	const bar = document.createElement("div");
	bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;background:#333;color:#eee;flex:none;";
	const title = document.createElement("span");
	title.textContent = "Pose Studio 3D — Mika";
	title.style.cssText = "font-weight:600;flex:1;";
	const close = document.createElement("button");
	close.textContent = "✕";
	close.title = "Cerrar Pose Studio 3D";
	close.style.cssText = "background:transparent;color:#eee;border:1px solid #777;border-radius:4px;cursor:pointer;";
	close.onclick = () => closePoseStudio3D();
	bar.append(title, close);

	const viewport = document.createElement("div");
	viewport.style.cssText = "position:relative;flex:1;min-height:0;background:#fff;";
	const canvas = document.createElement("canvas");
	canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;";
	viewport.appendChild(canvas);

	const panel = document.createElement("div");
	panel.style.cssText =
		"flex:none;max-height:236px;overflow:auto;padding:6px 8px;display:flex;flex-direction:column;" +
		"gap:4px;border-top:1px solid #ccc;background:#f4f4f4;color:#222;";

	root.append(bar, viewport, panel);
	document.body.appendChild(root);
	return { root, canvas, viewport, panel };
}

function sliderRow(panel, label, key, state, onInput) {
	const wrap = document.createElement("label");
	wrap.style.cssText =
		"display:flex;align-items:center;gap:6px;width:100%;font-size:11px;color:#222;line-height:16px;";
	const name = document.createElement("span");
	name.textContent = label;
	name.style.cssText =
		"width:70px;flex:none;color:#222;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
	const input = document.createElement("input");
	input.type = "range";
	const extended = key !== "gender" && key !== "posX" && key !== "posY" && key !== "rotationY";
	input.min = extended ? "-1" : "0";
	input.max = extended ? "2.5" : "1";
	input.step = "0.01";
	input.style.cssText = "flex:1;min-width:0;height:14px;";
	input.dataset.key = key;
	input.value = String(state.anatomy?.[key] ?? state[key] ?? 0.5);
	input.oninput = () => onInput(key, parseFloat(input.value));
	wrap.append(name, input);
	panel.appendChild(wrap);
	return input;
}

function captureSizeFor(node) {
	const st = node?._mikaLineart;
	return [st?.paint?.width || 1024, st?.paint?.height || 1024];
}

export async function openPoseStudio3D(node) {
	if (active) closePoseStudio3D();
	const ui = makeWindow(node);
	const renderer = new THREE.WebGLRenderer({
		canvas: ui.canvas, antialias: true, preserveDrawingBuffer: true,
	});
	renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
	renderer.setClearColor(0xffffff, 1);

	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0xffffff);
	const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 2000);
	const orbit = new OrbitControls(camera, ui.canvas);
	orbit.enableDamping = true;
	orbit.dampingFactor = 0.12;
	orbit.minDistance = 0.5;
	orbit.maxDistance = 500;

	const charactersGroup = new THREE.Group();
	const handlesGroup = new THREE.Group();
	scene.add(charactersGroup, handlesGroup);

	const raycaster = new THREE.Raycaster();
	const pointer = new THREE.Vector2();

	const state = {
		node, ui, renderer, scene, camera, orbit,
		charactersGroup, handlesGroup, characters: [], handles: [], params: null,
		drag: null, pack: null, dirty: true, anim: null,
		dispose() {
			if (state.anim) cancelAnimationFrame(state.anim);
			try { state.resizeObserver?.disconnect(); } catch (e) { /* no-op */ }
			try { orbit.dispose(); } catch (e) { /* no-op */ }
			try { renderer.dispose(); } catch (e) { /* no-op */ }
			ui.root.remove();
		},
	};
	active = state;

	let needsRender = true;
	const requestRender = () => { needsRender = true; };
	state.requestRender = requestRender;

	const applyOutlineWidth = (viewportPx, px = 1.6) => {
		const width = outlineWidthFor(camera, orbit.target, viewportPx, px);
		for (const c of state.characters) {
			if (c.outlineUniform) c.outlineUniform.value = width;
		}
	};

	const resize = () => {
		const w = Math.max(1, ui.viewport.clientWidth);
		const h = Math.max(1, ui.viewport.clientHeight);
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		applyOutlineWidth(h);
		needsRender = true;
	};
	state.resizeObserver = new ResizeObserver(resize);
	state.resizeObserver.observe(ui.viewport);
	resize();

	const refreshHandles = () => {
		for (const h of state.handles) {
			h.bone.getWorldPosition(h.mesh.position);
			h.mesh.visible = state.characters.length > 0;
		}
	};

	const render = () => {
		refreshHandles();
		renderer.render(scene, camera);
	};

	const frame = () => {
		state.anim = requestAnimationFrame(frame);
		orbit.update();
		if (needsRender) {
			needsRender = false;
			render();
		}
	};
	frame();
	orbit.addEventListener("change", requestRender);

	const rebuild = () => {
		if (!state.pack) return;
		const st0 = stateOf(node);
		state.params = morphParams(activeSlot(st0));
		while (charactersGroup.children.length) {
			const c = charactersGroup.children[0];
			charactersGroup.remove(c);
			c.traverse?.((o) => {
				if (o.geometry) o.geometry.dispose();
				if (o.material) o.material.dispose();
			});
		}
		for (const h of state.handles) handlesGroup.remove(h.mesh);
		state.handles = [];
		state.characters = [];

		const st = stateOf(node);
		const count = st.slots.length;
		__sceneCount = count;
		const poses = st.slots.map((slot) => slot.pose || {});
		const models = [];
		for (let i = 0; i < count; i++) {
			const params = i === st.selected ? state.params : morphParams(st.slots[i]);
			models.push(buildCharacter(state.pack, params, poses[i]));
		}

		// Los personajes no pueden solaparse: el espaciado sale del ancho real
		// del modelo (brazos incluidos), no de una constante inventada.
		let spacing = 10;
		if (models[0]) {
			models[0].mesh.geometry.computeBoundingBox();
			const bb = models[0].mesh.geometry.boundingBox;
			spacing = Math.max(6, bb.max.x - bb.min.x) + 1.4;
		}
		models.forEach((built, i) => {
			built.group.position.x = (i - (count - 1) / 2) * spacing;
			built.mesh.userData.mikaCharacter = true;
			built.outline.userData.mikaCharacter = true;
			charactersGroup.add(built.group);
			applyPose(built, poses[i]);
			state.characters.push(built);
		});
		charactersGroup.updateMatrixWorld(true);
		// Al cambiar el número de personajes la escena se ensancha: sin reencuadrar
		// se salen del viewport. Los cambios de anatomía no reencuadran para no
		// pisar la órbita del usuario.
		if (state.lastCount !== count) {
			state.lastCount = count;
			fitCamera(camera, orbit, sceneBox(scene));
		}

		const handleGeo = new THREE.SphereGeometry(0.16, 10, 8);
		const handleMat = new THREE.MeshBasicMaterial({
			color: 0x1e88e5, depthTest: false, depthWrite: false, transparent: true,
		});
		const handleMatActive = new THREE.MeshBasicMaterial({
			color: 0xff7043, depthTest: false, depthWrite: false, transparent: true,
		});
		for (const c of state.characters) {
			for (const name of HANDLE_BONES) {
				const bone = c.byName[name];
				if (!bone) continue;
				const mesh = new THREE.Mesh(handleGeo, handleMat);
				mesh.userData.bone = bone;
				mesh.userData.character = c;
				mesh.renderOrder = 10;
				mesh.visible = false;
				handlesGroup.add(mesh);
				state.handles.push({ bone, mesh, mat: handleMat, matActive: handleMatActive });
			}
		}
		handlesGroup.updateMatrixWorld(true);
		refreshHandles();
		applyOutlineWidth(Math.max(1, ui.viewport.clientHeight));
		state.dirty = true;
		requestRender();
	};

	// Los deslizadores pueden disparar decenas de eventos por segundo: se
	// agrupa un solo rebuild por frame para no re-mallar en cada píxel.
	let rebuildQueued = false;
	const queueRebuild = () => {
		if (rebuildQueued) return;
		rebuildQueued = true;
		requestAnimationFrame(() => {
			rebuildQueued = false;
			rebuild();
		});
	};
	state.queueRebuild = queueRebuild;

	state.rebuild = rebuild;
	state.save = () => {
		const st = stateOf(node);
		st.characters = state.characters.length || 1;
		st.slots.forEach((slot, i) => {
			const c = state.characters[i];
			if (c) slot.pose = capturePose(c);
		});
		node.properties.mikaPoseStudio3D = JSON.parse(JSON.stringify(st));
	};
	state.refresh = () => {
		const st = stateOf(node);
		const slot = activeSlot(st);
		for (const input of ui.panel.querySelectorAll("input[type=range]")) {
			const v = slot.anatomy?.[input.dataset.key] ?? slot[input.dataset.key];
			if (v !== undefined) input.value = String(v);
		}
		rebuild();
		syncButtons();
	};
	window.__mikaPoseStudioRefresh = state.refresh;

	// --- Controles de anatomía ---
	// Se agrupan en dos columnas; el panel hace scroll si no entra todo.
	const defs = [
		["gender", "Género ♀♂", "0 = femenino, 1 = masculino"],
		["height", "Altura"],
		["bust", "Pecho"],
		["firmness", "Firmeza"],
		["waist", "Cintura"],
		["hips", "Cadera"],
		["glutes", "Glúteos"],
		["armLength", "Brazos"],
		["legLength", "Piernas"],
		["headSize", "Cabeza"],
		["genitalSize", "Genitales"],
		["openingSize", "Abertura"],
		["anusSize", "Ano"],
	];
	const grid = document.createElement("div");
	grid.style.cssText =
		"display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;width:100%;";
	ui.panel.appendChild(grid);

	const sliderRows = [];
	for (const [key, label, title] of defs) {
		const input = sliderRow(grid, label, key, activeSlot(stateOf(node)), (k, v) => {
			activeSlot(stateOf(node)).anatomy[k] = v;
			state.save();
			queueRebuild();
		});
		if (title) input.title = title;
		sliderRows.push({ input, key });
	}

	// --- Presets de cuerpo ---
	const presets = document.createElement("div");
	presets.style.cssText = "display:flex;gap:6px;width:100%;margin-top:6px;flex-wrap:wrap;";
	const presetDefs = [
		["curvy_female", "Curvilínea"],
		["slim_female", "Delgada"],
		["muscular_male", "Musculoso"],
	];
	for (const [id, text] of presetDefs) {
		const b = document.createElement("button");
		b.textContent = text;
		b.title = "Aplicar preset " + text;
		b.style.cssText =
			"padding:3px 8px;border:1px solid #999;border-radius:4px;background:#fff;cursor:pointer;";
		b.onclick = () => {
			const slot = activeSlot(stateOf(node));
			slot.anatomy = { ...(slot.anatomy || {}), ...BODY_PRESETS[id] };
			slot.preset = id;
			state.save();
			for (const row of sliderRows) {
				const v = slot.anatomy[row.key];
				if (v !== undefined) row.input.value = String(v);
			}
			queueRebuild();
		};
		presets.appendChild(b);
	}
	ui.panel.appendChild(presets);

	const tools = document.createElement("div");
	tools.style.cssText = "display:flex;gap:6px;width:100%;margin-top:6px;flex-wrap:wrap;";
	const sfw = document.createElement("button");
	const count = document.createElement("button");
	const reset = document.createElement("button");
	const send = document.createElement("button");
	const btn = (b, text, title) => {
		b.textContent = text;
		b.title = title;
		b.style.cssText = "padding:4px 8px;border:1px solid #888;border-radius:4px;background:#fff;cursor:pointer;";
		return b;
	};
	btn(sfw, "SFW", "Alternar SFW / NSFW");
	btn(count, "👥 1", "Cantidad de personajes (1-4)");
	btn(reset, "Reiniciar pose", "Volver a la pose de reposo");
	btn(send, "Enviar al calco", "Enviar la escena 3D al calco del nodo lineart");
	send.style.background = "#2e7d32";
	send.style.color = "#fff";
	send.style.borderColor = "#1b5e20";

	const syncButtons = () => {
		sfw.textContent = activeSlot(stateOf(node)).nsfw ? "NSFW" : "SFW";
		count.textContent = "👥 " + (state.characters.length || 1);
	};
	sfw.onclick = () => {
		const slot = activeSlot(stateOf(node));
		slot.nsfw = !slot.nsfw;
		state.save();
		rebuild();
		syncButtons();
	};
	count.onclick = () => {
		const st = stateOf(node);
		ensureSlots(st, (st.slots.length % 4) + 1);
		rebuild();
		state.save();
		syncButtons();
	};
	reset.onclick = () => {
		for (const slot of stateOf(node).slots) slot.pose = {};
		state.save();
		rebuild();
	};
	send.onclick = () => {
		const [w, h] = captureSizeFor(node);
		setPoseStudioCapture(renderCapture(w, h), node.id);
	};
	tools.append(sfw, count, reset, send);
	ui.panel.appendChild(tools);

	// --- Articulaciones ---
	const pickHandle = (event) => {
		const rect = ui.canvas.getBoundingClientRect();
		pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(pointer, camera);
		const hits = raycaster.intersectObjects(state.handles.map((h) => h.mesh), false);
		if (!hits.length) return null;
		// Con varios personajes puede haber tiradores alineados en profundidad;
		// elegir el primero que devuelve el raycaster coge el equivocado. El
		// tirador que el usuario ve es el más cercano en pantalla.
		let best = null;
		let bestDist = Infinity;
		for (const hit of hits) {
			const p = hit.object.position.clone().project(camera);
			const d = (p.x - pointer.x) ** 2 + (p.y - pointer.y) ** 2;
			if (d < bestDist) {
				bestDist = d;
				best = state.handles.find((h) => h.mesh === hit.object);
			}
		}
		return best;
	};

	ui.canvas.addEventListener("pointerdown", (event) => {
		const hit = pickHandle(event);
		if (!hit) return;
		const bone = hit.bone;
		const parent = bone.parent;
		if (!parent || !parent.isBone) return;
		const world = new THREE.Vector3();
		bone.getWorldPosition(world);
		const normal = camera.getWorldDirection(new THREE.Vector3());
		state.drag = {
			handle: hit, bone, parent,
			plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, world),
			offset: world.clone(),
		};
		hit.mesh.material = hit.matActive;
		orbit.enabled = false;
		ui.canvas.setPointerCapture(event.pointerId);
		event.preventDefault();
	});

	ui.canvas.addEventListener("pointermove", (event) => {
		if (!state.drag) return;
		const rect = ui.canvas.getBoundingClientRect();
		pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(pointer, camera);
		const target = new THREE.Vector3();
		if (!raycaster.ray.intersectPlane(state.drag.plane, target)) return;

		const { bone, parent } = state.drag;
		const pivot = new THREE.Vector3();
		parent.getWorldPosition(pivot);
		const cur = new THREE.Vector3();
		bone.getWorldPosition(cur);
		const curDir = cur.sub(pivot);
		const desDir = target.sub(pivot);
		if (curDir.lengthSq() < 1e-8 || desDir.lengthSq() < 1e-8) return;
		const delta = new THREE.Quaternion().setFromUnitVectors(
			curDir.normalize(), desDir.normalize());

		const qp = new THREE.Quaternion();
		if (parent.parent?.isBone) parent.parent.getWorldQuaternion(qp);
		parent.quaternion.copy(
			qp.clone().invert().multiply(delta).multiply(qp).multiply(parent.quaternion));
		scene.updateMatrixWorld(true);
		requestRender();
	});

	const endDrag = () => {
		if (!state.drag) return;
		state.drag.handle.mesh.material = state.drag.handle.mat;
		state.drag = null;
		orbit.enabled = true;
		state.save();
	};
	ui.canvas.addEventListener("pointerup", endDrag);
	ui.canvas.addEventListener("pointercancel", endDrag);

	// --- Captura ---
	function renderCapture(w, h) {
		const width = Math.max(1, Math.round(w));
		const height = Math.max(1, Math.round(h));
		const off = document.createElement("canvas");
		off.width = width;
		off.height = height;
		const ctx = off.getContext("2d");
		ctx.fillStyle = "#fff";
		ctx.fillRect(0, 0, width, height);
		if (!state.characters.length) return off.toDataURL("image/png");

		const prevSize = renderer.getSize(new THREE.Vector2());
		const prevAspect = camera.aspect;
		const prevPos = camera.position.clone();
		const prevTarget = orbit.target.clone();
		const prevHandles = handlesGroup.visible;

		handlesGroup.visible = false;
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		scene.updateMatrixWorld(true);
		fitCamera(camera, orbit, sceneBox(scene), 1.12);
		// La línea mide ~2.2 px en la imagen final, aunque la cámara se haya
		// alejado para caber toda la escena.
		applyOutlineWidth(height, 2.2);
		renderer.render(scene, camera);
		try { ctx.drawImage(renderer.domElement, 0, 0, width, height); }
		catch (e) { console.warn("Mika pose capture", e); }

		renderer.setSize(prevSize.x, prevSize.y, false);
		camera.aspect = prevAspect;
		camera.position.copy(prevPos);
		orbit.target.copy(prevTarget);
		camera.updateProjectionMatrix();
		orbit.update();
		applyOutlineWidth(Math.max(1, ui.viewport.clientHeight));
		handlesGroup.visible = prevHandles;
		return off.toDataURL("image/png");
	}
	state.renderCapture = renderCapture;

	try {
		state.pack = await getPack();
		rebuild();
		syncButtons();
		const box = sceneBox(scene);
		fitCamera(camera, orbit, box);
		render();
	} catch (e) {
		console.error("Mika Pose Studio 3D:", e);
	}
	return state;
}

// --- Hooks de prueba ---
export function __setCaptureForTest(url) { setPoseStudioCapture(url); }
export function __setSceneForTest(n) { __sceneCount = n; }
export function __captureSizeForTest(node) { return captureSizeFor(node); }
export function __activeState() { return active; }
export function __stateOfForTest(node) { return stateOf(node); }
export function __activeSlotForTest(node) { return activeSlot(stateOf(node)); }
export function __ensureSlotsForTest(node, n) { return ensureSlots(stateOf(node), n); }

export async function __captureProbe(w, h) {
	const url = active?.renderCapture
		? active.renderCapture(w, h)
		: (() => {
			const c = document.createElement("canvas");
			c.width = w; c.height = h;
			const x = c.getContext("2d");
			x.fillStyle = "#fff"; x.fillRect(0, 0, w, h);
			return c.toDataURL("image/png");
		})();
	return await new Promise((res) => {
		const img = new Image();
		img.onload = () => {
			const c = document.createElement("canvas");
			c.width = w; c.height = h;
			const x = c.getContext("2d");
			x.drawImage(img, 0, 0);
			const d = x.getImageData(0, 0, w, h).data;
			let white = 0, dark = 0, grey = 0;
			for (let i = 0; i < d.length; i += 4) {
				if (d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245) white++;
				else if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60) dark++;
				else grey++;
			}
			res({ white, dark, grey });
		};
		img.src = url;
	});
}

export function __renderPoseCaptureForTest(ctx, w, h) {
	const url = active?.renderCapture ? active.renderCapture(w, h) : null;
	ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
	if (!url) return;
	const img = new Image();
	img.onload = () => ctx.drawImage(img, 0, 0, w, h);
	img.src = url;
}
