// Visibilidad por regiones del rig MakeHuman. La malla y el contorno comparten
// los índices filtrados, así que una parte oculta tampoco llega a la captura.

export const BODY_VISIBILITY_KEYS = [
	"hands", "feet", "head", "armL", "armR", "legL", "legR",
	"thighL", "thighR", "calfL", "calfR", "torso", "neck", "penis",
];

export function createDefaultBodyVisibility() {
	return Object.fromEntries(BODY_VISIBILITY_KEYS.map((key) => [key, true]));
}

const FINGERS = ["index_", "middle_", "ring_", "pinky_", "thumb_"];
const TORSO_BONES = new Set([
	"Root", "pelvis", "spine_01", "spine_02", "spine_03", "clavicle_l", "clavicle_r",
]);

function visibilityRulesForBone(name) {
	const side = name.endsWith("_l") ? "L" : name.endsWith("_r") ? "R" : null;
	if (name === "head") return ["head"];
	if (name === "neck_01") return ["neck"];
	if (name === "penis" || name === "penis_tip") return ["penis"];
	if (TORSO_BONES.has(name)) return ["torso"];
	if (!side) return [];
	const arm = "arm" + side;
	const leg = "leg" + side;
	if (name.startsWith("hand_") || FINGERS.some((p) => name.startsWith(p))) return ["hands", arm];
	if (name.startsWith("upperarm_") || name.startsWith("lowerarm_")) return [arm];
	if (name.startsWith("thigh_")) return [leg, "thigh" + side];
	if (name.startsWith("calf_")) return [leg, "calf" + side];
	if (name.startsWith("foot_") || name.startsWith("ball_")) return ["feet", leg];
	return [];
}

export function isVisibleBodyBone(name, visibility = {}) {
	return visibilityRulesForBone(name).every((key) => visibility?.[key] !== false);
}

export function bodyZoneForBone(name) {
	if (name === "penis" || name === "penis_tip") return "penis";
	if (name === "head" || name === "neck_01") return "head";
	if (name.startsWith("upperarm_") || name.startsWith("lowerarm_") ||
		name.startsWith("hand_") || FINGERS.some((prefix) => name.startsWith(prefix))) return "arms";
	if (name.startsWith("thigh_") || name.startsWith("calf_") ||
		name.startsWith("foot_") || name.startsWith("ball_")) return "legs";
	return "torso";
}

export function filterVisibleBodyIndices(
	indices, skinIndices, skinWeights, boneNames, visibility = {}, genitalIndices = [],
) {
	if (BODY_VISIBILITY_KEYS.every((key) => visibility?.[key] !== false)) return indices;
	const genitals = new Set(genitalIndices || []);
	const vertexCount = Math.floor(skinIndices.length / 4);
	const hidden = new Uint8Array(vertexCount);
	for (let v = 0; v < vertexCount; v++) {
		// Los genitales comparten pesos con pelvis, pero son una región propia:
		// ocultar el torso no debe hacer desaparecer el pene.
		if (genitals.has(v)) {
			hidden[v] = visibility?.penis === false ? 1 : 0;
			continue;
		}
		const o = v * 4;
		let best = -1;
		let bestWeight = -1;
		for (let k = 0; k < 4; k++) {
			if (skinWeights[o + k] > bestWeight) {
				bestWeight = skinWeights[o + k];
				best = skinIndices[o + k];
			}
		}
		if (best >= 0 && !isVisibleBodyBone(boneNames[best] || "", visibility)) hidden[v] = 1;
	}
	const kept = [];
	for (let i = 0; i + 2 < indices.length; i += 3) {
		const a = indices[i], b = indices[i + 1], c = indices[i + 2];
		if (!hidden[a] && !hidden[b] && !hidden[c]) kept.push(a, b, c);
	}
	return Uint32Array.from(kept);
}
