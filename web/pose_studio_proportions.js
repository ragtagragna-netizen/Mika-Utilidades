// Proporciones residuales de edad. El morph nativo sigue siendo la base; esta
// capa compara el mismo cuerpo a 30 años y ajusta solo lo necesario para llegar
// a la tabla aprobada, con los mismos deltas en vértices y articulaciones.

import { solveMorph } from "./pose_studio/morph_runtime.mjs";

const CONTROLS = [
	[1, { head: 1.8, trunk: 0.8, upperarm: 0.68, lowerarm: 0.65, thigh: 0.68, calf: 0.65 }],
	[7, { head: 1.2, trunk: 0.9, upperarm: 0.84, lowerarm: 0.82, thigh: 0.86, calf: 0.84 }],
	[16, { head: 1.07, trunk: 0.98, upperarm: 0.96, lowerarm: 0.96, thigh: 0.97, calf: 0.97 }],
	[30, { head: 1, trunk: 1, upperarm: 1, lowerarm: 1, thigh: 1, calf: 1 }],
	[60, { head: 1, trunk: 1, upperarm: 1, lowerarm: 1, thigh: 1, calf: 1 }],
	[90, { head: 1.02, trunk: 0.96, upperarm: 0.97, lowerarm: 0.97, thigh: 0.97, calf: 0.96 }],
];
const FINGERS = ["index_", "middle_", "ring_", "pinky_", "thumb_"];
const REFERENCES = new Map();

export function ageProportionProfile(age) {
	const years = Math.max(1, Math.min(90, Number(age) || 30));
	let index = 0;
	while (index < CONTROLS.length - 2 && years > CONTROLS[index + 1][0]) index++;
	const [a, va] = CONTROLS[index];
	const [b, vb] = CONTROLS[index + 1];
	let t = Math.max(0, Math.min(1, (years - a) / (b - a)));
	t = t * t * (3 - 2 * t);
	return Object.fromEntries(Object.keys(va).map((key) => [key, va[key] + (vb[key] - va[key]) * t]));
}

function heightOf(vertices) {
	let min = Infinity, max = -Infinity;
	for (let i = 1; i < vertices.length; i += 3) {
		min = Math.min(min, vertices[i]);
		max = Math.max(max, vertices[i]);
	}
	return Math.max(0.001, max - min);
}

function point(positions, index, tail = false) {
	const o = index * 6 + (tail ? 3 : 0);
	return [positions[o], positions[o + 1], positions[o + 2]];
}

function distance(a, b) {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function boneLength(positions, names, name) {
	const index = names.indexOf(name);
	return index < 0 ? 0.001 : Math.max(0.001, distance(point(positions, index), point(positions, index, true)));
}

function trunkLength(positions, names) {
	return ["spine_01", "spine_02", "spine_03", "neck_01"]
		.reduce((sum, name) => sum + boneLength(positions, names, name), 0);
}

function referenceFor(pack, params) {
	const height = Math.max(0, Math.min(1, Number(params.rawAnatomy?.height ?? params.height ?? 0.5)));
	const native = {
		gender: params.gender, weight: params.weight, muscle: params.muscle,
		height, breast_size: params.breast_size, firmness: params.firmness,
	};
	const key = JSON.stringify(native);
	if (!REFERENCES.has(key)) {
		if (REFERENCES.size > 32) REFERENCES.clear();
		REFERENCES.set(key, solveMorph(pack, { ...native, age: 30, show_genitals: false }));
	}
	return REFERENCES.get(key);
}

function scaleArrayPoint(array, offset, center, factor) {
	for (let axis = 0; axis < 3; axis++) {
		array[offset + axis] = center[axis] + (array[offset + axis] - center[axis]) * factor;
	}
}

function scaleUpperBody(vertices, bonePositions, staticData, names, center, factor) {
	if (Math.abs(factor - 1) < 1e-8) return;
	const upper = (name) => name === "head" || name === "neck_01" || name.startsWith("spine_") ||
		name.startsWith("clavicle_") || name.startsWith("upperarm_") || name.startsWith("lowerarm_") ||
		name.startsWith("hand_") || FINGERS.some((prefix) => name.startsWith(prefix));
	for (let v = 0; v < vertices.length / 3; v++) {
		let weight = 0;
		for (let k = 0; k < 4; k++) {
			if (upper(names[staticData.skinIndices[v * 4 + k]])) weight += staticData.skinWeights[v * 4 + k];
		}
		if (weight < 0.001) continue;
		const i = v * 3;
		for (let axis = 0; axis < 3; axis++) {
			vertices[i + axis] += (center[axis] + (vertices[i + axis] - center[axis]) * factor - vertices[i + axis]) * weight;
		}
	}
	for (let i = 0; i < names.length; i++) {
		if (!upper(names[i])) continue;
		scaleArrayPoint(bonePositions, i * 6, center, factor);
		scaleArrayPoint(bonePositions, i * 6 + 3, center, factor);
	}
}

function scaleHead(vertices, bonePositions, staticData, names, factor) {
	if (Math.abs(factor - 1) < 1e-8) return;
	const index = names.indexOf("head");
	if (index < 0) return;
	const center = point(bonePositions, index);
	for (let v = 0; v < vertices.length / 3; v++) {
		let weight = 0;
		for (let k = 0; k < 4; k++) {
			if (names[staticData.skinIndices[v * 4 + k]] === "head") weight += staticData.skinWeights[v * 4 + k];
		}
		if (weight < 0.001) continue;
		const i = v * 3;
		for (let axis = 0; axis < 3; axis++) {
			vertices[i + axis] += (center[axis] + (vertices[i + axis] - center[axis]) * factor - vertices[i + axis]) * weight;
		}
	}
	scaleArrayPoint(bonePositions, index * 6 + 3, center, factor);
}

function shiftBone(bonePositions, names, name, delta, tail = false) {
	const index = names.indexOf(name);
	if (index < 0) return;
	const o = index * 6 + (tail ? 3 : 0);
	for (let axis = 0; axis < 3; axis++) bonePositions[o + axis] += delta[axis];
}

function stretchSegment(vertices, bonePositions, staticData, names, side, segment, factor) {
	if (Math.abs(factor - 1) < 1e-8) return;
	const index = names.indexOf(segment + "_" + side);
	if (index < 0) return;
	const head = point(bonePositions, index);
	const tail = point(bonePositions, index, true);
	const length = Math.max(0.001, distance(head, tail));
	const axis = tail.map((value, i) => (value - head[i]) / length);
	const delta = axis.map((value) => value * length * (factor - 1));
	const descendants = {
		upperarm: ["lowerarm_", "hand_", ...FINGERS],
		lowerarm: ["hand_", ...FINGERS],
		thigh: ["calf_", "foot_", "ball_"],
		calf: ["foot_", "ball_"],
	}[segment];
	const chain = [segment + "_", ...descendants];
	shiftBone(bonePositions, names, segment + "_" + side, delta, true);
	for (const prefix of descendants) {
		for (const suffix of ["01_", "02_", "03_", ""]) {
			const name = prefix + suffix + side;
			if (!names.includes(name)) continue;
			shiftBone(bonePositions, names, name, delta);
			shiftBone(bonePositions, names, name, delta, true);
		}
	}
	for (let v = 0; v < vertices.length / 3; v++) {
		let weight = 0;
		for (let k = 0; k < 4; k++) {
			const name = names[staticData.skinIndices[v * 4 + k]] || "";
			if (chain.some((prefix) => name.startsWith(prefix)) && name.endsWith("_" + side)) {
				weight += staticData.skinWeights[v * 4 + k];
			}
		}
		if (weight < 0.001) continue;
		const i = v * 3;
		const along = (vertices[i] - head[0]) * axis[0] + (vertices[i + 1] - head[1]) * axis[1] +
			(vertices[i + 2] - head[2]) * axis[2];
		const amount = Math.max(0, Math.min(length, along)) * (factor - 1) * weight;
		for (let a = 0; a < 3; a++) vertices[i + a] += axis[a] * amount;
	}
}

function refreshLandmarks(solved) {
	if (!solved.landmarkIndices) return;
	for (const [name, indices] of Object.entries(solved.landmarkIndices)) {
		if (!indices?.length) continue;
		const center = [0, 0, 0];
		let count = 0;
		for (const v of indices) {
			if (v * 3 + 2 >= solved.vertices.length) continue;
			for (let axis = 0; axis < 3; axis++) center[axis] += solved.vertices[v * 3 + axis];
			count++;
		}
		if (count) solved.landmarks[name] = center.map((value) => value / count);
	}
}

export function applyAgeProportions(pack, solved, staticData, params = {}) {
	const years = Math.max(1, Math.min(90, Number(params.age ?? 30)));
	if (Math.abs(years - 30) < 1e-8) return;
	const profile = ageProportionProfile(years);
	const reference = referenceFor(pack, params);
	const names = pack.bones.map((bone) => bone.name);
	const referenceHeight = heightOf(reference.vertices);
	const nativeVertices = solved.vertices.slice();
	const nativeBones = solved.bonePositions.slice();
	let normalizationHeight = heightOf(nativeVertices);

	for (let iteration = 0; iteration < 12; iteration++) {
		solved.vertices.set(nativeVertices);
		solved.bonePositions.set(nativeBones);
		const currentHeight = heightOf(solved.vertices);
		const target = (key, positions) => {
			const current = key === "trunk" ? trunkLength(positions, names)
				: key === "head" ? boneLength(positions, names, "head") : boneLength(positions, names, key + "_l");
			const adult = key === "trunk" ? trunkLength(reference.bonePositions, names)
				: key === "head" ? boneLength(reference.bonePositions, names, "head") : boneLength(reference.bonePositions, names, key + "_l");
			return profile[key] * (adult / referenceHeight) * normalizationHeight / Math.max(0.001, current);
		};
		const pelvisIndex = names.indexOf("pelvis");
		const pelvis = point(solved.bonePositions, pelvisIndex);
		scaleUpperBody(solved.vertices, solved.bonePositions, staticData, names, pelvis, target("trunk", solved.bonePositions));
		for (const segment of ["upperarm", "lowerarm", "thigh", "calf"]) {
			const factor = target(segment, solved.bonePositions);
			for (const side of ["l", "r"]) {
				stretchSegment(solved.vertices, solved.bonePositions, staticData, names, side, segment, factor);
			}
		}
		scaleHead(solved.vertices, solved.bonePositions, staticData, names, target("head", solved.bonePositions));
		normalizationHeight = heightOf(solved.vertices);
		if (Math.abs(normalizationHeight - currentHeight) < 0.0001) break;
	}
	refreshLandmarks(solved);
}
