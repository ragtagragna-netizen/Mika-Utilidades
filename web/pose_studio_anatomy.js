// Parámetros de anatomía del maniquí 3D y su mapeo al morph pack MakeHuman CC0.
//
// Enfoque (COM3D2/KCES, Character Creator, MetaHuman): cada slider actúa sobre
// una región delimitada por el propio rig — morph nativo para pecho/altura y
// pesos de piel para cintura/caderas/glúteos — o escala el hueso de la parte.
// No se usan campanas globales de Y: eran la causa de que el pecho deformara la
// espalda y las caderas el estómago.

export const ANATOMY_KEYS = [
	"age", "weight", "height", "width", "bust", "firmness", "waist", "stomach", "hips", "glutes",
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

// Base completa: al aplicar un preset se sobrescriben TODAS las claves,
// para que no queden valores del maniquí anterior.
const preset = (o = {}) => ({
	gender: 0, age: 30, weight: 0.5, height: 0.6, width: 0.5,
	bust: 0.5, firmness: 0.5, waist: 0.5, stomach: 0.5, hips: 0.5, glutes: 0.5,
	armLength: 0.5, legLength: 0.5, armThickness: 0.5,
	thighThickness: 0.5, calfThickness: 0.5, handSize: 0.5, footSize: 0.5,
	handGripL: 0.5, handGripR: 0.5,
	handLPosX: 0, handLPosY: 0, handLPosZ: 0,
	handRPosX: 0, handRPosY: 0, handRPosZ: 0,
	handLRotX: 0, handLRotY: 0, handLRotZ: 0,
	handRRotX: 0, handRRotY: 0, handRRotZ: 0,
	footRotX: 0, footRotY: 0, footRotZ: 0,
	headSize: 0.45, genitalSize: 0.5, openingSize: 0.5, anusSize: 0.5,
	penisLength: 0.5, penisGirth: 0.5,
	...o,
});

export const BODY_PRESETS = {
	curvy_female: preset({
		age: 30, height: 0.55, bust: 0.82, waist: 0.3, hips: 0.85, glutes: 0.8,
		armThickness: 0.45, headSize: 0.45,
	}),
	muscular_male: preset({
		gender: 1, age: 30, height: 0.72, bust: 0.45, firmness: 0.7, waist: 0.55,
		hips: 0.4, glutes: 0.55, armLength: 0.7, legLength: 0.65,
		armThickness: 0.75, thighThickness: 0.7, calfThickness: 0.65, headSize: 0.5,
		genitalSize: 0.6, penisLength: 0.6, penisGirth: 0.55,
	}),
	slim_female: preset({
		age: 25, height: 0.65, bust: 0.35, waist: 0.2, hips: 0.35, glutes: 0.3,
		armThickness: 0.35, thighThickness: 0.35, calfThickness: 0.35, headSize: 0.5,
		genitalSize: 0.45, openingSize: 0.45, anusSize: 0.45,
	}),
	// Guías de edad: la cabeza es proporcionalmente mayor en el niño, el cuerpo
	// se alarga en la adolescencia y se encoge/engorda en la vejez.
	age_child: preset({
		age: 7, height: 0.18, width: 0.42, headSize: 0.85, bust: 0.45,
		waist: 0.48, hips: 0.45, glutes: 0.45, armLength: 0.35, legLength: 0.35,
		armThickness: 0.4, thighThickness: 0.4, calfThickness: 0.4,
	}),
	age_teen: preset({
		age: 16, height: 0.52, width: 0.48, headSize: 0.62, bust: 0.58,
		waist: 0.42, hips: 0.55, glutes: 0.5, armLength: 0.48, legLength: 0.52,
	}),
	age_adult: preset({
		age: 30, height: 0.62, headSize: 0.45, bust: 0.7, waist: 0.4,
		hips: 0.55, glutes: 0.55, armLength: 0.55, legLength: 0.6,
	}),
	age_elder: preset({
		age: 82, height: 0.42, width: 0.56, headSize: 0.5, bust: 0.42,
		firmness: 0.25, waist: 0.62, stomach: 0.7, hips: 0.6, glutes: 0.45,
		armLength: 0.45, legLength: 0.4, armThickness: 0.4,
		thighThickness: 0.4, calfThickness: 0.4,
	}),
	// Guías de peso: el volumen se reparte entre vientre, cintura, caderas,
	// glúteos y muslos; los senos y los hombros crecen menos que el resto.
	weight_slim: preset({
		weight: 0.2, waist: 0.3, stomach: 0.35, hips: 0.35, glutes: 0.35,
		thighThickness: 0.35, calfThickness: 0.35, bust: 0.45,
	}),
	weight_chubby: preset({
		weight: 0.7, waist: 0.75, stomach: 0.85, hips: 0.78, glutes: 0.72,
		thighThickness: 0.75, calfThickness: 0.65, armThickness: 0.7, bust: 0.7,
	}),
	weight_mega: preset({
		weight: 1, waist: 1.2, stomach: 1.5, hips: 1.3, glutes: 1.15,
		thighThickness: 1.2, calfThickness: 1, armThickness: 1.1, bust: 0.85,
	}),
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
	// Edad en años y peso 0..1 alimentan los morfs nativos de MakeHuman:
	// baby/child/young/old y minweight/averageweight/maxweight.
	if (anatomy.age !== undefined) {
		a.age = Math.min(90, Math.max(1, Number(anatomy.age) || 25));
	}
	if (anatomy.weight !== undefined) a.weight = clamp01(anatomy.weight);
	// El morph nativo "old" estira al anciano; las guías lo muestran más bajo
	// y encorvado, así que se compensa bajando el morph de altura (incluso si
	// el slider de altura no se ha tocado nunca).
	const elder = Math.min(1, Math.max(0, ((a.age ?? 30) - 50) / 40));
	a.height = clamp01(anatomy.height ?? a.height ?? 0.5) * (1 - elder * 0.55);
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
		weight: clamp01(anatomy.weight ?? 0.5),
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
