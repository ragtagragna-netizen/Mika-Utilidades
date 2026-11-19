// Puente entre el nodo Anima Lineart Canvas y Pose Studio 3D.
// Modelo MakeHuman CC0 con morphs, articulaciones arrastrables, varios
// personajes y captura en blanco/negro lista para el calco.

import * as THREE from "./vendor/three/three.module.js";
import { OrbitControls } from "./vendor/three/OrbitControls.js";
import {
	loadMorphPack, solveMorph, buildStaticModelData,
} from "./pose_studio/morph_runtime.mjs";
import { applyAnatomy, deformVertices } from "./pose_studio_anatomy.js";

const CAPTURES = new Map();
const LISTENERS = new Set();
let active = null;
let packPromise = null;
let vendoredCursor = 0;

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
	CAPTURES.set(nodeId ?? "__last", dataUrl);
	__lastCaptureScene = __sceneCount;
	emit(dataUrl, nodeId);
}

export function getPoseStudioCapture(nodeId = "__last") {
	return CAPTURES.get(nodeId) || null;
}

// El estudio vendorizado publica sus capturas en esta global; las reenviamos
// al puente para que el botón "Enviar al calco" las consuma también.
setInterval(() => {
	const list = window.__mikaPoseStudioCaptures;
	if (!Array.isArray(list)) return;
	while (vendoredCursor < list.length) {
		const url = list[vendoredCursor++];
		if (url) emit(url, active?.node?.id ?? null);
	}
}, 400);

export function closePoseStudio3D() {
	if (!active) return;
	active.dispose();
	active = null;
}

function getPack() {
	if (!packPromise) packPromise = loadMorphPack();
	return packPromise;
}

function stateOf(node) {
	if (!node.properties) node.properties = {};
	if (!node.properties.mikaPoseStudio3D) {
		node.properties.mikaPoseStudio3D = { anatomy: {}, preset: null, characters: 1 };
	}
	return node.properties.mikaPoseStudio3D;
}

function morphParams(node) {
	const a = { ...(stateOf(node).anatomy || {}), nsfw: stateOf(node).nsfw === true };
	return applyAnatomy(a, {
		gender: 0.5, age: 25, weight: 0.5, muscle: 0.5, height: 0.5,
		breast_size: 0.5, firmness: 0.5,
	});
}

function buildMesh(pack, params) {
	const solved = solveMorph(pack, params);
	let minY = Infinity, maxY = -Infinity;
	for (let i = 1; i < solved.vertices.length; i += 3) {
		minY = Math.min(minY, solved.vertices[i]);
		maxY = Math.max(maxY, solved.vertices[i]);
	}
	deformVertices(solved.vertices, null, params.localDeform || {}, { minY, maxY });
	const staticData = buildStaticModelData(pack, solved.includeGenitals);
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.BufferAttribute(solved.vertices, 3));
	geometry.setAttribute("uv", new THREE.BufferAttribute(staticData.uvs, 2));
	geometry.setAttribute("skinIndex", new THREE.BufferAttribute(staticData.skinIndices, 2));
	geometry.setAttribute("skinWeight", new THREE.BufferAttribute(staticData.skinWeights, 4));
	geometry.setIndex(new THREE.BufferAttribute(staticData.indices, 1));
	geometry.computeVertexNormals();

	const group = new THREE.Group();
	const outline = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
		color: 0x111111, side: THREE.BackSide,
	}));
	outline.scale.setScalar(1.025);
	const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial({
		color: 0xe8e8e8, side: THREE.DoubleSide,
	}));
	const bones = [];
	const boneInverses = [];
	pack.bones.forEach((bone, i) => {
		const b = new THREE.Bone();
		const o = i * 6;
		b.position.set(solved.bonePositions[o], solved.bonePositions[o + 1], solved.bonePositions[o + 2]);
		bones.push(b);
		boneInverses.push(new THREE.Matrix4().makeTranslation(
			b.position.x, b.position.y, b.position.z).invert());
		mesh.add(b);
	});
	mesh.bind(new THREE.Skeleton(bones, boneInverses));
	group.add(outline, mesh);

	const genitals = new THREE.Group();
	if (params.genitalMeshes) {
		const pelvisY = minY + (maxY - minY) * 0.45;
		const add = (size, y, z, r) => {
			if (!size) return;
			const m = new THREE.Mesh(new THREE.SphereGeometry(r * size, 10, 8),
				new THREE.MeshBasicMaterial({ color: 0x111111 }));
			m.position.set(0, y, z);
			genitals.add(m);
		};
		add(params.genitalMeshes.vagina, pelvisY, 0.55, 0.12);
		add(params.genitalMeshes.anus, pelvisY - 0.45, -0.5, 0.09);
	}
	group.add(genitals);
	return { group, mesh, outline, bones, genitals, solved };
}

function makeWindow(node) {
	const root = document.createElement("div");
	root.dataset.mika = "pose-studio-3d-root";
	root.style.cssText =
		"position:fixed;right:18px;top:60px;width:520px;height:720px;z-index:9000;" +
		"background:#f4f4f4;border:1px solid #888;border-radius:6px;display:flex;flex-direction:column;" +
		"box-shadow:0 8px 28px rgba(0,0,0,.35);font:12px sans-serif;";
	const bar = document.createElement("div");
	bar.style.cssText = "display:flex;align-items:center;gap:6px;padding:6px;background:#333;color:#eee;";
	bar.textContent = "Pose Studio 3D — Mika";
	const close = document.createElement("button");
	close.textContent = "✕";
	close.onclick = () => closePoseStudio3D();
	bar.appendChild(close);
	const canvas = document.createElement("canvas");
	canvas.width = 512; canvas.height = 640;
	canvas.style.cssText = "flex:1;width:100%;min-height:0;background:#fff;display:block;";
	const controls = document.createElement("div");
	controls.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;padding:6px;max-height:170px;overflow:auto;";
	const send = document.createElement("button");
	send.textContent = "Enviar al calco";
	send.onclick = () => {
		const [w, h] = captureSizeFor(node);
		setPoseStudioCapture(renderCapture(w, h), node.id);
	};
	controls.appendChild(send);
	root.append(bar, canvas, controls);
	document.body.appendChild(root);
	return { root, canvas, controls, send };
}

function captureSizeFor(node) {
	const st = node?._mikaLineart;
	return [st?.paint?.width || 1024, st?.paint?.height || 1024];
}

export async function openPoseStudio3D(node) {
	if (active) closePoseStudio3D();
	const ui = makeWindow(node);
	const renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true, preserveDrawingBuffer: true });
	renderer.setPixelRatio(1);
	renderer.setSize(ui.canvas.width, ui.canvas.height, false);
	renderer.setClearColor(0xffffff, 1);
	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0xffffff);
	const camera = new THREE.PerspectiveCamera(35, ui.canvas.width / ui.canvas.height, 0.1, 500);
	camera.position.set(0, 7, 18);
	const orbit = new OrbitControls(camera, ui.canvas);
	orbit.target.set(0, 4, 0);
	orbit.update();
	const group = new THREE.Group();
	scene.add(group);

	const state = {
		node, ui, renderer, scene, camera, orbit, group,
		pack: null, characters: [], params: null, drag: null,
		dispose() {
			try { orbit.dispose(); } catch (e) { /* no-op */ }
			try { renderer.dispose(); } catch (e) { /* no-op */ }
			ui.root.remove();
		},
	};
	state.rebuild = () => {
		if (!state.pack) return;
		group.clear();
		state.characters = [];
		const n = Math.max(1, Math.min(4, Number(stateOf(node).characters) || 1));
		__sceneCount = n;
		for (let i = 0; i < n; i++) {
			const built = buildMesh(state.pack, state.params);
			built.group.position.x = (i - (n - 1) / 2) * 4.5;
			group.add(built.group);
			state.characters.push(built);
		}
		renderer.render(scene, camera);
	};
	active = state;

	const save = () => {
		const s = stateOf(node);
		s.characters = nValue();
		node.properties.mikaPoseStudio3D = JSON.parse(JSON.stringify(s));
	};
	const nValue = () => state.characters.length || 1;

	const defs = [
		["gender", "Género"], ["height", "Altura"], ["weight", "Peso"], ["muscle", "Músculo"],
		["bust", "Pecho"], ["firmness", "Firmeza"], ["waist", "Cintura"], ["hips", "Cadera"],
		["glutes", "Glúteos"], ["armLength", "Brazos"], ["legLength", "Piernas"],
		["headSize", "Cabeza"], ["genitalSize", "Genitales"], ["openingSize", "Abertura"],
		["anusSize", "Ano"],
	];
	for (const [key, label] of defs) {
		const wrap = document.createElement("label");
		wrap.style.cssText = "display:flex;align-items:center;gap:3px;";
		wrap.textContent = label;
		const s = document.createElement("input");
		s.type = "range"; s.min = "0"; s.max = "1"; s.step = "0.01";
		s.title = label + " 3D";
		s.oninput = () => {
			stateOf(node).anatomy[key] = parseFloat(s.value);
			state.params = morphParams(node);
			state.rebuild();
			save();
		};
		wrap.appendChild(s);
		ui.controls.appendChild(wrap);
		s.dataset.key = key;
	}
	const sfw = document.createElement("button");
	sfw.title = "SFW / NSFW 3D";
	const count = document.createElement("button");
	count.title = "Personajes 3D";
	const syncButtons = () => {
		sfw.textContent = stateOf(node).nsfw ? "NSFW" : "SFW";
		count.textContent = "👥 " + nValue();
	};
	sfw.onclick = () => {
		stateOf(node).nsfw = !stateOf(node).nsfw;
		state.params = morphParams(node);
		state.rebuild(); save(); syncButtons();
	};
	count.onclick = () => {
		const s = stateOf(node);
		s.characters = (Number(s.characters) || 1) % 4 + 1;
		state.rebuild(); save(); syncButtons();
	};
	ui.controls.append(sfw, count);

	// Articulaciones: arrastrar la articulación más cercana gira su hueso.
	const project = (v) => {
		const p = v.clone().project(camera);
		return [(p.x * 0.5 + 0.5) * ui.canvas.width, (-p.y * 0.5 + 0.5) * ui.canvas.height];
	};
	ui.canvas.addEventListener("pointerdown", (e) => {
		const r = ui.canvas.getBoundingClientRect();
		const px = (e.clientX - r.left) * ui.canvas.width / r.width;
		const py = (e.clientY - r.top) * ui.canvas.height / r.height;
		let best = null, dist = 18;
		for (const c of state.characters) {
			for (const b of c.bones) {
				const w = new THREE.Vector3(); b.getWorldPosition(w);
				const [x, y] = project(w);
				const d = Math.hypot(x - px, y - py);
				if (d < dist) { dist = d; best = b; }
			}
		}
		if (best) {
			state.drag = { bone: best, x: e.clientX, y: e.clientY };
			ui.canvas.setPointerCapture(e.pointerId);
		}
	});
	ui.canvas.addEventListener("pointermove", (e) => {
		if (!state.drag) return;
		const b = state.drag.bone;
		b.rotation.y += (e.clientX - state.drag.x) * 0.01;
		b.rotation.z += (e.clientY - state.drag.y) * 0.01;
		state.drag.x = e.clientX; state.drag.y = e.clientY;
		renderer.render(scene, camera);
	});
	const endDrag = () => { state.drag = null; };
	ui.canvas.addEventListener("pointerup", endDrag);
	ui.canvas.addEventListener("pointercancel", endDrag);

	try {
		state.pack = await getPack();
		state.params = morphParams(node);
		for (const [k, s] of Object.entries(ui.controls.dataset || {})) void k, s;
		for (const s of ui.controls.querySelectorAll("input[type=range]")) {
			const v = stateOf(node).anatomy[s.dataset.key];
			if (v !== undefined) s.value = String(v);
		}
		state.rebuild();
		syncButtons();
	} catch (e) {
		console.error("Mika Pose Studio 3D:", e);
	}
	return state;
}

function renderCapture(w, h) {
	const off = document.createElement("canvas");
	off.width = Math.max(1, w | 0); off.height = Math.max(1, h | 0);
	const ctx = off.getContext("2d");
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, off.width, off.height);
	if (active?.renderer && active?.scene && active?.camera) {
		const oldSize = active.renderer.getSize(new THREE.Vector2());
		active.renderer.setSize(off.width, off.height, false);
		active.camera.aspect = off.width / off.height;
		active.camera.updateProjectionMatrix();
		active.renderer.render(active.scene, active.camera);
		try { ctx.drawImage(active.ui.canvas, 0, 0, off.width, off.height); }
		catch (e) { /* no-op */ }
		active.renderer.setSize(oldSize.x, oldSize.y, false);
		active.camera.aspect = oldSize.x / oldSize.y;
		active.camera.updateProjectionMatrix();
	}
	return off.toDataURL("image/png");
}

// --- Hooks de prueba ---
export function __setCaptureForTest(url) { setPoseStudioCapture(url); }
export function __setSceneForTest(n) { __sceneCount = n; }
export function __captureSizeForTest(node) { return captureSizeFor(node); }
export function __activeState() { return active; }
export async function __captureProbe(w, h) {
	const url = renderCapture(w, h);
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
	const url = renderCapture(w, h);
	const img = new Image();
	img.src = url;
	ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
	if (img.complete) ctx.drawImage(img, 0, 0, w, h);
}
