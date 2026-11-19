// Parámetros de anatomía del maniquí 3D y su mapeo al morph pack MakeHuman CC0.

export const ANATOMY_KEYS = [
	"height", "bust", "firmness", "waist", "hips", "glutes",
	"armLength", "legLength", "headSize",
	"genitalSize", "openingSize", "anusSize",
];

export const BODY_PRESETS = {
	curvy_female: {
		gender: 0, height: 0.55, bust: 0.82, firmness: 0.5, waist: 0.3,
		hips: 0.85, glutes: 0.8, armLength: 0.5, legLength: 0.55, headSize: 0.45,
		genitalSize: 0.5, openingSize: 0.5, anusSize: 0.5,
	},
	muscular_male: {
		gender: 1, height: 0.72, bust: 0.45, firmness: 0.7, waist: 0.55,
		hips: 0.4, glutes: 0.55, armLength: 0.7, legLength: 0.65, headSize: 0.5,
		genitalSize: 0.6, openingSize: 0.5, anusSize: 0.5,
	},
	slim_female: {
		gender: 0, height: 0.65, bust: 0.35, firmness: 0.45, waist: 0.2,
		hips: 0.35, glutes: 0.3, armLength: 0.6, legLength: 0.7, headSize: 0.5,
		genitalSize: 0.45, openingSize: 0.45, anusSize: 0.45,
	},
};

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

// Devuelve los parámetros que entiende `solveMorph` más las deformaciones
// locales que el asset no trae como morph.
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

	const localDeform = {
		waist: clamp01(anatomy.waist ?? 0.5),
		hips: clamp01(anatomy.hips ?? 0.5),
		glutes: clamp01(anatomy.glutes ?? 0.5),
		armLength: clamp01(anatomy.armLength ?? 0.5),
		legLength: clamp01(anatomy.legLength ?? 0.5),
		headSize: clamp01(anatomy.headSize ?? 0.5),
	};

	return {
		...a,
		localDeform,
		genitalMeshes: nsfw ? {
			vagina: female ? clamp01(anatomy.genitalSize ?? 0.5) : 0,
			opening: female ? clamp01(anatomy.openingSize ?? 0.5) : 0,
			anus: clamp01(anatomy.anusSize ?? 0.5),
		} : null,
		nsfw,
	};
}

// Aplica las deformaciones locales sobre los vértices resueltos. Cada banda
// se escala en X/Z según su altura normalizada (0 = pies, 1 = cabeza).
export function deformVertices(vertices, bounds, deform, metrics = {}) {
	const minY = metrics.minY ?? 0;
	const maxY = metrics.maxY ?? 10;
	const span = Math.max(0.001, maxY - minY);
	const gaussian = (t, c, w) => Math.exp(-((t - c) ** 2) / (2 * w * w));
	for (let i = 0; i < vertices.length; i += 3) {
		const y = vertices[i + 1];
		const t = (y - minY) / span;
		const waist = gaussian(t, 0.52, 0.055) * (0.5 - deform.waist) * 0.5;
		const hips = gaussian(t, 0.45, 0.07) * (deform.hips - 0.5) * 0.45;
		const glutes = gaussian(t, 0.43, 0.05) * (deform.glutes - 0.5) * 0.4;
		const k = 1 + waist + hips + glutes;
		vertices[i] *= k;
		vertices[i + 2] *= k;
	}
	return vertices;
}
