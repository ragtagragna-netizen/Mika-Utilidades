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
	const g = (v, c, s) => Math.exp(-0.5 * ((v - c) / s) ** 2);

	// 0 = plano, 0.5 = medio, 1 = grande, 1.75 = enorme, 2.5 = gigante.
	const level = (v) => (
		v <= 0.5 ? 0.5 + (Math.max(0, v) / 0.5) * 0.5 : 1 + (v - 0.5) * 0.55
	);
	const bustF = level(deform.bust ?? 0.5);
	const gluteF = level(deform.glutes ?? 0.5);
	// La cadera ensancha menos que el pecho: un factor alto forma una falda.
	const hipF = 1 + (level(deform.hips ?? 0.5) - 1) * 0.6;
	const pubisF = 1 + (level(deform.genitalSize ?? 0.5) - 1) * 0.5;
	const waistF = 1 + (0.5 - (deform.waist ?? 0.5)) * 0.16;
	const firmExtra = Math.max(0, (deform.firmness ?? 0.5) - 1);
	const h = deform.height ?? 0.5;
	const heightStretch = h < 0 || h > 1 ? 1 + (h - 0.5) * 0.6 : 1;

	for (let i = 0; i < vertices.length; i += 3) {
		let x = vertices[i];
		let y = vertices[i + 1];
		let z = vertices[i + 2];
		const t = (y - minY) / span;
		const nx = x / span;
		const nz = z / span;

		// Dos senos: campanas 3D suaves, sin bordes duros ni cortes. El bulto
		// crece desde su propio centro en X, Y y Z, así no aparecen puntas.
		for (const side of [-1, 1]) {
			const cx = side * 0.045;
			const cz = 0.08;
			const w = g(nx, cx, 0.05) * g(t, 0.73, 0.04) * g(nz, cz, 0.09);
			if (w < 0.001) continue;
			const k = 1 + (bustF - 1) * w;
			x = cx * span + (x - cx * span) * k;
			y = (minY + 0.73 * span) + (y - (minY + 0.73 * span)) * (1 + (bustF - 1) * w * 0.45);
			z = cz * span + (z - cz * span) * k;
		}

		// Glúteos: mismo modelo en la cara posterior.
		for (const side of [-1, 1]) {
			const cx = side * 0.03;
			const cz = -0.07;
			const w = g(nx, cx, 0.055) * g(t, 0.55, 0.045) * g(nz, cz, 0.06);
			if (w < 0.001) continue;
			const k = 1 + (gluteF - 1) * w;
			x = cx * span + (x - cx * span) * k;
			y = (minY + 0.55 * span) + (y - (minY + 0.55 * span)) * (1 + (gluteF - 1) * w * 0.4);
			z = cz * span + (z - cz * span) * k;
		}

		// Caderas: ensanchamiento suave alrededor de la pelvis.
		const wh = g(t, 0.54, 0.03) * g(nx, 0, 0.12);
		if (wh > 0.001) {
			const k = 1 + (hipF - 1) * wh;
			x *= k;
			z *= k;
		}

		// Cintura: estrechamiento suave.
		const ww = g(t, 0.63, 0.045) * g(nx, 0, 0.11);
		if (ww > 0.001) {
			const k = 1 + (waistF - 1) * ww;
			x *= k;
			z *= k;
		}

		// Pubis: volumen frontal pequeño.
		const wp = g(t, 0.545, 0.03) * g(nx, 0, 0.07) * g(nz, 0.07, 0.05);
		if (wp > 0.001) {
			const k = 1 + (pubisF - 1) * wp;
			x *= k;
			z *= k;
		}

		vertices[i] = x;
		vertices[i + 1] = heightStretch === 1 ? y : minY + (y - minY) * heightStretch;
		vertices[i + 2] = z + firmExtra * g(t, 0.73, 0.04) * g(nz, 0.08, 0.09) * 0.25 * span;
	}
	return vertices;
}
