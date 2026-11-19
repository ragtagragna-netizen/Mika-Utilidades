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

// Los sliders de tamaño van de -1 a 2.5 con 0.5 = neutro. Los parámetros que
// llegan al solver siguen acotados a 0..1; el excedente se deforma localmente.
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
		armLength: size("armLength"),
		legLength: size("legLength"),
		headSize: size("headSize"),
		bust: size("bust"),
		firmness: size("firmness"),
		height: size("height"),
		genitalSize: size("genitalSize"),
		openingSize: size("openingSize"),
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

// Aplica cada banda por separado sobre los vértices resueltos. `t` va de 0
// (pies) a 1 (cabeza) y el peso de profundidad separa la cara anterior de la
// posterior, para que los glúteos no ensanchen el vientre y el pubis no toque
// la espalda. Solo la altura modifica Y, escalando desde los pies.
export function deformVertices(vertices, bounds, deform, metrics = {}) {
	const minY = metrics.minY ?? 0;
	const maxY = metrics.maxY ?? 10;
	const span = Math.max(0.001, maxY - minY);
	let mz = 0;
	if (metrics.maxZ === undefined) {
		for (let i = 2; i < vertices.length; i += 3) mz = Math.max(mz, Math.abs(vertices[i]));
	}
	const maxZ = Math.max(0.001, metrics.maxZ ?? mz);

	// Cada zona tiene una ventana Compacta que vale EXACTAMENTE 0 fuera de su
	// rango: un slider nunca puede tocar vertices de otra parte del cuerpo.
	const window = (t, center, halfWidth) => {
		const d = Math.abs(t - center) / halfWidth;
		return d >= 1 ? 0 : (1 - d * d) * (1 - d * d);
	};
	const unit = (v) => Math.min(1, Math.max(0, v));
	// 0 = plano, 0.5 = medio, 1 = grande, 1.75 = enorme, 2.5 = gigante.
	const level = (v) => (v <= 0.5 ? 0.4 + (Math.max(0, v) / 0.5) * 0.6 : 1 + (v - 0.5) * 0.7);

	const bustF = level(deform.bust ?? 0.5);
	const gluteF = level(deform.glutes ?? 0.5);
	const hipF = level(deform.hips ?? 0.5);
	const pubisF = 1 + (level(deform.genitalSize ?? 0.5) - 1) * 0.45;
	const waistF = 1 + (0.5 - (deform.waist ?? 0.5)) * 0.2;
	const firmExtra = Math.max(0, (deform.firmness ?? 0.5) - 1);
	const h = deform.height ?? 0.5;
	const heightStretch = h < 0 || h > 1 ? 1 + (h - 0.5) * 0.6 : 1;

	for (let i = 0; i < vertices.length; i += 3) {
		const y = vertices[i + 1];
		const z = vertices[i + 2];
		const t = (y - minY) / span;
		const front = unit((z / maxZ) * 1.5);
		const back = unit((-z / maxZ) * 1.5);

		const bustMask = window(t, 0.66, 0.075) * front;
		const gluteMask = window(t, 0.45, 0.06) * back;
		const hipMask = window(t, 0.46, 0.055);
		const waistMask = window(t, 0.56, 0.045);
		const pubisMask = window(t, 0.40, 0.04) * front;

		const f = 1
			+ (bustF - 1) * bustMask
			+ (gluteF - 1) * gluteMask
			+ (hipF - 1) * hipMask
			+ (waistF - 1) * waistMask
			+ (pubisF - 1) * pubisMask;

		vertices[i] *= f;
		vertices[i + 2] *= f + firmExtra * bustMask * 0.25;
		if (heightStretch !== 1) vertices[i + 1] = minY + (y - minY) * heightStretch;
	}
	return vertices;
}
