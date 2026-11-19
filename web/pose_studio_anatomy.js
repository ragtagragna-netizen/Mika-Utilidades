// Parámetros de anatomía del maniquí 3D y su mapeo al morph pack MakeHuman CC0.
//
// Enfoque (COM3D2/KCES, Character Creator, MetaHuman): cada slider actúa sobre
// una región delimitada por el propio rig — morph nativo para pecho/altura y
// pesos de piel para cintura/caderas/glúteos — o escala el hueso de la parte.
// No se usan campanas globales de Y: eran la causa de que el pecho deformara la
// espalda y las caderas el estómago.

export const ANATOMY_KEYS = [
	"height", "bust", "firmness", "waist", "hips", "glutes",
	"armLength", "legLength", "armThickness", "legThickness", "headSize",
	"genitalSize", "openingSize", "anusSize",
];

export const BODY_PRESETS = {
	curvy_female: {
		gender: 0, height: 0.55, bust: 0.82, firmness: 0.5, waist: 0.3,
		hips: 0.85, glutes: 0.8, armLength: 0.5, legLength: 0.55,
		armThickness: 0.45, legThickness: 0.5, headSize: 0.45,
		genitalSize: 0.5, openingSize: 0.5, anusSize: 0.5,
	},
	muscular_male: {
		gender: 1, height: 0.72, bust: 0.45, firmness: 0.7, waist: 0.55,
		hips: 0.4, glutes: 0.55, armLength: 0.7, legLength: 0.65,
		armThickness: 0.75, legThickness: 0.7, headSize: 0.5,
		genitalSize: 0.6, openingSize: 0.5, anusSize: 0.5,
	},
	slim_female: {
		gender: 0, height: 0.65, bust: 0.35, firmness: 0.45, waist: 0.2,
		hips: 0.35, glutes: 0.3, armLength: 0.6, legLength: 0.7,
		armThickness: 0.35, legThickness: 0.35, headSize: 0.5,
		genitalSize: 0.45, openingSize: 0.45, anusSize: 0.45,
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
	if (anatomy.genitalSize !== undefined) {
		a.penis_len = clamp01(anatomy.genitalSize);
		a.penis_circ = clamp01(anatomy.genitalSize);
	}
	a.show_genitals = nsfw && !female;

	const size = (key) => clampSize(anatomy[key] ?? 0.5);
	const localDeform = {
		waist: size("waist"),
		hips: size("hips"),
		glutes: size("glutes"),
		armThickness: size("armThickness"),
		legThickness: size("legThickness"),
		genitalSize: size("genitalSize"),
		height: size("height"),
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
	const heightStretch = h < 0 || h > 1 ? 1 + (h - 0.5) * 0.6 : 1;

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
