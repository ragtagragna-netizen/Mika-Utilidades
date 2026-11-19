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
// Landmarks medidos del pack MakeHuman (t normalizado 0=pies, 1=cabeza):
//   pelvis 0.553, spine_02 0.610, spine_03 0.654, clavicula 0.795,
//   pecho ~0.73, cintura ~0.63, cadera ~0.54, gluteo ~0.55 (cara trasera).
// Los brazos caen hasta t≈0.55 con |x|≈3.5, asi que ademas se excluyen con
// una mascara horizontal: antes se interpretaban como caderas.
export function deformVertices(vertices, bounds, deform, metrics = {}) {
	const minY = metrics.minY ?? 0;
	const maxY = metrics.maxY ?? 10;
	const span = Math.max(0.001, maxY - minY);
	let mz = 0;
	let mx = 0;
	if (metrics.maxZ === undefined || metrics.maxX === undefined) {
		for (let i = 0; i < vertices.length; i += 3) {
			mz = Math.max(mz, Math.abs(vertices[i + 2]));
			mx = Math.max(mx, Math.abs(vertices[i]));
		}
	}
	const maxZ = Math.max(0.001, metrics.maxZ ?? mz);
	const maxX = Math.max(0.001, metrics.maxX ?? mx);

	const window = (t, center, halfWidth) => {
		const d = Math.abs(t - center) / halfWidth;
		return d >= 1 ? 0 : (1 - d * d) * (1 - d * d);
	};
	const unit = (v) => Math.min(1, Math.max(0, v));
	const gate = (v) => unit(v * 3);
	// 0 = plano, 0.5 = medio, 1 = grande, 1.75 = enorme, 2.5 = gigante.
	const level = (v) => (v <= 0.5 ? 0.4 + (Math.max(0, v) / 0.5) * 0.6 : 1 + (v - 0.5) * 0.8);

	// El torso central termina mucho antes que los brazos caídos (|x|≈3.5).
	const bodyLimit = Math.min(maxX * 0.35, 1.35);
	const core = (x) => unit((bodyLimit - Math.abs(x)) / 0.5);
	const bustF = level(deform.bust ?? 0.5);
	const gluteF = level(deform.glutes ?? 0.5);
	const hipF = level(deform.hips ?? 0.5);
	const pubisF = 1 + (level(deform.genitalSize ?? 0.5) - 1) * 0.45;
	const waistF = 1 + (0.5 - (deform.waist ?? 0.5)) * 0.2;
	const firmExtra = Math.max(0, (deform.firmness ?? 0.5) - 1);
	const h = deform.height ?? 0.5;
	const heightStretch = h < 0 || h > 1 ? 1 + (h - 0.5) * 0.6 : 1;

	for (let i = 0; i < vertices.length; i += 3) {
		const x = vertices[i];
		const y = vertices[i + 1];
		const z = vertices[i + 2];
		const t = (y - minY) / span;
		const front = gate(z / maxZ);
		const back = gate(-z / maxZ);
		const torso = core(x);

		const bustMask = window(t, 0.73, 0.05) * front * torso;
		const waistMask = window(t, 0.63, 0.035) * torso;
		const hipMask = window(t, 0.54, 0.045) * torso;
		const gluteMask = window(t, 0.55, 0.04) * back * torso;
		const pubisMask = window(t, 0.545, 0.025) * front
			* unit((1.2 - Math.abs(x)) / 0.5);

		// El pecho y los gluteos crecen como bultos redondeados alrededor de
		// su propio centro, no como una losa que ensancha todo el torso.
		const breastX = x >= 0 ? 0.5 : -0.5;
		const chestY = minY + 0.73 * span;
		const gluteY = minY + 0.55 * span;
		const kb = 1 + (bustF - 1) * bustMask;
		const kg = 1 + (gluteF - 1) * gluteMask;
		const f = 1
			+ (waistF - 1) * waistMask
			+ (hipF - 1) * hipMask
			+ (pubisF - 1) * pubisMask;

		let nx = x;
		let ny = y;
		let nz = z;
		if (kb !== 1) {
			nx = breastX + (x - breastX) * kb;
			ny = chestY + (y - chestY) * (1 + (kb - 1) * 0.5);
			nz *= kb;
		}
		if (kg !== 1) {
			nx = breastX + (nx - breastX) * kg;
			ny = gluteY + (ny - gluteY) * (1 + (kg - 1) * 0.5);
			nz *= kg;
		}
		vertices[i] = nx * f;
		vertices[i + 1] = ny;
		vertices[i + 2] = nz * f + firmExtra * bustMask * 0.25;
		if (heightStretch !== 1) {
			vertices[i + 1] = minY + (vertices[i + 1] - minY) * heightStretch;
		}
	}
	return vertices;
}
