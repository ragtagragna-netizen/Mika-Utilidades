// Puente entre el nodo Anima Lineart Canvas y el estudio Pose Studio 3D.
// Expone un visor con el modelo MakeHuman CC0 y capturas en blanco/negro
// listas para entrar al calco.

import * as THREE from "./vendor/three/three.module.js";
import { OrbitControls } from "./vendor/three/OrbitControls.js";
import {
	loadMorphPack, solveMorph, buildStaticModelData, modelUsesGenitals,
} from "./pose_studio/morph_runtime.mjs";

const CAPTURES = new Map();
const LISTENERS = new Set();
let active = null;
let packPromise = null;

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

export function getPoseStudioCapture(nodeId = null) {
	return CAPTURES.get(nodeId ?? "__last") || null;
}

export function closePoseStudio3D() {
	if (!active) return;
	active.dispose();
	active = null;
}

function getPack() {
	if (!packPromise) packPromise = loadMorphPack();
	return packPromise;
}

function buildMesh(data, params) {
	const solved = solveMorph(data, params);
	const staticData = buildStaticModelData(data, solved.includeGenitals);
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.BufferAttribute(solved.vertices, 3));
	geometry.setAttribute("uv", new THREE.BufferAttribute(staticData.uvs, 2));
	geometry.setAttribute("skinIndex", new THREE.BufferAttribute(staticData.skinIndices, 2));
	geometry.setAttribute("skinWeight", new THREE.BufferAttribute(staticData.skinWeights, 4));
	geometry.setIndex(new THREE.BufferAttribute(staticData.indices, 1));
	geometry.computeVertexNormals();

	const material = new THREE.MeshBasicMaterial({
		color: 0xdedede, side: THREE.DoubleSide,
	});
	const mesh = new THREE.SkinnedMesh(geometry, material);
	const bones = [];
	const boneInverses = [];
	data.bones.forEach((bone, i) => {
		const b = new THREE.Bone();
		const o = i * 6;
		b.position.set(solved.bonePositions[o], solved.bonePositions[o + 1], solved.bonePositions[o + 2]);
		bones.push(b);
		const m = new THREE.Matrix4().makeTranslation(b.position.x, b.position.y, b.position.z);
		boneInverses.push(m.invert());
		mesh.add(b);
	});
	mesh.bind(new THREE.Skeleton(bones, boneInverses));
	return { mesh, bones, solved };
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
	controls.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;padding:6px;max-height:150px;overflow:auto;";
	const send = document.createElement("button");
	send.textContent = "Enviar al calco";
	send.title = "Enviar la pose 3D al calco del nodo lineart";
	send.onclick = () => {
		const [w, h] = captureSizeFor(node);
		const url = renderCapture(active?.data || null, w, h, active?.params || {});
		setPoseStudioCapture(url, node.id);
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

function poseParams() {
	return { gender: 0.5, age: 25, weight: 0.5, muscle: 0.5, height: 0.5,
		breast_size: 0.5, firmness: 0.5, show_genitals: false };
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
	camera.position.set(0, 7, 16);
	const orbit = new OrbitControls(camera, ui.canvas);
	orbit.target.set(0, 4, 0);
	orbit.update();
	const group = new THREE.Group();
	scene.add(group);

	const state = {
		ui, renderer, scene, camera, orbit, group,
		pack: null, data: null, params: poseParams(), bones: [], mesh: null,
		dispose() {
			try { orbit.dispose(); } catch (e) { /* no-op */ }
			try { renderer.dispose(); } catch (e) { /* no-op */ }
			ui.root.remove();
		},
	};
	active = state;

	const rebuild = () => {
		if (!state.pack) return;
		if (state.mesh) {
			group.remove(state.mesh);
			state.mesh.geometry.dispose();
			state.mesh.material.dispose();
		}
		const built = buildMesh(state.pack, state.params);
		state.mesh = built.mesh;
		state.bones = built.bones;
		state.data = built.solved;
		group.add(built.mesh);
		renderer.render(scene, camera);
	};
	state.rebuild = rebuild;

	const paramDefs = [
		["gender", "Género", 0, 1], ["height", "Altura", 0, 1],
		["weight", "Peso", 0, 1], ["muscle", "Músculo", 0, 1],
		["breast_size", "Pecho", 0, 1], ["firmness", "Firmeza", 0, 1],
		["penis_len", "Pene", 0, 1], ["penis_circ", "Grosor pene", 0, 1],
	];
	for (const [key, label, min, max] of paramDefs) {
		const wrap = document.createElement("label");
		wrap.style.cssText = "display:flex;align-items:center;gap:3px;";
		wrap.textContent = label;
		const slider = document.createElement("input");
		slider.type = "range"; slider.min = String(min); slider.max = String(max);
		slider.step = "0.01"; slider.value = String(state.params[key] ?? 0.5);
		slider.title = label;
		slider.oninput = () => {
			state.params[key] = parseFloat(slider.value);
			rebuild();
		};
		wrap.appendChild(slider);
		ui.controls.appendChild(wrap);
	}

	try {
		state.pack = await getPack();
		rebuild();
	} catch (e) {
		console.error("Mika Pose Studio 3D:", e);
	}
	return state;
}

function renderCapture(data, w, h, params) {
	const off = document.createElement("canvas");
	off.width = Math.max(1, w | 0); off.height = Math.max(1, h | 0);
	const ctx = off.getContext("2d");
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, off.width, off.height);
	if (active?.renderer && active?.scene && active?.camera) {
		active.renderer.render(active.scene, active.camera);
		try { ctx.drawImage(active.ui.canvas, 0, 0, off.width, off.height); }
		catch (e) { /* no-op */ }
	}
	return off.toDataURL("image/png");
}

// --- Hooks de prueba ---
export function __setCaptureForTest(url) { setPoseStudioCapture(url); }
export function __setSceneForTest(n) { __sceneCount = n; }
export function __captureSizeForTest(node) { return captureSizeFor(node); }
export function __renderPoseCaptureForTest(ctx, w, h) {
	ctx.save();
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, w, h);
	ctx.restore();
}
