// Puente entre el nodo Anima Lineart Canvas y Pose Studio 3D.
// Modelo MakeHuman CC0 con morphs, articulaciones arrastrables, varios
// personajes y captura en blanco/negro lista para el calco.

import * as THREE from "./vendor/three/three.module.js";
import { OrbitControls } from "./vendor/three/OrbitControls.js";
import {
	loadMorphPack, solveMorph, buildStaticModelData,
} from "./pose_studio/morph_runtime.mjs";
import { applyAnatomy, BODY_PRESETS } from "./pose_studio_anatomy.js";
import { buildCustomMorphs } from "./pose_studio_morphs.js";

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
	gender: 0, bust: 0.75, waist: 0.35, stomach: 0.5,
	hips: 0.65, glutes: 0.6, headSize: 0.45,
	handGripL: 0.5, handGripR: 0.5, handSize: 0.5, footSize: 0.5,
	handLPosX: 0, handLPosY: 0, handLPosZ: 0,
	handRPosX: 0, handRPosY: 0, handRPosZ: 0,
	handLRotX: 0, handLRotY: 0, handLRotZ: 0,
	handRRotX: 0, handRRotY: 0, handRRotZ: 0,
	footRotX: 0, footRotY: 0, footRotZ: 0,
	penisLength: 0.5, penisGirth: 0.5,
};

// Huesos que maneja la anatomía (rotación de muñecas/tobillos y cierre de
// dedos). No se guardan en `pose`: si se guardaran, el siguiente rebuild los
// aplicaría dos veces. El asset trae falanges completas, así que la mano se
// cierra articulando huesos, no curvando vértices.
const FINGERS = ["index", "middle", "ring", "pinky", "thumb"];
const PHALANGES = ["01", "02", "03"];
const PROCEDURAL_BONES = new Set([
	"hand_l", "hand_r", "foot_l", "foot_r", "penis", "penis_tip",
]);
for (const finger of FINGERS) {
	for (const ph of PHALANGES) {
		PROCEDURAL_BONES.add(`${finger}_${ph}_l`);
		PROCEDURAL_BONES.add(`${finger}_${ph}_r`);
	}
}

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
	active.saveCamera?.();
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
		offset: [0, 0, 0],
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
		const oldGrip = slot.anatomy?.handGrip;
		slot.anatomy = { ...DEFAULT_ANATOMY, ...(slot.anatomy || {}) };
		if (oldGrip !== undefined) {
			slot.anatomy.handGripL = oldGrip;
			slot.anatomy.handGripR = oldGrip;
		}
		slot.pose ||= {};
		if (!Array.isArray(slot.offset) || slot.offset.length !== 3) {
			const o = Array.isArray(slot.offset) ? slot.offset : [];
			slot.offset = [o[0] || 0, o[1] || 0, o[2] || 0];
		}
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
	const params = applyAnatomy(anatomy, {
		gender: 0.5, age: 25, weight: 0.5, muscle: 0.5, height: 0.5,
		breast_size: 0.5, firmness: 0.5,
	});
	// El solver acota el pecho a 0..1; el target extra necesita el valor real
	// del slider para poder crecer por encima del morph nativo.
	params.rawAnatomy = { ...(slot.anatomy || {}) };
	return params;
}

function boundsY(vertices) {
	let minY = Infinity, maxY = -Infinity;
	for (let i = 1; i < vertices.length; i += 3) {
		if (vertices[i] < minY) minY = vertices[i];
		if (vertices[i] > maxY) maxY = vertices[i];
	}
	return { minY, maxY };
}

// Textura de lineart para los volúmenes íntimos: sobre fondo blanco, trazos
// negros finos que repiten el lenguaje del resto del maniquí.
function makeDetailTexture(kind) {
	const canvas = document.createElement("canvas");
	canvas.width = 128;
	canvas.height = 128;
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, 128, 128);
	ctx.strokeStyle = "#111111";
	ctx.lineWidth = 1.1;
	if (kind === "anus") {
		for (let r = 12; r <= 60; r += 12) {
			ctx.beginPath();
			ctx.arc(64, 64, r, 0, Math.PI * 2);
			ctx.stroke();
		}
		for (let i = 0; i < 12; i++) {
			const a = (i * Math.PI) / 6;
			ctx.beginPath();
			ctx.moveTo(64 + Math.cos(a) * 12, 64 + Math.sin(a) * 12);
			ctx.lineTo(64 + Math.cos(a) * 58, 64 + Math.sin(a) * 58);
			ctx.stroke();
		}
	} else {
		for (let i = 0; i < 7; i++) {
			const y = 20 + i * 14;
			ctx.beginPath();
			ctx.moveTo(10, y);
			ctx.bezierCurveTo(38, y + 7, 90, y - 7, 118, y);
			ctx.stroke();
		}
	}
	const tex = new THREE.CanvasTexture(canvas);
	if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
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
	const staticData = buildStaticModelData(pack, solved.includeGenitals);
	const shape = buildCustomMorphs(pack, solved, staticData, params);

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.BufferAttribute(solved.vertices, 3));
	geometry.setAttribute("uv", new THREE.BufferAttribute(staticData.uvs, 2));
	geometry.setAttribute("skinIndex", new THREE.BufferAttribute(staticData.skinIndices, 4));
	geometry.setAttribute("skinWeight", new THREE.BufferAttribute(staticData.skinWeights, 4));
	geometry.setIndex(new THREE.BufferAttribute(staticData.indices, 1));
	geometry.computeVertexNormals();

	const height = boundsY(solved.vertices);
	const heightUnits = Math.max(0.001, height.maxY - height.minY);

	// solveMorph calcula las posiciones de huesos antes de nuestra deformación
	// de vértices: si la altura se estira fuera de 0..1 hay aplicar el mismo
	// escalado desde los pies, o los pivotes de pose quedan desalineados.
	const hd = params.localDeform?.height ?? 0.5;
	const hExtra = hd > 1 ? hd - 1 : hd < 0 ? hd : 0;
	const hStretch = 1 + hExtra * 0.22;
	if (hStretch !== 1) {
		for (let i = 0; i < solved.bonePositions.length; i += 6) {
			solved.bonePositions[i + 1] = height.minY + (solved.bonePositions[i + 1] - height.minY) * hStretch;
			solved.bonePositions[i + 4] = height.minY + (solved.bonePositions[i + 4] - height.minY) * hStretch;
		}
	}
	// La anchura global escala X de vértices y pivotes por igual, centrada en 0.
	const wStretch = 1 + ((params.localDeform?.width ?? 0.5) - 0.5) * 0.45;
	if (wStretch !== 1) {
		for (let i = 0; i < solved.bonePositions.length; i += 6) {
			solved.bonePositions[i] *= wStretch;
			solved.bonePositions[i + 3] *= wStretch;
		}
	}

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

	// El pene no tiene hueso en el pack: se crea un hueso de pivote en la
	// entrepierna (el vértice con más peso del pelvis) y un tirador hijo en la
	// punta. No deforma la malla por skin; la rotación la aplica el target
	// penisRot, y estos huesos solo marcan el ancla y el asa del tirador.
	if (solved.includeGenitals && byName.pelvis && pack.genitalIndices?.length) {
		const vpos = geometry.attributes.position.array;
		const sk = staticData.skinIndices;
		const sw = staticData.skinWeights;
		const pelvisIdx = pack.bones.findIndex((b) => b.name === "pelvis");
		const seen = new Set(pack.genitalIndices);
		let ax = 0, ay = height.minY + heightUnits * 0.53, az = 0, best = -1;
		let tx = 0, ty = ay, tz = 0, far = -1;
		for (const gi of seen) {
			const o = gi * 4;
			let wp = 0;
			for (let k = 0; k < 4; k++) {
				if (sk[o + k] === pelvisIdx) wp += sw[o + k];
			}
			if (wp > best) {
				best = wp;
				ax = vpos[gi * 3];
				ay = vpos[gi * 3 + 1];
				az = vpos[gi * 3 + 2];
			}
		}
		for (const gi of seen) {
			const dx = vpos[gi * 3] - ax;
			const dy = vpos[gi * 3 + 1] - ay;
			const dz = vpos[gi * 3 + 2] - az;
			const d2 = dx * dx + dy * dy + dz * dz;
			if (d2 > far) {
				far = d2;
				tx = vpos[gi * 3];
				ty = vpos[gi * 3 + 1];
				tz = vpos[gi * 3 + 2];
			}
		}
		const d0 = params.localDeform || {};
		const q0 = new THREE.Quaternion()
			.setFromAxisAngle(new THREE.Vector3(1, 0, 0),
				(d0.penisRotX ?? 0) * Math.PI / 180)
			.multiply(new THREE.Quaternion().setFromAxisAngle(
				new THREE.Vector3(0, 1, 0),
				(d0.penisRotY ?? 0) * Math.PI / 180))
			.multiply(new THREE.Quaternion().setFromAxisAngle(
				new THREE.Vector3(0, 0, 1),
				(d0.penisRotZ ?? 0) * Math.PI / 180));
		// El morph ya giró los vértices alrededor del ancla. Si el hueso
		// también gira, desplaza el ancla y el tirador se separa de la punta:
		// se compensa con la rotación inversa en las posiciones locales.
		const inv = q0.clone().invert();
		const pivot = new THREE.Bone();
		pivot.name = "penis";
		byName.pelvis.add(pivot);
		pivot.position.set(
			ax - solved.bonePositions[pelvisIdx * 6],
			ay - solved.bonePositions[pelvisIdx * 6 + 1],
			az - solved.bonePositions[pelvisIdx * 6 + 2],
		);
		pivot.quaternion.copy(q0);
		const tip = new THREE.Bone();
		tip.name = "penis_tip";
		pivot.add(tip);
		// tx/ty/tz vienen de la malla ya deformada: con la compensación
		// anterior el tirador cae justo en la punta real.
		tip.position.set(tx - ax, ty - ay, tz - az).applyQuaternion(inv);
		byName.penis = pivot;
		byName.penis_tip = tip;
		bones.push(pivot, tip);
	}

	// El largo de brazos y piernas ya lo hace un target de estiramiento en
	// buildCustomMorphs: escalar posiciones de huesos después del bind no era
	// visible y rompía los pivotes al doblar las articulaciones.
	const d = params.localDeform || {};
	const headBone = byName.head;
	const headScale = 1 + ((d.headSize ?? 0.5) - 0.5) * 0.25;
	if (headBone && Math.abs(headScale - 1) > 0.001) {
		headBone.scale.setScalar(headScale);
	}

	// El grosor ya viene de los targets por región (buildCustomMorphs), que
	// desplazan los vértices en torno al eje real de cada hueso sin escalar la
	// jerarquía ni recortar el miembro.

	const genitals = new THREE.Group();
	if (params.genitalMeshes) {
		const pelvisIdx = pack.bones.findIndex((b) => b.name === "pelvis");
		const pelvisY = pelvisIdx >= 0
			? solved.bonePositions[pelvisIdx * 6 + 1]
			: height.minY + heightUnits * 0.45;
		const pos = geometry.attributes.position.array;
		// Buscar la superficie a la altura real del perineo, no a la del hueso
		// pelvis (que está encima y hacía que el volumen pareciera en el abdomen).
		const crotchY = pelvisY - heightUnits * 0.035;
		const bandY = heightUnits * 0.02;
		const bandX = heightUnits * 0.06;
		let frontZ = -Infinity;
		let backZ = Infinity;
		for (let i = 0; i < pos.length; i += 3) {
			if (Math.abs(pos[i + 1] - crotchY) > bandY) continue;
			if (Math.abs(pos[i]) > bandX) continue;
			if (pos[i + 2] > frontZ) frontZ = pos[i + 2];
			if (pos[i + 2] < backZ) backZ = pos[i + 2];
		}
		if (!Number.isFinite(frontZ)) frontZ = heightUnits * 0.06;
		if (!Number.isFinite(backZ)) backZ = -heightUnits * 0.06;
		const unit = heightUnits * 0.012;
		const details = {
			vagina: makeDetailTexture("vagina"),
			opening: makeDetailTexture("opening"),
			anus: makeDetailTexture("anus"),
		};
		const add = (name, size, y, z, sx, sy, color = OUTLINE_COLOR) => {
			// Un slider en -1 deja un tamaño negativo: sin esto se crea una
			// esfera de radio negativo (malla degenerada).
			if (!(size > 0)) return;
			const m = new THREE.Mesh(
				new THREE.SphereGeometry(unit * (0.35 + size * 0.4), 12, 10),
				new THREE.MeshBasicMaterial({ color, map: details[name] || null }),
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
		// Todos con relleno blanco y contorno negro: antes opening y ano eran
		// esferas negras y el ano parecía un punto flotante.
		add("vagina", params.genitalMeshes.vagina,
			crotchY - unit * 0.2, frontZ + unit * 0.05, 1.1, 0.8, BODY_COLOR);
		add("opening", params.genitalMeshes.opening,
			crotchY - unit * 0.5, frontZ + unit * 0.08, 0.55, 0.45, BODY_COLOR);
		add("anus", params.genitalMeshes.anus,
			crotchY - unit * 0.6, backZ - unit * 0.05, 0.8, 0.8, BODY_COLOR);
	}
	// El morph de pene termina en 1; el excedente del slider se aplica aquí.
	const maleSurplus = params.localDeform?.genitalSize > 1
		? 1 + (params.localDeform.genitalSize - 1) * 0.6
		: 1;
	if (maleSurplus !== 1) genitals.scale.setScalar(maleSurplus);
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
		if (PROCEDURAL_BONES.has(bone.name)) continue;
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
	"penis_tip",
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

const STUDIO_GEOM_KEY = "mikaPoseStudio3D.window";
// La cámara se recuerda por nodo: al volver a abrir el mismo maniquí se ve
// exactamente el mismo ángulo y zoom que se dejó.
const CAMERA_KEY_PREFIX = "mikaPoseStudio3D.camera.";

function defaultStudioGeom() {
	return {
		x: Math.max(8, window.innerWidth - 796),
		y: 56,
		w: Math.min(780, window.innerWidth - 32),
		h: Math.min(780, window.innerHeight - 72),
	};
}

function clampStudioGeom(g) {
	const w = Math.min(Math.max(560, Number(g?.w) || 780), window.innerWidth - 16);
	const h = Math.min(Math.max(520, Number(g?.h) || 700), window.innerHeight - 60);
	return {
		x: Math.min(Math.max(8, Number(g?.x) || 0), Math.max(8, window.innerWidth - w - 8)),
		y: Math.min(Math.max(0, Number(g?.y) || 0), window.innerHeight - 40),
		w, h,
	};
}

function readStudioGeom() {
	try {
		return clampStudioGeom(JSON.parse(localStorage.getItem(STUDIO_GEOM_KEY)) || defaultStudioGeom());
	} catch (e) {
		return defaultStudioGeom();
	}
}

function writeStudioGeom(root) {
	const r = root.getBoundingClientRect();
	localStorage.setItem(STUDIO_GEOM_KEY, JSON.stringify(clampStudioGeom({
		x: r.left, y: r.top, w: r.width, h: r.height,
	})));
}

function readCamera(node) {
	try {
		const raw = JSON.parse(localStorage.getItem(
			CAMERA_KEY_PREFIX + String(node?.id ?? "")));
		if (!raw) return null;
		const ok = (a) => Array.isArray(a) && a.length === 3
			&& a.every((v) => Number.isFinite(Number(v)));
		if (!ok(raw.position) || !ok(raw.target)) return null;
		return { position: raw.position, target: raw.target };
	} catch (e) {
		return null;
	}
}

function writeCamera(node, camera, orbit) {
	try {
		localStorage.setItem(CAMERA_KEY_PREFIX + String(node?.id ?? ""), JSON.stringify({
			position: camera.position.toArray(),
			target: orbit.target.toArray(),
		}));
	} catch (e) { /* almacenamiento no disponible */ }
}

function applyStudioGeom(root, g) {
	const q = clampStudioGeom(g);
	root.style.left = `${q.x}px`;
	root.style.top = `${q.y}px`;
	root.style.width = `${q.w}px`;
	root.style.height = `${q.h}px`;
	root.style.right = "auto";
}

function makeWindow(node) {
	const root = document.createElement("div");
	root.dataset.mika = "pose-studio-3d-root";
	root.style.cssText =
		"position:fixed;z-index:9000;box-sizing:border-box;resize:both;min-width:560px;min-height:520px;" +
		"background:#f4f4f4;color:#222;border:1px solid #888;border-radius:8px;display:flex;flex-direction:column;" +
		"box-shadow:0 8px 28px rgba(0,0,0,.35);font:12px sans-serif;overflow:hidden;";

	const bar = document.createElement("div");
	bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;background:#333;color:#eee;flex:none;cursor:move;user-select:none;";
	const title = document.createElement("span");
	title.textContent = "Pose Studio 3D — Mika";
	title.style.cssText = "font-weight:600;flex:1;";
	const close = document.createElement("button");
	close.textContent = "✕";
	close.title = "Cerrar Pose Studio 3D";
	close.style.cssText = "background:transparent;color:#eee;border:1px solid #777;border-radius:4px;cursor:pointer;";
	close.onclick = () => closePoseStudio3D();
	bar.append(title, close);

	// Fila inferior: vista 3D a la izquierda y panel de controles a la derecha.
	const body = document.createElement("div");
	body.style.cssText = "display:flex;flex:1;min-height:0;";

	const viewport = document.createElement("div");
	viewport.style.cssText = "position:relative;flex:1;min-width:0;min-height:0;background:#fff;";
	const canvas = document.createElement("canvas");
	canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;display:block;touch-action:none;background:#fff;" +
		"outline:2px solid #000;outline-offset:-2px;";
	viewport.appendChild(canvas);
	// La vista ya tiene el aspecto de la salida: este marco negro delimita
	// exactamente lo que se mandará al calco.
	const frameLabel = document.createElement("div");
	frameLabel.style.cssText =
		"position:absolute;left:6px;top:6px;z-index:2;font:11px monospace;color:#111;" +
		"background:rgba(255,255,255,.8);padding:2px 5px;pointer-events:none;";
	viewport.appendChild(frameLabel);

	const panel = document.createElement("div");
	panel.style.cssText =
		"flex:none;width:252px;overflow-y:auto;overflow-x:hidden;padding:8px;display:flex;flex-direction:column;" +
		"gap:6px;border-left:1px solid #ccc;background:#f4f4f4;color:#222;box-sizing:border-box;";

	body.append(viewport, panel);
	root.append(bar, body);
	document.body.appendChild(root);
	applyStudioGeom(root, readStudioGeom());

	// Arrastre desde la cabecera, con el mismo contrato que la ventana del editor.
	let drag = null;
	bar.addEventListener("pointerdown", (e) => {
		if (e.target.closest?.("button") || e.button !== 0) return;
		const r = root.getBoundingClientRect();
		drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
		root.style.left = `${r.left}px`;
		root.style.top = `${r.top}px`;
		root.style.right = "auto";
		bar.setPointerCapture(e.pointerId);
		e.preventDefault();
	});
	bar.addEventListener("pointermove", (e) => {
		if (!drag) return;
		const x = Math.min(Math.max(e.clientX - drag.dx, 80 - drag.w), window.innerWidth - 80);
		const y = Math.min(Math.max(e.clientY - drag.dy, 0), window.innerHeight - 40);
		root.style.left = `${x}px`;
		root.style.top = `${y}px`;
	});
	const endDrag = () => {
		if (!drag) return;
		drag = null;
		writeStudioGeom(root);
	};
	bar.addEventListener("pointerup", endDrag);
	bar.addEventListener("pointercancel", endDrag);
	bar.addEventListener("dblclick", (e) => {
		if (e.target.closest?.("button")) return;
		applyStudioGeom(root, defaultStudioGeom());
		writeStudioGeom(root);
	});

	return { root, canvas, viewport, panel, frameLabel };
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
	const RANGES = {
		gender: [0, 1], posX: [-8, 8], posY: [-3, 3], posZ: [-8, 8],
		rotationY: [-180, 180],
		handLPosX: [-4, 4], handLPosY: [-4, 4], handLPosZ: [-4, 4],
		handRPosX: [-4, 4], handRPosY: [-4, 4], handRPosZ: [-4, 4],
		handLRotX: [-180, 180], handLRotY: [-180, 180], handLRotZ: [-180, 180],
		handRRotX: [-180, 180], handRRotY: [-180, 180], handRRotZ: [-180, 180],
		footRotX: [-180, 180], footRotY: [-180, 180], footRotZ: [-180, 180],
	};
	const [mn, mx] = RANGES[key] || [-1, 2.5];
	input.min = String(mn);
	input.max = String(mx);
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

	// Se crean una vez por estudio: rebuild() corre en cada frame mientras se
	// arrastra un slider, y crear geometría/materiales allí fugaba recursos.
	const handleGeo = new THREE.SphereGeometry(0.16, 10, 8);
	const handleMat = new THREE.MeshBasicMaterial({
		color: 0x1e88e5, depthTest: false, depthWrite: false, transparent: true,
	});
	const handleMatActive = new THREE.MeshBasicMaterial({
		color: 0xff7043, depthTest: false, depthWrite: false, transparent: true,
	});

	const state = {
		node, ui, renderer, scene, camera, orbit,
		charactersGroup, handlesGroup, characters: [], handles: [], params: null,
		selected: stateOf(node).selected, moveMode: false, selectionVolume: null,
		drag: null, pack: null, dirty: true, anim: null,
		dispose() {
			if (state.anim) cancelAnimationFrame(state.anim);
			try { state.resizeObserver?.disconnect(); } catch (e) { /* no-op */ }
			try { state.geoObserver?.disconnect(); } catch (e) { /* no-op */ }
			// El último resize puede estar dentro del debounce: se vuelca al
			// cerrar, o el tamaño nuevo se pierde al reabrir.
			try { writeStudioGeom(ui.root); } catch (e) { /* no-op */ }
			if (state.geoSaveTimer) clearTimeout(state.geoSaveTimer);
			try {
				if (state.selectionVolume) {
					scene.remove(state.selectionVolume);
					state.selectionVolume.geometry.dispose();
					state.selectionVolume.material.dispose();
				}
			} catch (e) { /* no-op */ }
			try { handleGeo.dispose(); handleMat.dispose(); handleMatActive.dispose(); } catch (e) { /* no-op */ }
			try { state.gizmoResources?.forEach((r) => r.dispose()); } catch (e) { /* no-op */ }
			try { orbit.dispose(); } catch (e) { /* no-op */ }
			try { renderer.dispose(); } catch (e) { /* no-op */ }
			ui.root.remove();
		},
	};
	active = state;

	// Tres flechas en la esquina de la base azul para mover el personaje.
	// Viven en handlesGroup, así que la captura las oculta igual que los puntos.
	const moveGizmo = new THREE.Group();
	handlesGroup.add(moveGizmo);
	state.moveGizmo = moveGizmo;
	state.gizmoArrows = [];
	const gizmoResources = [];
	for (const def of [
		{ axis: "x", color: 0xe53935, dir: [1, 0, 0] },
		{ axis: "y", color: 0x43a047, dir: [0, 1, 0] },
		{ axis: "z", color: 0x1e88e5, dir: [0, 0, 1] },
	]) {
		const mat = new THREE.MeshBasicMaterial({
			color: def.color, depthTest: false, depthWrite: false,
		});
		const shaftGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.7, 8);
		const headGeo = new THREE.ConeGeometry(0.12, 0.3, 10);
		gizmoResources.push(mat, shaftGeo, headGeo);
		const arm = new THREE.Group();
		arm.quaternion.setFromUnitVectors(
			new THREE.Vector3(0, 1, 0),
			new THREE.Vector3(...def.dir));
		for (const [geo, y] of [[shaftGeo, 0.35], [headGeo, 0.85]]) {
			const m = new THREE.Mesh(geo, mat);
			m.position.y = y;
			m.userData.moveAxis = def.axis;
			m.renderOrder = 11;
			arm.add(m);
			state.gizmoArrows.push(m);
		}
		moveGizmo.add(arm);
	}
	state.gizmoResources = gizmoResources;

	let needsRender = true;
	const requestRender = () => { needsRender = true; };
	state.requestRender = requestRender;

	const applyOutlineWidth = (viewportPx, px = 1.6) => {
		const width = outlineWidthFor(camera, orbit.target, viewportPx, px);
		for (const c of state.characters) {
			if (c.outlineUniform) c.outlineUniform.value = width;
		}
	};

	// La vista se encaja al mismo aspecto que se va a enviar al calco: lo que
	// se ve en el visor es exactamente lo que llega, sin recortes sorpresa.
	const resize = () => {
		const w = Math.max(1, ui.viewport.clientWidth);
		const h = Math.max(1, ui.viewport.clientHeight);
		const [cw, ch] = captureSizeFor(node);
		if (ui.frameLabel) ui.frameLabel.textContent = `${cw}×${ch}`;
		const aspect = cw / ch;
		let rw = w, rh = h;
		if (w / h > aspect) rw = Math.max(1, Math.round(h * aspect));
		else rh = Math.max(1, Math.round(w / aspect));
		renderer.setSize(rw, rh, false);
		ui.canvas.style.width = rw + "px";
		ui.canvas.style.height = rh + "px";
		ui.canvas.style.left = Math.round((w - rw) / 2) + "px";
		ui.canvas.style.top = Math.round((h - rh) / 2) + "px";
		camera.aspect = aspect;
		camera.updateProjectionMatrix();
		applyOutlineWidth(rh);
		needsRender = true;
	};
	state.setCaptureAspect = resize;
	state.resizeObserver = new ResizeObserver(resize);
	state.resizeObserver.observe(ui.viewport);
	state.geoObserver = new ResizeObserver(() => {
		if (state.geoSaveTimer) clearTimeout(state.geoSaveTimer);
		state.geoSaveTimer = setTimeout(() => {
			writeStudioGeom(ui.root);
			requestRender();
		}, 250);
	});
	state.geoObserver.observe(ui.root);
	resize();

	const refreshHandles = () => {
		for (const h of state.handles) {
			h.bone.getWorldPosition(h.mesh.position);
			h.mesh.visible = state.characters.length > 0;
		}
		const model = state.characters[state.selected] || state.characters[0];
		const box = state.selectionVolume?.geometry;
		if (model && box) {
			if (!box.boundingBox) box.computeBoundingBox();
			const b = box.boundingBox;
			moveGizmo.position.set(b.max.x, b.min.y, b.max.z);
			moveGizmo.scale.setScalar(Math.max(0.6, model.heightUnits * 0.09));
			moveGizmo.visible = true;
		} else {
			moveGizmo.visible = false;
		}
	};

	const render = () => {
		refreshHandles();
		if (state.selectionVolume?.visible) state.selectionVolume.update();
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
	let camSaveTimer = null;
	state.saveCamera = () => writeCamera(node, camera, orbit);
	orbit.addEventListener("change", () => {
		requestRender();
		if (camSaveTimer) clearTimeout(camSaveTimer);
		camSaveTimer = setTimeout(() => state.saveCamera?.(), 250);
	});

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
			const slot = st.slots[i];
			built.group.position.x = (i - (count - 1) / 2) * spacing + (slot.offset?.[0] || 0);
			built.group.position.y = slot.offset?.[1] || 0;
			built.group.position.z = slot.offset?.[2] || 0;
			built.group.rotation.y = slot.rotationY || 0;
			built.mesh.userData.mikaCharacter = true;
			built.outline.userData.mikaCharacter = true;
			built.mesh.userData.slot = i;
			charactersGroup.add(built.group);
			applyPose(built, poses[i]);
			const anatomy = st.slots[i]?.anatomy || {};
			// Rotación en los tres ejes de manos y pies. Se compone sobre la
			// pose guardada (no la sobrescribe) en el marco local del hueso.
			const rotatePair = (prefix, x, y, z) => {
				if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 0.01) return;
				const q = new THREE.Quaternion().setFromEuler(
					new THREE.Euler(x * Math.PI / 180, y * Math.PI / 180,
						z * Math.PI / 180, "XYZ"));
				for (const side of ["l", "r"]) {
					const bone = built.byName[prefix + "_" + side];
					if (bone) bone.quaternion.multiply(q);
				}
			};
			const rotateBone = (name, x, y, z) => {
				const bone = built.byName[name];
				if (!bone || Math.abs(x) + Math.abs(y) + Math.abs(z) < 0.01) return;
				bone.quaternion.multiply(new THREE.Quaternion().setFromEuler(
					new THREE.Euler(x * Math.PI / 180, y * Math.PI / 180,
						z * Math.PI / 180, "XYZ")));
			};
			const oldHand = anatomy.handRotation ?? anatomy.handRotY ?? 0;
			const oldFoot = anatomy.footRotation ?? 0;
			// Cada mano tiene su propia posición y rotación en tres ejes.
			for (const [side, p] of [["l", "handL"], ["r", "handR"]]) {
				const name = "hand_" + side;
				rotateBone(name,
					anatomy[p + "RotX"] ?? anatomy.handRotX ?? 0,
					anatomy[p + "RotY"] ?? oldHand,
					anatomy[p + "RotZ"] ?? anatomy.handRotZ ?? 0);
				const bone = built.byName[name];
				if (!bone) continue;
				const dx = anatomy[p + "PosX"] ?? 0;
				const dy = anatomy[p + "PosY"] ?? 0;
				const dz = anatomy[p + "PosZ"] ?? 0;
				if (dx || dy || dz) bone.position.add(new THREE.Vector3(dx, dy, dz));
			}
			rotatePair("foot", anatomy.footRotX ?? 0,
				anatomy.footRotY ?? oldFoot, anatomy.footRotZ ?? 0);

			// Cerrar/abrir cada mano por separado. Curvaturas suaves: con 105°
			// acumuladas las falanges se clavaban en la palma y desde ciertos
			// ángulos parecía una deformación, no un puño.
			const xAxis = new THREE.Vector3(1, 0, 0);
			const yAxis = new THREE.Vector3(0, 1, 0);
			const q = new THREE.Quaternion();
			const phFactor = { "01": 1, "02": 0.8, "03": 0.55 };
			const fingerFactor = {
				index: 0.92, middle: 1, ring: 0.94, pinky: 0.86, thumb: 0.45,
			};
			for (const [side, key] of [["l", "handGripL"], ["r", "handGripR"]]) {
				const grip = anatomy[key] ?? anatomy.handGrip ?? 0.5;
				const curl = Math.max(-10, Math.min(78, (grip - 0.5) * 42));
				if (Math.abs(curl) < 0.1) continue;
				for (const finger of FINGERS) {
					for (const ph of PHALANGES) {
						const bone = built.byName[`${finger}_${ph}_${side}`];
						if (!bone) continue;
						const deg = curl * fingerFactor[finger] * phFactor[ph];
						q.setFromAxisAngle(
							finger === "thumb" ? yAxis : xAxis,
							deg * Math.PI / 180);
						bone.quaternion.multiply(q);
					}
				}
			}
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

		// Solo el personaje seleccionado expone tiradores: con 4 personajes
		// serían 80 esferas solapadas y seleccionar se volvería imposible.
		const activeModel = state.characters[st.selected] || state.characters[0];
		if (activeModel) {
			for (const name of HANDLE_BONES) {
				const bone = activeModel.byName[name];
				if (!bone) continue;
				const mesh = new THREE.Mesh(handleGeo, handleMat);
				mesh.userData.bone = bone;
				mesh.userData.character = activeModel;
				mesh.renderOrder = 10;
				mesh.visible = false;
				handlesGroup.add(mesh);
				state.handles.push({ bone, mesh, mat: handleMat, matActive: handleMatActive });
			}
		}
		handlesGroup.updateMatrixWorld(true);
		if (state.selectionVolume) {
			scene.remove(state.selectionVolume);
			state.selectionVolume.geometry.dispose();
			state.selectionVolume.material.dispose();
			state.selectionVolume = null;
		}
		if (activeModel) {
			const box = new THREE.BoxHelper(activeModel.mesh, 0x1e88e5);
			box.material.depthTest = false;
			box.renderOrder = 9;
			scene.add(box);
			state.selectionVolume = box;
		}
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
		for (const input of ui.panel.querySelectorAll("input[type=range]")) {
			const v = sliderState().anatomy[input.dataset.key];
			if (v !== undefined) input.value = String(v);
		}
		rebuild();
		syncButtons();
		state.refreshOutput?.();
	};
	window.__mikaPoseStudioRefresh = state.refresh;

	// --- Selector de personaje ---
	const selector = document.createElement("div");
	selector.style.cssText = "display:flex;gap:4px;width:100%;flex-wrap:wrap;align-items:center;";
	const selectorLabel = document.createElement("span");
	selectorLabel.textContent = "Personaje:";
	selectorLabel.style.cssText = "color:#222;font-size:11px;";
	selector.appendChild(selectorLabel);
	const selectorButtons = [];
	for (let i = 0; i < 4; i++) {
		const b = document.createElement("button");
		b.textContent = String(i + 1);
		b.title = "Seleccionar personaje " + (i + 1);
		b.style.cssText =
			"padding:2px 9px;border:1px solid #888;border-radius:4px;background:#fff;cursor:pointer;";
		b.onclick = () => selectSlot(i);
		selectorButtons.push(b);
		selector.appendChild(b);
	}
	ui.panel.appendChild(selector);

	// --- Controles de anatomía ---
	// Se agrupan en dos columnas; el panel hace scroll si no entra todo.
	const defs = [
		["gender", "Género ♀♂", "0 = femenino, 1 = masculino"],
		["height", "Altura"],
		["width", "Anchura", "Escala global en X, como Altura pero de lado a lado"],
		["bust", "Pecho"],
		["firmness", "Firmeza"],
		["waist", "Cintura"],
		["stomach", "Estómago", "Abdomen alto, crece hacia delante y en anchura"],
		["hips", "Cadera"],
		["glutes", "Glúteos"],
		["armLength", "Largo brazos"],
		["legLength", "Largo piernas"],
		["armThickness", "Grosor brazos"],
		["thighThickness", "Grosor muslos"],
		["calfThickness", "Grosor pantorrillas"],
		["handSize", "Tamaño manos", "Escala de ambas manos y dedos"],
		["footSize", "Tamaño pies", "Escala de ambos pies"],
		["handGripL", "Abrir mano izq.", "Mano izquierda: -1 abierta, 0.5 reposo, 2.5 puño"],
		["handGripR", "Abrir mano der.", "Mano derecha: -1 abierta, 0.5 reposo, 2.5 puño"],
		["handLPosX", "Izq pos X", "Mover mano izquierda en X"],
		["handLPosY", "Izq pos Y", "Mover mano izquierda en Y"],
		["handLPosZ", "Izq pos Z", "Mover mano izquierda en Z"],
		["handRPosX", "Der pos X", "Mover mano derecha en X"],
		["handRPosY", "Der pos Y", "Mover mano derecha en Y"],
		["handRPosZ", "Der pos Z", "Mover mano derecha en Z"],
		["handLRotX", "Izq rot X", "Rotar mano izquierda, -180°…180°"],
		["handLRotY", "Izq rot Y", "Rotar mano izquierda, -180°…180°"],
		["handLRotZ", "Izq rot Z", "Rotar mano izquierda, -180°…180°"],
		["handRRotX", "Der rot X", "Rotar mano derecha, -180°…180°"],
		["handRRotY", "Der rot Y", "Rotar mano derecha, -180°…180°"],
		["handRRotZ", "Der rot Z", "Rotar mano derecha, -180°…180°"],
		["footRotX", "Rotar pie X", "Dorsiflexión / flexión plantar, -180°…180°"],
		["footRotY", "Rotar pie Y", "Giro del pie, -180°…180°"],
		["footRotZ", "Rotar pie Z", "Inversión / eversión, -180°…180°"],
		["headSize", "Cabeza"],
		["genitalSize", "Genitales"],
		["penisLength", "Largo pene", "Longitud: ×1.5 al máximo (2.5), activo en NSFW masculino"],
		["penisGirth", "Grosor pene", "Circunferencia: ×3 al máximo (2.5), activo en NSFW masculino"],
		["openingSize", "Abertura"],
		["anusSize", "Ano"],
		// El desplazamiento se hace con las tres flechas de la base azul.
		["rotationY", "Giro", "Rotación en grados"],
	];
	const grid = document.createElement("div");
	grid.style.cssText =
		"display:grid;grid-template-columns:1fr;gap:3px;width:100%;";
	ui.panel.appendChild(grid);

	const sliderState = () => {
		const slot = activeSlot(stateOf(node));
		return {
			anatomy: {
				...slot.anatomy,
				posX: slot.offset?.[0] ?? 0,
				posY: slot.offset?.[1] ?? 0,
				posZ: slot.offset?.[2] ?? 0,
				rotationY: Math.round((slot.rotationY || 0) * 180 / Math.PI),
				handGripL: slot.anatomy?.handGripL ?? slot.anatomy?.handGrip ?? 0.5,
				handGripR: slot.anatomy?.handGripR ?? slot.anatomy?.handGrip ?? 0.5,
				stomach: slot.anatomy?.stomach ?? 0.5,
				handSize: slot.anatomy?.handSize ?? 0.5,
				footSize: slot.anatomy?.footSize ?? 0.5,
				handLPosX: slot.anatomy?.handLPosX ?? 0,
				handLPosY: slot.anatomy?.handLPosY ?? 0,
				handLPosZ: slot.anatomy?.handLPosZ ?? 0,
				handRPosX: slot.anatomy?.handRPosX ?? 0,
				handRPosY: slot.anatomy?.handRPosY ?? 0,
				handRPosZ: slot.anatomy?.handRPosZ ?? 0,
				handLRotX: slot.anatomy?.handLRotX ?? 0,
				handLRotY: slot.anatomy?.handLRotY ?? 0,
				handLRotZ: slot.anatomy?.handLRotZ ?? 0,
				handRRotX: slot.anatomy?.handRRotX ?? 0,
				handRRotY: slot.anatomy?.handRRotY ?? 0,
				handRRotZ: slot.anatomy?.handRRotZ ?? 0,
				footRotX: slot.anatomy?.footRotX ?? 0,
				footRotY: slot.anatomy?.footRotY ?? 0,
				footRotZ: slot.anatomy?.footRotZ ?? 0,
			},
		};
	};

	const sliderRows = [];
	for (const [key, label, title] of defs) {
		const input = sliderRow(grid, label, key, sliderState(), (k, v) => {
			const slot = activeSlot(stateOf(node));
			if (k === "posX") slot.offset[0] = v;
			else if (k === "posY") slot.offset[1] = v;
			else if (k === "posZ") slot.offset[2] = v;
			else if (k === "rotationY") slot.rotationY = (v * Math.PI) / 180;
			else slot.anatomy[k] = v;
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

	// --- Tamaño de salida ---
	// Elige el lienzo desde la propia ventana: la vista se reencuadra a ese
	// aspecto y "Enviar al calco" manda exactamente lo que se está viendo.
	const resWidget = node.widgets?.find((w) => w.name === "resolucion");
	const outRow = document.createElement("label");
	outRow.style.cssText =
		"display:flex;align-items:center;gap:6px;width:100%;font-size:11px;color:#222;";
	const outName = document.createElement("span");
	outName.textContent = "Salida";
	outName.style.cssText = "width:70px;flex:none;";
	const outSel = document.createElement("select");
	outSel.title = "Tamaño del lienzo y de la vista 3D";
	outSel.style.cssText = "flex:1;min-width:0;font:11px sans-serif;";
	const refreshOut = () => {
		const values = (resWidget?.options?.values || []).slice();
		const cur = String(resWidget?.value || "");
		if (cur && !values.includes(cur)) values.push(cur);
		const key = values.join("\u0000");
		if (outSel.dataset.options !== key) {
			outSel.dataset.options = key;
			outSel.innerHTML = "";
			for (const v of values) {
				const o = document.createElement("option");
				o.value = v;
				o.textContent = v;
				outSel.appendChild(o);
			}
		}
		if (cur) outSel.value = cur;
	};
	outSel.onchange = () => {
		if (!resWidget) return;
		resWidget.value = outSel.value;
		resWidget.callback?.(outSel.value);
		state.setCaptureAspect?.();
		// Mantener el ángulo pero alejar/acercar para que el modelo siga
		// cabiendo en el nuevo aspecto.
		const box = sceneBox(scene);
		if (!box.isEmpty()) {
			const size = box.getSize(new THREE.Vector3());
			const vFov = camera.fov * Math.PI / 180;
			const dist = Math.max(
				size.y / 2 / Math.tan(vFov / 2),
				size.x / 2 / Math.tan(vFov / 2) / camera.aspect,
				size.z) * 1.22;
			const dir = camera.position.clone().sub(orbit.target).normalize();
			camera.position.copy(orbit.target).addScaledVector(dir, dist);
			orbit.update();
		}
	};
	refreshOut();
	outRow.append(outName, outSel);
	ui.panel.appendChild(outRow);
	state.refreshOutput = refreshOut;

	const tools = document.createElement("div");
	tools.style.cssText = "display:flex;gap:6px;width:100%;margin-top:6px;flex-wrap:wrap;";
	const sfw = document.createElement("button");
	const count = document.createElement("button");
	const reset = document.createElement("button");
	const posReset = document.createElement("button");
	const del = document.createElement("button");
	const mover = document.createElement("button");
	const send = document.createElement("button");
	const btn = (b, text, title) => {
		b.textContent = text;
		b.title = title;
		b.style.cssText = "padding:4px 8px;border:1px solid #888;border-radius:4px;background:#fff;cursor:pointer;";
		return b;
	};
	btn(sfw, "SFW", "Alternar SFW / NSFW");
	btn(count, "👥 1", "Cantidad de personajes (1-4)");
	btn(reset, "Reiniciar", "Volver a la pose de reposo, sliders al punto medio y posición central");
	btn(posReset, "Restablecer posición", "Restablecer posición: pose y desplazamiento al origen, manteniendo los sliders de tamaño");
	btn(del, "🗑 Eliminar", "Eliminar el personaje seleccionado");
	btn(mover, "Mover", "Activar: arrastra el cuerpo para mover al personaje seleccionado");
	btn(send, "Enviar al calco", "Enviar la escena 3D al calco del nodo lineart");
	send.style.background = "#2e7d32";
	send.style.color = "#fff";
	send.style.borderColor = "#1b5e20";

	const syncButtons = () => {
		sfw.textContent = activeSlot(stateOf(node)).nsfw ? "NSFW" : "SFW";
		count.textContent = "👥 " + (state.characters.length || 1);
		selectorButtons.forEach((b, i) => {
			b.style.background = i === state.selected ? "#90caf9" : "#fff";
			b.disabled = i >= state.characters.length;
		});
		mover.style.background = state.moveMode ? "#ffcc80" : "#fff";
	};

	const selectSlot = (i) => {
		const st = stateOf(node);
		const idx = Math.max(0, Math.min(st.slots.length - 1, Number(i) || 0));
		st.selected = idx;
		state.selected = idx;
		state.save();
		rebuild();
		for (const row of sliderRows) {
			const v = sliderState().anatomy[row.key];
			if (v !== undefined) row.input.value = String(v);
		}
		syncButtons();
	};
	state.select = selectSlot;
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
		const slot = activeSlot(stateOf(node));
		for (const k of Object.keys(slot.anatomy)) {
			slot.anatomy[k] = /^(footRot[XYZ]|penisRot[XYZ]|hand[LR](Pos|Rot)[XYZ])$/
				.test(k) ? 0 : 0.5;
		}
		slot.anatomy.gender = 0.5;
		slot.pose = {};
		slot.offset = [0, 0, 0];
		slot.rotationY = 0;
		// Primero se reconstruye: save() captura las rotaciones de las mallas
		// vivas, así que si se guarda antes se reescriben las poses antiguas.
		rebuild();
		state.save();
		for (const row of sliderRows) {
			const v = sliderState().anatomy[row.key];
			if (v !== undefined) row.input.value = String(v);
		}
		syncButtons();
	};
	posReset.onclick = () => {
		const slot = activeSlot(stateOf(node));
		// Solo pose y emplazamiento: la anatomía (tamaños) queda intacta.
		slot.pose = {};
		slot.offset = [0, 0, 0];
		slot.rotationY = 0;
		rebuild();
		state.save();
		for (const row of sliderRows) {
			const v = sliderState().anatomy[row.key];
			if (v !== undefined) row.input.value = String(v);
		}
		syncButtons();
	};
	del.onclick = () => {
		const st = stateOf(node);
		if (st.slots.length <= 1) return;
		st.slots.splice(st.selected, 1);
		st.selected = Math.min(st.selected, st.slots.length - 1);
		state.selected = st.selected;
		rebuild();
		state.save();
		syncButtons();
	};
	mover.onclick = () => {
		state.moveMode = !state.moveMode;
		syncButtons();
	};
	send.onclick = () => {
		const [w, h] = captureSizeFor(node);
		setPoseStudioCapture(renderCapture(w, h), node.id);
	};
	tools.append(sfw, count, reset, posReset, del, mover, send);
	ui.panel.appendChild(tools);

	// --- Articulaciones ---
	const pickHandle = (event) => {
		const rect = ui.canvas.getBoundingClientRect();
		pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(pointer, camera);
		// Las flechas de movimiento tienen prioridad: están en la esquina y
		// son más pequeñas que los puntos de las articulaciones.
		if (moveGizmo.visible) {
			const arrows = raycaster.intersectObjects(state.gizmoArrows, false);
			if (arrows.length) {
				return { gizmo: true, axis: arrows[0].object.userData.moveAxis };
			}
		}
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

	const pickBody = (event) => {
		const rect = ui.canvas.getBoundingClientRect();
		pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(pointer, camera);
		const hits = raycaster.intersectObjects(state.characters.map((c) => c.mesh), false);
		return hits.length ? hits[0].object.userData.slot ?? null : null;
	};

	const pointerOnPlane = (event, plane) => {
		const rect = ui.canvas.getBoundingClientRect();
		pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(pointer, camera);
		const target = new THREE.Vector3();
		return raycaster.ray.intersectPlane(plane, target) ? target : null;
	};

	ui.canvas.addEventListener("pointerdown", (event) => {
		const hit = pickHandle(event);
		if (hit?.gizmo) {
			const index = state.selected;
			const model = state.characters[index];
			const slot = activeSlot(stateOf(node));
			const axis = new THREE.Vector3(
				hit.axis === "x" ? 1 : 0,
				hit.axis === "y" ? 1 : 0,
				hit.axis === "z" ? 1 : 0);
			const origin = moveGizmo.getWorldPosition(new THREE.Vector3());
			const camDir = camera.getWorldDirection(new THREE.Vector3());
			// Plano que contiene el eje y mira a la cámara: el cursor se
			// proyecta sobre él y solo se toma la componente del eje.
			const normal = new THREE.Vector3().crossVectors(axis, camDir)
				.cross(axis).normalize();
			const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
			const start = pointerOnPlane(event, plane);
			if (!start) return;
			state.axisDrag = {
				axis: hit.axis, plane, start,
				base: [...slot.offset], slot, model,
			};
			orbit.enabled = false;
			ui.canvas.setPointerCapture(event.pointerId);
			event.preventDefault();
			return;
		}
		if (!hit) {
			if (state.moveMode) {
				const index = pickBody(event);
				if (index === null) return;
				if (index !== state.selected) selectSlot(index);
				const model = state.characters[index];
				const world = new THREE.Vector3();
				model.group.getWorldPosition(world);
				const normal = camera.getWorldDirection(new THREE.Vector3());
				const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, world);
				const start = pointerOnPlane(event, plane);
				if (!start) return;
				const slot = stateOf(node).slots[index];
				state.moveDrag = {
					index, slot, plane, start, baseX: model.group.position.x,
					offset: [...slot.offset],
				};
				orbit.enabled = false;
				ui.canvas.setPointerCapture(event.pointerId);
				event.preventDefault();
			} else {
				state.pendingSelect = { x: event.clientX, y: event.clientY };
			}
			return;
		}
		state.pendingSelect = null;
		const bone = hit.bone;
		const parent = bone.parent;
		if (!parent || !parent.isBone) return;
		const world = new THREE.Vector3();
		bone.getWorldPosition(world);
		const normal = camera.getWorldDirection(new THREE.Vector3());
		const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, world);
		state.drag = {
			handle: hit, bone, parent, plane,
			offset: world.clone(),
			start: pointerOnPlane(event, plane),
		};
		if (bone.name === "penis_tip") {
			// El punto azul se lleva hasta el cursor: la dirección ancla→punta
			// sigue al ratón en el plano de la cámara, sin ejes invertidos.
			const pivot = bone.parent;
			const anchor = new THREE.Vector3();
			pivot.getWorldPosition(anchor);
			const parentQ = new THREE.Quaternion();
			pivot.parent.getWorldQuaternion(parentQ);
			const throughAnchor = new THREE.Plane()
				.setFromNormalAndCoplanarPoint(normal, anchor);
			state.drag.plane = throughAnchor;
			const tipWorld = new THREE.Vector3();
			bone.getWorldPosition(tipWorld);
			const a0 = activeSlot(stateOf(node)).anatomy;
			const q0 = new THREE.Quaternion()
				.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (a0.penisRotX || 0) * Math.PI / 180)
				.multiply(new THREE.Quaternion().setFromAxisAngle(
					new THREE.Vector3(0, 1, 0), (a0.penisRotY || 0) * Math.PI / 180))
				.multiply(new THREE.Quaternion().setFromAxisAngle(
					new THREE.Vector3(0, 0, 1), (a0.penisRotZ || 0) * Math.PI / 180));
			state.drag.penis = {
				anchor, parentQ, q: q0,
				dir: tipWorld.sub(anchor).normalize(),
			};
		}
		hit.mesh.material = hit.matActive;
		orbit.enabled = false;
		ui.canvas.setPointerCapture(event.pointerId);
		event.preventDefault();
	});

	ui.canvas.addEventListener("pointermove", (event) => {
		if (state.axisDrag) {
			const d = state.axisDrag;
			const target = pointerOnPlane(event, d.plane);
			if (!target) return;
			const delta = target.clone().sub(d.start);
			const value = Math.max(-8, Math.min(8,
				d.base[{ x: 0, y: 1, z: 2 }[d.axis]] + delta[d.axis]));
			d.slot.offset[{ x: 0, y: 1, z: 2 }[d.axis]] = value;
			if (d.model) d.model.group.position[d.axis] = value;
			requestRender();
			return;
		}
		if (state.moveDrag) {
			const target = pointerOnPlane(event, state.moveDrag.plane);
			if (!target) return;
			const d = target.clone().sub(state.moveDrag.start);
			const slot = state.moveDrag.slot;
			slot.offset[0] = state.moveDrag.offset[0] + d.x;
			slot.offset[1] = state.moveDrag.offset[1] + d.y;
			const model = state.characters[state.moveDrag.index];
			if (model) {
				model.group.position.x = state.moveDrag.baseX + d.x;
				model.group.position.y = slot.offset[1];
			}
			requestRender();
			return;
		}
		if (!state.drag) return;
		const rect = ui.canvas.getBoundingClientRect();
		pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(pointer, camera);
		const target = new THREE.Vector3();
		if (!raycaster.ray.intersectPlane(state.drag.plane, target)) return;

		if (state.drag.penis) {
			// Igual que los otros tiradores: rotación INCREMENTAL desde la
			// dirección actual hasta el cursor. Nunca se calcula un ángulo
			// absoluto desde el reposo, que daba saltos y marchas atrás al
			// cruzar el ancla o cambiar de lado.
			const drag = state.drag.penis;
			const desired = target.clone().sub(drag.anchor);
			if (desired.lengthSq() < 1e-6) return;
			desired.normalize();
			let dq = new THREE.Quaternion().setFromUnitVectors(drag.dir, desired);
			const angle = 2 * Math.acos(Math.max(-1, Math.min(1, dq.w)));
			if (angle < 0.02) return;
			if (angle > 1.0) {
				dq = new THREE.Quaternion().setFromAxisAngle(
					new THREE.Vector3(dq.x, dq.y, dq.z).normalize(), 1.0);
			}
			// El delta se mide en mundo y se lleva al marco local del pelvis.
			const inv = drag.parentQ.clone().invert();
			const localDelta = inv.clone().multiply(dq).multiply(drag.parentQ);
			const next = localDelta.multiply(drag.q).normalize();
			const e = new THREE.Euler().setFromQuaternion(next, "XYZ");
			const a = activeSlot(stateOf(node)).anatomy;
			a.penisRotX = e.x * 180 / Math.PI;
			a.penisRotY = e.y * 180 / Math.PI;
			a.penisRotZ = e.z * 180 / Math.PI;
			drag.q.copy(next);
			drag.dir.copy(desired);
			state.save();
			queueRebuild();
			requestRender();
			return;
		}

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

	const endDrag = (event) => {
		if (state.axisDrag) {
			state.axisDrag = null;
			orbit.enabled = true;
			state.save();
			requestRender();
			return;
		}
		if (state.moveDrag) {
			state.moveDrag = null;
			state.moveMode = false;
			orbit.enabled = true;
			state.save();
			syncButtons();
			requestRender();
			return;
		}
		if (state.pendingSelect) {
			const click = state.pendingSelect;
			state.pendingSelect = null;
			if (event && Math.hypot(event.clientX - click.x, event.clientY - click.y) < 4) {
				const index = pickBody(event);
				if (index !== null && index !== state.selected) selectSlot(index);
			}
		}
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
		const prevSelection = state.selectionVolume?.visible ?? false;

		state.lastCaptureSelectionVisible = state.selectionVolume?.visible ?? false;
		handlesGroup.visible = false;
		if (state.selectionVolume) state.selectionVolume.visible = false;
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		scene.updateMatrixWorld(true);
		// Se manda la vista ACTUAL: no se reencuadra. El visor ya tiene el
		// mismo aspecto que esta imagen, así que el resultado es lo que se ve.
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
		if (state.selectionVolume) state.selectionVolume.visible = prevSelection;
		return off.toDataURL("image/png");
	}
	state.renderCapture = renderCapture;

	try {
		state.pack = await getPack();
		rebuild();
		syncButtons();
		const savedCam = readCamera(node);
		if (savedCam) {
			orbit.target.fromArray(savedCam.target);
			camera.position.fromArray(savedCam.position);
			const dist = Math.max(0.01, camera.position.distanceTo(orbit.target));
			camera.near = Math.max(0.01, dist / 200);
			camera.far = dist * 20;
			camera.updateProjectionMatrix();
			orbit.update();
		} else {
			fitCamera(camera, orbit, sceneBox(scene));
		}
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
export function __selectSlotForTest(i) { return active?.select ? active.select(i) : null; }

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
