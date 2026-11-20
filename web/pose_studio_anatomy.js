// Parámetros de anatomía del maniquí 3D y su mapeo al morph pack MakeHuman CC0.
//
// Enfoque (COM3D2/KCES, Character Creator, MetaHuman): cada slider actúa sobre
// una región delimitada por el propio rig — morph nativo para pecho/altura y
// pesos de piel para cintura/caderas/glúteos — o escala el hueso de la parte.
// No se usan campanas globales de Y: eran la causa de que el pecho deformara la
// espalda y las caderas el estómago.

export const ANATOMY_KEYS = [
	"height", "width", "bust", "firmness", "waist", "stomach", "hips", "glutes",
	"armLength", "legLength", "armThickness", "thighThickness",
	"calfThickness", "handSize", "footSize", "handGripL", "handGripR",
	"handLPosX", "handLPosY", "handLPosZ",
	"handRPosX", "handRPosY", "handRPosZ",
	"handLRotX", "handLRotY", "handLRotZ",
	"handRRotX", "handRRotY", "handRRotZ",
	"footRotX", "footRotY", "footRotZ",
	"headSize", "genitalSize", "openingSize", "anusSize",
	"penisLength", "penisGirth",
];

export const BODY_PRESETS = {
	curvy_female: {
		gender: 0, height: 0.55, width: 0.5, bust: 0.82, firmness: 0.5, waist: 0.3, stomach: 0.5,
		hips: 0.85, glutes: 0.8, armLength: 0.5, legLength: 0.55,
		armThickness: 0.45, thighThickness: 0.5, calfThickness: 0.5, handSize: 0.5, footSize: 0.5,
		handGripL: 0.5, handGripR: 0.5,
		handLPosX: 0, handLPosY: 0, handLPosZ: 0,
		handRPosX: 0, handRPosY: 0, handRPosZ: 0,
		handLRotX: 0, handLRotY: 0, handLRotZ: 0,
		handRRotX: 0, handRRotY: 0, handRRotZ: 0,
		footRotX: 0, footRotY: 0, footRotZ: 0,
		headSize: 0.45,
		genitalSize: 0.5, openingSize: 0.5, anusSize: 0.5,
		penisLength: 0.5, penisGirth: 0.5,
		
	},
	muscular_male: {
		gender: 1, height: 0.72, width: 0.5, bust: 0.45, firmness: 0.7, waist: 0.55, stomach: 0.5,
		hips: 0.4, glutes: 0.55, armLength: 0.7, legLength: 0.65,
		armThickness: 0.75, thighThickness: 0.7, calfThickness: 0.65, handSize: 0.5, footSize: 0.5,
		handGripL: 0.5, handGripR: 0.5,
		handLPosX: 0, handLPosY: 0, handLPosZ: 0,
		handRPosX: 0, handRPosY: 0, handRPosZ: 0,
		handLRotX: 0, handLRotY: 0, handLRotZ: 0,
		handRRotX: 0, handRRotY: 0, handRRotZ: 0,
		footRotX: 0, footRotY: 0, footRotZ: 0, headSize: 0.5,
		genitalSize: 0.6, openingSize: 0.5, anusSize: 0.5,
		penisLength: 0.6, penisGirth: 0.55,
		
	},
	slim_female: {
		gender: 0, height: 0.65, width: 0.5, bust: 0.35, firmness: 0.45, waist: 0.2, stomach: 0.5,
		hips: 0.35, glutes: 0.3, armLength: 0.6, legLength: 0.7,
		armThickness: 0.35, thighThickness: 0.35, calfThickness: 0.35, handSize: 0.5, footSize: 0.5,
		handGripL: 0.5, handGripR: 0.5,
		handLPosX: 0, handLPosY: 0, handLPosZ: 0,
		handRPosX: 0, handRPosY: 0, handRPosZ: 0,
		handLRotX: 0, handLRotY: 0, handLRotZ: 0,
		handRRotX: 0, handRRotY: 0, handRRotZ: 0,
		footRotX: 0, footRotY: 0, footRotZ: 0, headSize: 0.5,
		genitalSize: 0.45, openingSize: 0.45, anusSize: 0.45,
		penisLength: 0.5, penisGirth: 0.5,
		
	},
};

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

// Los sliders de tamaño van de -1 a 2.5 con 0.5 = neutro.
export function clampSize(v) {
	return Math.min(2.5, Math.max(-1, Number(v) || 0));
}

export function applyAnatomy(anatomy = {}, base = {}) {
	const a = { ...base };
	const g = clamp01(anatomy.gender ?? a.gender ?? 0.5);
	const nsfw = anatomy.nsfw === true;
	const female = g < 0.5;

	a.gender = g;
	if (anatomy.height !== undefined) a.height = clamp01(anatomy.height);
	if (anatomy.bust !== undefined) a.breast_size = clamp01(anatomy.bust);
	if (anatomy.firmness !== undefined) a.firmness = clamp01(anatomy.firmness);
	// Largo y grosor del pene son morfs nativos independientes; genitalSize
	// sigue controlando el volumen de las piezas procedurales femeninas.
	if (anatomy.penisLength !== undefined) a.penis_len = clamp01(anatomy.penisLength);
	if (anatomy.penisGirth !== undefined) a.penis_circ = clamp01(anatomy.penisGirth);
	a.show_genitals = nsfw && !female;

	const size = (key) => clampSize(anatomy[key] ?? 0.5);
	const localDeform = {
		waist: size("waist"),
		stomach: size("stomach"),
		hips: size("hips"),
		glutes: size("glutes"),
		armLength: size("armLength"),
		legLength: size("legLength"),
		armThickness: size("armThickness"),
		thighThickness: size("thighThickness"),
		calfThickness: size("calfThickness"),
		handSize: size("handSize"),
		footSize: size("footSize"),
		handGripL: size("handGripL"),
		handGripR: size("handGripR"),
		genitalSize: size("genitalSize"),
		height: size("height"),
		width: size("width"),
		// El pene gira alrededor de su ancla en la entrepierna, como un hueso:
		// son ángulos (grados), no desplazamientos, y no van por clampSize.
		penisRotX: Number(anatomy.penisRotX ?? 0),
		penisRotY: Number(anatomy.penisRotY ?? 0),
		penisRotZ: Number(anatomy.penisRotZ ?? 0),
		// El morph nativo llega a 1; por encima el target procedural escala
		// el miembro hasta ×1.5 de largo y ×3 de grosor en el slider 2.5.
		penisLength: Number(anatomy.penisLength ?? 0.5),
		penisGirth: Number(anatomy.penisGirth ?? 0.5),
	};

	return {
		...a,
		localDeform,
		genitalMeshes: nsfw ? {
			vagina: female ? clampSize(anatomy.genitalSize ?? 0.5) : 0,
			opening: female ? clampSize(anatomy.openingSize ?? 0.5) : 0,
			anus: clampSize(anatomy.anusSize ?? 0.5),
		} : null,
		nsfw,
	};
}

// Deformación regional usando los pesos de piel del propio rig: el hueso
// dominante de cada vértice decide a qué parte pertenece. Así el estómago
// (spine_01/02) nunca responde a caderas, y la espalda nunca al pecho (que ya
// lo controla el morph nativo breast_size).
export function deformVertices(vertices, bounds, deform, metrics = {}) {
	const minY = metrics.minY ?? 0;
	const maxY = metrics.maxY ?? 10;
	const span = Math.max(0.001, maxY - minY);
	const indices = metrics.skinIndices;
	const weights = metrics.skinWeights;
	const names = metrics.boneNames || [];
	const indexOf = (name) => names.indexOf(name);
	const spine = [indexOf("spine_01"), indexOf("spine_02")].filter((i) => i >= 0);
	const pelvis = indexOf("pelvis");
	const thighs = [indexOf("thigh_l"), indexOf("thigh_r")].filter((i) => i >= 0);
	const hasRig = !!indices && !!weights && spine.length > 0 && pelvis >= 0;

	const waistF = 1 + (0.5 - (deform.waist ?? 0.5)) * 0.5;
	const hipF = 1 + ((deform.hips ?? 0.5) - 0.5) * 0.45;
	const gluteF = 1 + ((deform.glutes ?? 0.5) - 0.5) * 0.55;
	const h = deform.height ?? 0.5;
	// Continuo en 0 y 1: el salto que había en esos límites partía la anatomía.
	const extraH = h > 1 ? h - 1 : h < 0 ? h : 0;
	const heightStretch = 1 + extraH * 0.22;

	for (let i = 0; i < vertices.length; i += 3) {
		const v = i / 3;
		const y = vertices[i + 1];
		const t = (y - minY) / span;
		let fx = 1;
		let fz = 1;

		if (hasRig) {
			const o = v * 4;
			let best = -1;
			let bestW = 0;
			for (let k = 0; k < 4; k++) {
				const w = weights[o + k];
				if (w > bestW) { bestW = w; best = indices[o + k]; }
			}
			if (spine.includes(best)) {
				fx = waistF;
				fz = waistF;
			} else if (best === pelvis || thighs.includes(best)) {
				if (t > 0.46 && t < 0.62) {
					fx = hipF;
					fz = hipF;
					if (vertices[i + 2] < 0) fz *= gluteF;
				}
			}
		}

		vertices[i] *= fx;
		vertices[i + 2] *= fz;
		if (heightStretch !== 1) vertices[i + 1] = minY + (y - minY) * heightStretch;
	}
	return vertices;
}
